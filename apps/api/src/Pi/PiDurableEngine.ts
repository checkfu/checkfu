import { boundToolEvents } from "@checkfu/domain/Session/ToolEventBounds"
import type { McpToolOf } from "@checkfu/domain/Session/ToolEventBounds"
import type { ModelUsage, ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import {
	AssistantEntry,
	CompactionEntry,
	ROOT_CONVERSATION_ID,
	ResetEntry,
	ToolResultEntry,
	UserEntry,
} from "@earendil-works/pi-durable"
import type {
	AgentChange,
	ContextEdit,
	Conversation,
	Cursor,
	EntryId,
	EntryRecord,
	Harness,
	TaskId,
} from "@earendil-works/pi-durable"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { checkCatalogProviderCredentials } from "./PiCatalog.ts"
import { mapAssistantMessageToOutcome, mapUnansweredToError } from "./PiRefusals.ts"
import { rejectionIn } from "./PiRejection.ts"
import { beginTurnUsage, settleTurnUsage } from "./PiTurnUsage.ts"

import { turnOfOperation } from "./PiTurn.ts"
import type { PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"

export interface PiDurableBackend {
	readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	readonly hasApiKey: (provider: string) => boolean
	readonly missingCredentialsMessage?: (provider: string) => string
	readonly isCancelled: (operationId: string) => boolean
	readonly enterWorkspace: (turn: number) => Promise<boolean>
	readonly pi: () => Promise<Harness>
	readonly ensureRoot: (agent: AgentChange) => Promise<void>
	readonly submit: (text: string, operationId: string) => Promise<void>
	readonly wait: (
		operationId: string,
		signal?: AbortSignal,
	) => Promise<
		{ readonly status: "done" } | { readonly status: "unanswered"; readonly reason?: string }
	>
	readonly abort: (operationId: string) => Effect.Effect<boolean>
	readonly reset: Effect.Effect<never>
	readonly publishMcp?: (request: PiTurnRequest) => Promise<boolean>
	readonly discoverMcp?: (request: PiTurnRequest, signal: AbortSignal) => Promise<void>
	readonly untilCancelled?: <A>(
		operationId: string,
		work: (cancelled: AbortSignal) => Promise<A>,
	) => Promise<A>
	readonly mcpToolOf?: McpToolOf
}

const submissionOf = (pi: Harness, operationId: string) =>
	pi.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, operationId), BACKGROUND_CONTEXT)

const readAssistantMessage = async (
	pi: Harness,
	operationId: string,
): Promise<AssistantMessage | null> => {
	const record = await submissionOf(pi, operationId)
	if (record?.type !== "input" || record.status !== "done") {
		return null
	}
	const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
	if (conversation === undefined) {
		return null
	}
	const page = await conversation.entries(
		{ minEntryId: record.answer, maxEntryId: record.answer },
		1,
		undefined,
		BACKGROUND_CONTEXT,
	)
	const entry = page.items[0]
	const firstMessage = entry?.model?.[0]
	return firstMessage?.role === "assistant" ? firstMessage : null
}

const TURN_ENTRY_PAGE_SIZE = 8

const handedOff = (entry: EntryRecord, runTasks: ReadonlySet<TaskId>): boolean =>
	ResetEntry.is(entry) &&
	(entry.model?.length ?? 0) > 0 &&
	entry.byTaskId !== undefined &&
	runTasks.has(entry.byTaskId)

async function* turnEntries(
	conversation: Conversation,
	userEntryId: EntryId,
	upTo?: EntryId,
): AsyncGenerator<EntryRecord> {
	const runTasks = new Set<TaskId>()
	let cursor: Cursor | undefined
	do {
		const page = await conversation.entries(
			{
				minEntryId: userEntryId,
				...(upTo === undefined ? {} : { maxEntryId: upTo }),
				order: "ascending",
			},
			TURN_ENTRY_PAGE_SIZE,
			cursor,
			BACKGROUND_CONTEXT,
		)
		for (const entry of page.items) {
			if (entry.id <= userEntryId) {
				continue
			}
			if (UserEntry.is(entry) || (ResetEntry.is(entry) && !handedOff(entry, runTasks))) {
				return
			}
			if (AssistantEntry.is(entry) && entry.byTaskId !== undefined) {
				runTasks.add(entry.byTaskId)
			}
			yield entry
		}
		cursor = page.next
	} while (cursor !== undefined)
}

interface TurnEntries {
	readonly ids: ReadonlyArray<EntryId>
	readonly compaction: EntryRecord | undefined
}

export const readTurnEntries = async (
	conversation: Conversation,
	userEntryId: EntryId,
): Promise<TurnEntries> => {
	const ids: Array<EntryId> = [userEntryId]
	let compaction: EntryRecord | undefined
	for await (const entry of turnEntries(conversation, userEntryId)) {
		if (CompactionEntry.is(entry)) {
			compaction = entry
		} else if (AssistantEntry.is(entry) || ToolResultEntry.is(entry)) {
			ids.push(entry.id)
		}
	}
	return { ids, compaction }
}

const cutBeforeStored = (entry: EntryRecord): boolean =>
	ToolResultEntry.is(entry) &&
	entry.data.diagnostics.some((diagnostic) => diagnostic.code === "truncated")

export const readTurnToolEvents = async (
	pi: Harness,
	operationId: string,
	turn: number,
	mcpToolOf?: McpToolOf,
): Promise<Array<ToolEvent>> => {
	const record = await submissionOf(pi, operationId)
	if (record?.type !== "input" || record.entry === undefined) {
		return []
	}
	const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
	if (conversation === undefined) {
		return []
	}
	const head = (await conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id
	if (head === undefined) {
		return []
	}
	const bounds = boundToolEvents(turn, mcpToolOf)
	const askedBy = new Map<string, TaskId | undefined>()
	const visit = (entry: EntryRecord) => {
		for (const message of entry.model ?? []) {
			if (message.role === "assistant") {
				if (message.stopReason !== "toolUse") {
					continue
				}
				bounds.round()
				for (const block of message.content) {
					if (block.type === "toolCall") {
						askedBy.set(block.id, entry.byTaskId)
						bounds.use({ id: block.id, name: block.name, input: block.arguments })
					}
				}
			} else if (
				message.role === "toolResult" &&
				entry.byTaskId !== undefined &&
				entry.byTaskId !== askedBy.get(message.toolCallId)
			) {
				const rejected = rejectionIn(message.details)
				bounds.result({
					id: message.toolCallId,
					task_id: entry.byTaskId,
					content: message.content.map((block) => ({
						type: "text",
						text: block.type === "text" ? block.text : `[${block.mimeType} image]`,
					})),
					is_error: message.isError,
					...(cutBeforeStored(entry) || message.content.some((block) => block.type !== "text")
						? { truncated: true as const }
						: {}),
					...(rejected === undefined ? {} : { rejected }),
				})
			}
		}
	}
	for await (const entry of turnEntries(conversation, record.entry, head)) {
		if (AssistantEntry.is(entry) || ToolResultEntry.is(entry)) {
			visit(entry)
			if (bounds.complete()) {
				break
			}
		}
	}
	return bounds.events()
}

export const RestoredHistoryLimit = Context.Reference<number>("@checkfu/api/RestoredHistoryLimit", {
	defaultValue: () => 1024 * 1024,
})

const EARLIER_HISTORY_GONE = "[Earlier messages of this conversation are no longer available.]"

const byteLength = (message: Message): number =>
	new TextEncoder().encode(JSON.stringify(message)).byteLength

const newestTurnsWithin = (
	messages: ReadonlyArray<Message>,
	limit: number,
): ReadonlyArray<Message> => {
	const sizes = messages.map(byteLength)
	if (sizes.reduce((total, size) => total + size, 0) <= limit) {
		return messages
	}
	let start = messages.length
	let kept = 0
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		kept += sizes[index] ?? 0
		if (kept > limit) {
			break
		}
		if (messages[index]?.role === "user") {
			start = index
		}
	}
	return [
		{ role: "user", content: EARLIER_HISTORY_GONE, timestamp: messages[start]?.timestamp ?? 0 },
		...messages.slice(start),
	]
}

const publishedBefore = async (
	conversation: Conversation,
	userEntryId: EntryId,
	compaction: EntryRecord,
	limit: number,
): Promise<ReadonlyArray<Message>> => {
	const page = await conversation.entries(
		{ maxEntryId: userEntryId },
		2,
		undefined,
		BACKGROUND_CONTEXT,
	)
	const last = page.items.find((entry) => entry.id < userEntryId)
	if (last === undefined) {
		return []
	}
	const view = await conversation.context(BACKGROUND_CONTEXT, { at: last.id })
	const cut = compaction.head
	const messages = view.entries.flatMap((entry, index) =>
		entry.head !== undefined || cut === undefined || entry.id < cut
			? (view.contributions[index] ?? []).filter((message) => message.role !== "system")
			: [],
	)
	return newestTurnsWithin(messages, limit)
}

const omitTurnEntries = async (
	pi: Harness,
	operationId: string,
	restoredLimit: number,
): Promise<void> => {
	const record = await submissionOf(pi, operationId)
	if (record?.type !== "input" || record.entry === undefined) {
		return
	}
	if (record.status !== "unanswered" && record.status !== "done") {
		return
	}
	const requestId = `omit:${operationId}`
	const omitted = await pi.commit(
		(tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId),
		BACKGROUND_CONTEXT,
	)
	if (omitted !== undefined) {
		await (await pi.submission(omitted.id, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT)
		return
	}
	const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
	if (conversation === undefined) {
		return
	}
	const { ids, compaction } = await readTurnEntries(conversation, record.entry)
	const edits: Array<ContextEdit> = [
		...ids.map((target) => ({ target, action: "omit" as const })),
		...(compaction === undefined
			? []
			: [
					{
						target: compaction.id,
						action: "replace" as const,
						messages: await publishedBefore(conversation, record.entry, compaction, restoredLimit),
					},
				]),
	]
	const submission = await conversation.submit(
		{
			type: "write",
			requestId,
			entry: { kind: "checkfu.omit_unanswered", edits },
		},
		BACKGROUND_CONTEXT,
	)
	await submission.wait(BACKGROUND_CONTEXT)
}

const ZERO_MODEL_USAGE: ModelUsage = { input_tokens: 0, output_tokens: 0 }

const finalizeSettledTurn = async (
	pi: Harness,
	operationId: string,
	restoredLimit: number,
): Promise<void> => {
	const record = await submissionOf(pi, operationId)
	if (record?.type !== "input") {
		return
	}
	if (record.status === "unanswered") {
		await omitTurnEntries(pi, operationId, restoredLimit)
		return
	}
	if (record.status === "done") {
		const answer = await readAssistantMessage(pi, operationId)
		if (answer === null || !mapAssistantMessageToOutcome(answer, ZERO_MODEL_USAGE).ok) {
			await omitTurnEntries(pi, operationId, restoredLimit)
		}
	}
}

export const AbortGrace = Context.Reference<Duration.Input>("@checkfu/api/AbortGrace", {
	defaultValue: () => "10 seconds",
})

export const abortPiDurableTurn = (
	backend: PiDurableBackend,
	operationId: string,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const grace = yield* AbortGrace
		const watched = yield* Effect.forkDetach(
			Effect.gen(function* () {
				const aborting = yield* Effect.forkDetach(backend.abort(operationId))
				return yield* Fiber.join(aborting).pipe(
					Effect.timeoutOrElse({ duration: grace, orElse: () => backend.reset }),
				)
			}),
		)
		return yield* Fiber.join(watched)
	})

const admitting = new WeakMap<PiDurableBackend, Map<string, Set<Deferred.Deferred<void>>>>()

const admissionsOf = (backend: PiDurableBackend) => {
	const existing = admitting.get(backend)
	if (existing !== undefined) {
		return existing
	}
	const created = new Map<string, Set<Deferred.Deferred<void>>>()
	admitting.set(backend, created)
	return created
}

const admitPiTurn = (
	backend: PiDurableBackend,
	request: PiTurnRequest,
): Effect.Effect<boolean | "missing_key"> =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const done = Deferred.makeUnsafe<void>()
			const admissions = admissionsOf(backend)
			const active = admissions.get(request.operationId) ?? new Set()
			active.add(done)
			admissions.set(request.operationId, active)
			return done
		}),
		() => admitPiTurnUnderWay(backend, request),
		(done) =>
			Effect.andThen(
				Effect.sync(() => {
					const admissions = admissionsOf(backend)
					const active = admissions.get(request.operationId)
					active?.delete(done)
					if (active?.size === 0) {
						admissions.delete(request.operationId)
					}
				}),
				Deferred.succeed(done, undefined),
			),
	)

const admitPiTurnUnderWay = (
	backend: PiDurableBackend,
	request: PiTurnRequest,
): Effect.Effect<boolean | "missing_key"> => {
	const operationId = request.operationId
	const agent: AgentChange = {
		model: { provider: request.provider, modelId: request.modelId },
		instructions: request.system !== null && request.system.length > 0 ? request.system : null,
	}
	return Effect.gen(function* () {
		const restoredLimit = yield* RestoredHistoryLimit
		let finalizedPrevious: string | undefined
		let discovered = false
		while (true) {
			const admitted = yield* backend.withLock(
				Effect.promise(async () => {
					const pi = await backend.pi()
					if ((await submissionOf(pi, operationId)) !== undefined) {
						return true
					}
					if (backend.isCancelled(operationId)) {
						return false
					}
					if (!backend.hasApiKey(request.provider)) {
						return "missing_key"
					}
					await backend.ensureRoot(agent)
					if (backend.isCancelled(operationId)) {
						return false
					}
					while (true) {
						const turnState = await beginTurnUsage(pi, operationId, request.turn, finalizedPrevious)
						if (turnState.status === "stale") {
							return false
						}
						if (turnState.status === "waiting") {
							return { waitingFor: turnState.operationId }
						}
						if (turnState.status === "finalize") {
							await finalizeSettledTurn(pi, turnState.operationId, restoredLimit)
							finalizedPrevious = turnState.operationId
							continue
						}
						break
					}
					if (!(await backend.enterWorkspace(request.turn))) {
						await settleTurnUsage(pi, operationId)
						return false
					}
					if ((await backend.publishMcp?.(request)) === true && !discovered) {
						return "discover" as const
					}
					for (const unpublished of request.unpublishedOperationIds ?? []) {
						await omitTurnEntries(pi, unpublished, restoredLimit)
					}
					if (backend.isCancelled(operationId)) {
						return false
					}
					await backend.submit(request.text, operationId)
					return true
				}),
			)
			if (admitted === "discover") {
				const discover = backend.discoverMcp
				const untilCancelled = backend.untilCancelled
				if (discover !== undefined) {
					yield* Effect.promise((interrupted) =>
						untilCancelled === undefined
							? discover(request, interrupted)
							: untilCancelled(operationId, (cancelled) =>
									discover(request, AbortSignal.any([interrupted, cancelled])),
								),
					)
				}
				discovered = true
				continue
			}
			if (typeof admitted !== "object") {
				return admitted
			}
			yield* abortPiDurableTurn(backend, admitted.waitingFor)
			yield* Effect.promise((signal) => backend.wait(admitted.waitingFor, signal))
		}
	})
}

const resolveSettledPiTurn = (
	backend: PiDurableBackend,
	operationId: string,
	settled:
		| { readonly status: "done" }
		| { readonly status: "unanswered"; readonly reason?: string },
	providerForLog: string,
): Effect.Effect<PiTurnOutcome> =>
	Effect.uninterruptible(
		Effect.gen(function* () {
			const pi = yield* Effect.promise(() => backend.pi())
			const turn = turnOfOperation(operationId)
			const tool_events =
				turn === undefined
					? []
					: yield* Effect.promise(() =>
							readTurnToolEvents(pi, operationId, turn, backend.mcpToolOf),
						)
			const outcome = yield* settledOutcome(pi, operationId, settled, providerForLog)
			return tool_events.length === 0 ? outcome : { ...outcome, tool_events }
		}),
	)

const settledOutcome = (
	pi: Harness,
	operationId: string,
	settled:
		| { readonly status: "done" }
		| { readonly status: "unanswered"; readonly reason?: string },
	providerForLog: string,
): Effect.Effect<PiTurnOutcome> =>
	Effect.gen(function* () {
		const restoredLimit = yield* RestoredHistoryLimit
		if (settled.status === "unanswered") {
			if (settled.reason === "aborted") {
				yield* Effect.promise(() => omitTurnEntries(pi, operationId, restoredLimit))
				const usage = yield* Effect.promise(() => settleTurnUsage(pi, operationId))
				return { ok: false, error: { _tag: "TurnInterrupted", model_usage: usage } }
			}
			yield* Effect.promise(() => omitTurnEntries(pi, operationId, restoredLimit))
			const usage = yield* Effect.promise(() => settleTurnUsage(pi, operationId))
			yield* Effect.logWarning("pi turn unanswered").pipe(
				Effect.annotateLogs({
					operationId,
					provider: providerForLog,
					reason: settled.reason ?? "unknown",
				}),
			)
			return {
				ok: false,
				error: { ...mapUnansweredToError(settled.reason), model_usage: usage },
			}
		}

		const assistantMessage = yield* Effect.promise(() => readAssistantMessage(pi, operationId))
		if (assistantMessage === null) {
			yield* Effect.promise(() => omitTurnEntries(pi, operationId, restoredLimit))
			const usage = yield* Effect.promise(() => settleTurnUsage(pi, operationId))
			return {
				ok: false,
				error: {
					_tag: "TurnFailed",
					error_type: "empty_model_reply",
					message: "Pi durable completed without an assistant entry.",
					model_usage: usage,
					terminal: false,
				},
			}
		}
		if (!mapAssistantMessageToOutcome(assistantMessage, ZERO_MODEL_USAGE).ok) {
			yield* Effect.promise(() => omitTurnEntries(pi, operationId, restoredLimit))
		}
		const usage = yield* Effect.promise(() => settleTurnUsage(pi, operationId))
		return mapAssistantMessageToOutcome(assistantMessage, usage)
	})

export const recoverPiDurableTurn = Effect.fn("PiDurableEngine.recoverTurn")(function* (
	backend: PiDurableBackend,
	operationId: string,
): Effect.fn.Return<PiTurnOutcome | null> {
	let underWay = admissionsOf(backend).get(operationId)
	while (underWay !== undefined && underWay.size > 0) {
		yield* Effect.forEach([...underWay], Deferred.await, { discard: true })
		underWay = admissionsOf(backend).get(operationId)
	}
	const probe = yield* backend.withLock(
		Effect.promise(async () => {
			if ((await submissionOf(await backend.pi(), operationId)) !== undefined) {
				return "submitted" as const
			}
			return backend.isCancelled(operationId) ? ("cancelled" as const) : ("absent" as const)
		}),
	)
	if (probe === "absent") {
		return null
	}
	if (probe === "cancelled") {
		return { ok: false, error: { _tag: "TurnInterrupted" } }
	}
	const settled = yield* Effect.promise((signal) => backend.wait(operationId, signal))
	return yield* resolveSettledPiTurn(backend, operationId, settled, "unknown")
})

export const runPiDurableTurn = Effect.fn("PiDurableEngine.runTurn")(function* (
	backend: PiDurableBackend,
	request: PiTurnRequest,
): Effect.fn.Return<PiTurnOutcome> {
	const operationId = request.operationId
	const admitted = yield* admitPiTurn(backend, request)
	if (admitted === "missing_key") {
		const fallbackCheck = checkCatalogProviderCredentials(request.provider, { env: {} })
		const message =
			backend.missingCredentialsMessage?.(request.provider) ??
			(fallbackCheck.ok
				? `Missing credentials for provider "${request.provider}".`
				: fallbackCheck.message)
		return {
			ok: false,
			error: {
				_tag: "TurnFailed",
				error_type: "missing_api_key_error",
				message,
				terminal: false,
			},
		}
	}
	if (!admitted) {
		return { ok: false, error: { _tag: "TurnInterrupted" } }
	}

	const settled = yield* Effect.promise((signal) => backend.wait(operationId, signal))
	return yield* resolveSettledPiTurn(backend, operationId, settled, request.provider)
})
