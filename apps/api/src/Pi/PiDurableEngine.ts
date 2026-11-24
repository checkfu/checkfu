import { boundToolCalls } from "@checkfu/domain/Session/RecordToolCalls"
import type { ModelUsage, ToolCall, ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import {
	AssistantEntry,
	ROOT_CONVERSATION_ID,
	ResetEntry,
	ToolResultEntry,
	UserEntry,
} from "@earendil-works/pi-durable"
import type { AgentChange, Cursor, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { PROVIDER_API_KEY_ENV } from "./PiCatalog.ts"
import type { SupportedProvider } from "./PiCatalog.ts"
import { mapAssistantMessageToOutcome, mapUnansweredToError } from "./PiRefusals.ts"
import { beginTurnUsage, settleTurnUsage } from "./PiTurnUsage.ts"

import type { PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"

/** What differs between the session object and a test double; the engine does the rest on Pi. */
export interface PiDurableBackend {
	readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	readonly hasApiKey: (provider: SupportedProvider) => boolean
	readonly isCancelled: (operationId: string) => boolean
	/** Gives the session's workspace to this turn; false when a later turn already has it. */
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
	/** How the session object names calls Pi's transcript does not: MCP and script calls. */
	readonly servedToolCalls?: () => ServedToolCalls
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

// A turn's entries: its user entry and everything after it up to the next turn, the tool rounds
// of a turn that used tools included.
const readTurnEntries = async (pi: Harness, userEntryId: EntryId): Promise<Array<EntryId>> => {
	const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
	if (conversation === undefined) {
		return []
	}
	const ids: Array<EntryId> = [userEntryId]
	let cursor: Cursor | undefined
	do {
		const page = await conversation.entries(
			{ minEntryId: userEntryId, order: "ascending" },
			TURN_ENTRY_PAGE_SIZE,
			cursor,
			BACKGROUND_CONTEXT,
		)
		for (const entry of page.items) {
			if (entry.id <= userEntryId) {
				continue
			}
			if (UserEntry.is(entry) || ResetEntry.is(entry)) {
				return ids
			}
			if (AssistantEntry.is(entry) || ToolResultEntry.is(entry)) {
				ids.push(entry.id)
			}
		}
		cursor = page.next
	} while (cursor !== undefined)
	return ids
}

/** Calls a turn made that Pi's transcript does not name as such. */
export interface ServedToolCalls {
	/** The event as the session log names it: a call to an MCP tool becomes an MCP call. */
	readonly named: (event: ToolEvent) => ToolEvent
	/** The calls a script made, in order, read only as far as they are wanted. */
	readonly nested: (scriptCallId: string) => Iterable<ToolEvent>
}

/**
 * The tool calls of a settled turn, bounded as the session log records them while the
 * transcript is read in small pages, so a long turn never has to fit in memory or in one RPC.
 * Images in a result are named, not copied.
 */
export const readTurnToolCalls = async (
	pi: Harness,
	operationId: string,
	served?: ServedToolCalls,
): Promise<Array<ToolCall>> => {
	const record = await submissionOf(pi, operationId)
	if (record?.type !== "input" || record.entry === undefined) {
		return []
	}
	const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
	if (conversation === undefined) {
		return []
	}
	const bounds = boundToolCalls()
	const visit = (entry: EntryRecord) => {
		for (const message of entry.model ?? []) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") {
						const use: ToolEvent = {
							type: "tool_use",
							tool_use_id: block.id,
							name: block.name,
							input: block.arguments,
						}
						bounds.add(served?.named(use) ?? use)
						for (const nested of served?.nested(block.id) ?? []) {
							if (bounds.complete()) {
								break
							}
							bounds.add(nested)
						}
					}
				}
			} else if (message.role === "toolResult") {
				const result: ToolEvent = {
					type: "tool_result",
					tool_use_id: message.toolCallId,
					content: message.content.map((block) => ({
						type: "text",
						text: block.type === "text" ? block.text : `[${block.mimeType} image]`,
					})),
					is_error: message.isError,
				}
				bounds.add(served?.named(result) ?? result)
			}
		}
	}
	let cursor: Cursor | undefined
	do {
		const page = await conversation.entries(
			{ minEntryId: record.entry, order: "ascending" },
			TURN_ENTRY_PAGE_SIZE,
			cursor,
			BACKGROUND_CONTEXT,
		)
		for (const entry of page.items) {
			if (entry.id <= record.entry) {
				continue
			}
			if (UserEntry.is(entry) || ResetEntry.is(entry)) {
				return bounds.calls()
			}
			if (AssistantEntry.is(entry) || ToolResultEntry.is(entry)) {
				visit(entry)
				if (bounds.complete()) {
					return bounds.calls()
				}
			}
		}
		cursor = page.next
	} while (cursor !== undefined)
	return bounds.calls()
}

/**
 * Omits everything a non-committed turn placed in Pi's live model context: its user entry, every
 * tool round and any answer, so the model does not see a turn the session records as interrupted
 * or failed, whether the interrupt or failure landed before or after Pi placed the user entry.
 */
const omitTurnEntries = async (pi: Harness, operationId: string): Promise<void> => {
	const record = await submissionOf(pi, operationId)
	if (record?.type !== "input" || record.entry === undefined) {
		return
	}
	if (record.status !== "unanswered" && record.status !== "done") {
		return
	}
	const targets = await readTurnEntries(pi, record.entry)
	if (targets.length === 0) {
		return
	}
	const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
	if (conversation === undefined) {
		return
	}
	const submission = await conversation.submit(
		{
			type: "write",
			requestId: `omit:${operationId}`,
			entry: {
				kind: "checkfu.omit_unanswered",
				edits: targets.map((target) => ({ target, action: "omit" as const })),
			},
		},
		BACKGROUND_CONTEXT,
	)
	await submission.wait(BACKGROUND_CONTEXT)
}

const ZERO_MODEL_USAGE: ModelUsage = { input_tokens: 0, output_tokens: 0 }

/**
 * Finalizes a settled turn whose original waiter disconnected before running
 * post-settlement cleanup. Keeps committed replies (including refusals) in Pi
 * context and omits unanswered or non-committable turns before admitting a
 * successor turn.
 */
const finalizeSettledTurn = async (pi: Harness, operationId: string): Promise<void> => {
	const record = await submissionOf(pi, operationId)
	if (record?.type !== "input") {
		return
	}
	if (record.status === "unanswered") {
		await omitTurnEntries(pi, operationId)
		return
	}
	if (record.status === "done") {
		const answer = await readAssistantMessage(pi, operationId)
		if (answer === null || !mapAssistantMessageToOutcome(answer, ZERO_MODEL_USAGE).ok) {
			await omitTurnEntries(pi, operationId)
		}
	}
}

export const AbortGrace = Context.Reference<Duration.Input>("@checkfu/api/AbortGrace", {
	defaultValue: () => "10 seconds",
})

/**
 * Pi's abort returns once the conversation is idle, so work that ignores its
 * abort signal would hold it, and every later turn of the session, forever.
 * Past the grace the object is reset: its in-flight work dies with the isolate,
 * and Pi, which has the abort on record, settles the operation when it reopens.
 */
export const abortPiDurableTurn = (
	backend: PiDurableBackend,
	operationId: string,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const grace = yield* AbortGrace
		// The abort cannot be interrupted, so it runs detached and only the wait for it is
		// bounded. The bounded wait is detached too: a caller that stops waiting must not take
		// the reset with it, or a stuck abort would hold the session's lock for good.
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

// Admissions in progress in this session object, by operation; a retry can overlap the call it
// retries. Admission lets go of the lock while a predecessor drains, so a recovery probe for the
// same operation waits until none is left instead of reporting the operation absent in that gap.
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
		let finalizedPrevious: string | undefined
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
							await finalizeSettledTurn(pi, turnState.operationId)
							finalizedPrevious = turnState.operationId
							continue
						}
						break
					}
					// Inside admission, so recovery waits for it, and after the turn before has ended,
					// so this does not refuse a turn that is still running.
					if (!(await backend.enterWorkspace(request.turn))) {
						await settleTurnUsage(pi, operationId)
						return false
					}
					// A turn the session never published a reply for (abandoned, failed or interrupted)
					// must not reach the model, whatever Pi made of it.
					for (const unpublished of request.unpublishedOperationIds ?? []) {
						await omitTurnEntries(pi, unpublished)
					}
					if (backend.isCancelled(operationId)) {
						return false
					}
					await backend.submit(request.text, operationId)
					return true
				}),
			)
			if (typeof admitted !== "object") {
				return admitted
			}
			// The domain starts a turn only once it has ended the one before, so an
			// operation still running here is one the domain gave up on.
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
			if (settled.status === "unanswered") {
				if (settled.reason === "aborted") {
					yield* Effect.promise(() => omitTurnEntries(pi, operationId))
					const usage = yield* Effect.promise(() => settleTurnUsage(pi, operationId))
					return { ok: false, error: { _tag: "TurnInterrupted", model_usage: usage } }
				}
				yield* Effect.promise(() => omitTurnEntries(pi, operationId))
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
				yield* Effect.promise(() => omitTurnEntries(pi, operationId))
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
				yield* Effect.promise(() => omitTurnEntries(pi, operationId))
			}
			const usage = yield* Effect.promise(() => settleTurnUsage(pi, operationId))
			const outcome = mapAssistantMessageToOutcome(assistantMessage, usage)
			if (!outcome.ok) {
				return outcome
			}
			const tool_calls = yield* Effect.promise(() =>
				readTurnToolCalls(pi, operationId, backend.servedToolCalls?.()),
			)
			return tool_calls.length === 0 ? outcome : { ...outcome, tool_calls }
		}),
	)

/**
 * Recovers an already-admitted (in-flight or settled) operation from Pi without
 * creating a root conversation or submitting a new turn. Returns `null` when Pi
 * has never admitted `operationId` and it has not been cancelled.
 */
export const recoverPiDurableTurn = Effect.fn("PiDurableEngine.recoverTurn")(function* (
	backend: PiDurableBackend,
	operationId: string,
): Effect.fn.Return<PiTurnOutcome | null> {
	// Another admission may start while this one waits, so look again until none is left.
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
		return {
			ok: false,
			error: {
				_tag: "TurnFailed",
				error_type: "missing_api_key_error",
				message: `Missing ${PROVIDER_API_KEY_ENV[request.provider]} for provider "${request.provider}".`,
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
