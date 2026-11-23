import type { ModelUsage } from "@checkfu/sessions/Session/SessionTypes"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Api, AssistantMessage, Usage } from "@earendil-works/pi-ai"
import {
	AssistantEntry,
	ROOT_CONVERSATION_ID,
	ResetEntry,
	UserEntry,
} from "@earendil-works/pi-durable"
import type {
	AgentChange,
	ConversationId,
	ConversationInit,
	Cursor,
	EntryId,
	Harness,
	Storage,
	Tx,
} from "@earendil-works/pi-durable"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import type { SupportedProvider } from "./PiModels.ts"
import {
	classifyUnansweredCategory,
	isRefusalAssistantMessage,
	mapAssistantMessageToOutcome,
	mapUnansweredToError,
	normalizeRefusalAssistantMessage,
} from "./PiRefusals.ts"
import type { PiTurnOutcome, UnansweredSubmissionInfo } from "./PiRefusals.ts"
import { SeedState, clearSeedRebuild } from "./PiTurnUsage.ts"
import type { BeginTurnUsageResult } from "./PiTurnUsage.ts"

export interface PiTurnRequest {
	readonly operationId: string
	readonly turn: number
	readonly provider: SupportedProvider
	readonly modelId: string
	readonly system: string | null
	readonly text: string
	readonly seed?: PiSeed
}

export interface PiSeedMessage {
	readonly role: "user" | "assistant"
	readonly text: string
}

export interface PiSeed {
	readonly api: Api
	readonly messages: ReadonlyArray<PiSeedMessage>
	readonly trimmed?: boolean
}

export type PiTurnResult = PiTurnOutcome | "history_required"

export type PiSeedContext = Pick<PiTurnRequest, "operationId" | "provider" | "modelId">

export interface PiDurableBackend {
	readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	readonly isCancelled: (operationId: string) => boolean
	readonly beginUsage: (
		operationId: string,
		finalizedPrevious?: string,
		hasSeed?: boolean,
	) => Promise<BeginTurnUsageResult>
	readonly settleUsage: (operationId: string) => Promise<ModelUsage>
	readonly hasSubmission: (operationId: string) => Promise<boolean>
	readonly ensureRoot: (agent: AgentChange, create: ConversationInit | boolean) => Promise<boolean>
	readonly rebuildRoot: (agent: AgentChange, request: PiSeedContext, seed: PiSeed) => Promise<void>
	readonly markSeedCommitted: () => Promise<void>
	readonly submit: (text: string, operationId: string) => Promise<void>
	readonly wait: (
		operationId: string,
		signal?: AbortSignal,
	) => Promise<
		{ readonly status: "done" } | { readonly status: "unanswered"; readonly reason?: string }
	>
	readonly abort: (operationId: string) => Effect.Effect<boolean>
	readonly readAnswerEntry: (operationId: string) => Promise<AssistantMessage | null>
	readonly readUnansweredSubmission: (
		operationId: string,
	) => Promise<UnansweredSubmissionInfo | null>
	readonly restoreRefusal: (
		operationId: string,
		entryId: EntryId,
		message: AssistantMessage,
	) => Promise<void>
	readonly omitEntries: (operationId: string) => Promise<void>
	readonly finalizePrevious: (operationId: string) => Promise<void>
}

export const readAssistantMessageFromStorage = async (
	pi: Harness,
	storage: Storage,
	operationId: string,
): Promise<AssistantMessage | null> => {
	const record = await storage.submissionByRequest(
		ROOT_CONVERSATION_ID,
		operationId,
		BACKGROUND_CONTEXT,
	)
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

const formatSubmissionDetail = (detail: unknown): string | undefined => {
	if (typeof detail === "string" && detail.length > 0) {
		return detail
	}
	if (detail === undefined || detail === null) {
		return undefined
	}
	if (typeof detail === "object" && "message" in detail && typeof detail.message === "string") {
		return detail.message
	}
	return JSON.stringify(detail)
}

const FAILED_TURN_ENTRY_PAGE_SIZE = 32

const readAssistantEntryForUnansweredSubmission = async (
	pi: Harness,
	userEntryId: EntryId,
): Promise<{ readonly entryId: EntryId; readonly message: AssistantMessage } | undefined> => {
	const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
	if (conversation === undefined) {
		return undefined
	}
	// Scan forward from `userEntryId` and stop at the next turn boundary so
	// delayed reads in long sessions never scan or retain later turns.
	let cursor: Cursor | undefined
	let lastAssistant: { readonly entryId: EntryId; readonly message: AssistantMessage } | undefined
	do {
		const page = await conversation.entries(
			{ minEntryId: userEntryId, order: "ascending" },
			FAILED_TURN_ENTRY_PAGE_SIZE,
			cursor,
			BACKGROUND_CONTEXT,
		)
		for (const entry of page.items) {
			if (entry.id <= userEntryId) {
				continue
			}
			if (UserEntry.is(entry) || ResetEntry.is(entry)) {
				return lastAssistant
			}
			if (AssistantEntry.is(entry)) {
				const first = entry.model?.[0]
				if (first?.role === "assistant") {
					lastAssistant = { entryId: entry.id, message: first }
				}
			}
		}
		cursor = page.next
	} while (cursor !== undefined)
	return lastAssistant
}

/**
 * Reads the immutable `reason`, `detail`, and (when `model_error` persisted a
 * terminal `AssistantEntry`) the specific turn's `AssistantMessage` from storage.
 */
export const readUnansweredSubmissionFromStorage = async (
	pi: Harness,
	storage: Storage,
	operationId: string,
): Promise<UnansweredSubmissionInfo | null> => {
	const record = await storage.submissionByRequest(
		ROOT_CONVERSATION_ID,
		operationId,
		BACKGROUND_CONTEXT,
	)
	if (record?.status !== "unanswered") {
		return null
	}
	const detail = formatSubmissionDetail(record.detail)
	const assistant =
		record.type === "input" && record.reason === "model_error" && record.entry !== undefined
			? await readAssistantEntryForUnansweredSubmission(pi, record.entry)
			: undefined
	return {
		reason: record.reason,
		...(detail === undefined ? {} : { detail }),
		...(assistant === undefined
			? {}
			: { assistantMessage: assistant.message, assistantEntryId: assistant.entryId }),
	}
}

/**
 * Replaces an error-stopped refusal `AssistantEntry` in Pi's live context with
 * a `stopReason: "stop"` entry carrying the published refusal text. Because Pi
 * excludes `stopReason: "error"` entries from model context, this keeps retained
 * Pi roots consistent with history rebuilt from Checkfu's session log.
 */
export const restoreRefusalEntryInStorage = async (
	pi: Harness,
	operationId: string,
	entryId: EntryId,
	message: AssistantMessage,
): Promise<void> => {
	const hasText = message.content.some((block) => block.type === "text" && block.text.length > 0)
	if (message.stopReason === "stop" && hasText) {
		return
	}
	const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
	if (conversation === undefined) {
		return
	}
	const normalized = normalizeRefusalAssistantMessage(message)
	const submission = await conversation.submit(
		{
			type: "write",
			requestId: `restore-refusal:${operationId}`,
			entry: {
				kind: "checkfu.restore_refusal",
				edits: [{ target: entryId, action: "replace", messages: [normalized] }],
			},
		},
		BACKGROUND_CONTEXT,
	)
	await submission.wait(BACKGROUND_CONTEXT)
}

/**
 * Omits a non-committed turn's placed user (and, if present, answer) entries
 * from Pi's live model context so interrupted and failed turns match history
 * rebuilt from Checkfu's session log regardless of whether the interrupt or
 * failure landed before or after Pi placed the user entry.
 */
export const omitTurnEntriesFromStorage = async (
	pi: Harness,
	storage: Storage,
	operationId: string,
): Promise<void> => {
	const record = await storage.submissionByRequest(
		ROOT_CONVERSATION_ID,
		operationId,
		BACKGROUND_CONTEXT,
	)
	if (record?.type !== "input") {
		return
	}
	const targets: Array<EntryId> = []
	if (record.status === "unanswered") {
		if (record.entry !== undefined) {
			targets.push(record.entry)
		}
	} else if (record.status === "done") {
		targets.push(record.entry, record.answer)
	}
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
export const finalizeSettledTurnFromStorage = async (
	pi: Harness,
	storage: Storage,
	operationId: string,
): Promise<void> => {
	const record = await storage.submissionByRequest(
		ROOT_CONVERSATION_ID,
		operationId,
		BACKGROUND_CONTEXT,
	)
	if (record?.type !== "input") {
		return
	}
	if (record.status === "unanswered") {
		const info = await readUnansweredSubmissionFromStorage(pi, storage, operationId)
		if (
			info?.assistantMessage !== undefined &&
			info.assistantMessage.stopReason !== "aborted" &&
			isRefusalAssistantMessage(info.assistantMessage)
		) {
			if (info.assistantEntryId !== undefined) {
				await restoreRefusalEntryInStorage(
					pi,
					operationId,
					info.assistantEntryId,
					info.assistantMessage,
				)
			}
			await clearSeedRebuild(pi)
			return
		}
		await omitTurnEntriesFromStorage(pi, storage, operationId)
		return
	}
	if (record.status === "done") {
		const answer = await readAssistantMessageFromStorage(pi, storage, operationId)
		if (answer === null || !mapAssistantMessageToOutcome(answer, ZERO_MODEL_USAGE).ok) {
			await omitTurnEntriesFromStorage(pi, storage, operationId)
		} else {
			await clearSeedRebuild(pi)
		}
	}
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const appendSeedToTx = async (
	tx: Tx,
	conversationId: ConversationId,
	request: PiSeedContext,
	seed: PiSeed,
): Promise<void> => {
	for (const message of seed.messages) {
		if (message.role === "user") {
			await tx.appendEntry(UserEntry, conversationId, {
				model: [{ role: "user", content: message.text, timestamp: 0 }],
			})
		} else {
			await tx.appendEntry(AssistantEntry, conversationId, {
				model: [
					{
						role: "assistant",
						content: [{ type: "text", text: message.text }],
						api: seed.api,
						provider: request.provider,
						model: request.modelId,
						usage: ZERO_USAGE,
						stopReason: "stop",
						timestamp: 0,
					},
				],
			})
		}
	}
	const seedState = await tx.doc(SeedState)
	seedState.rebuildRequired = seed.trimmed === true
	seedState.seededByOperation = seed.trimmed === true ? request.operationId : null
}

/**
 * Resets an existing Pi root whose earlier recovery seed was trimmed and did
 * not commit a reply, replacing its active context with a fresh seed.
 */
export const rebuildRootInStorage = async (
	pi: Harness,
	agent: AgentChange,
	request: PiSeedContext,
	seed: PiSeed,
): Promise<void> => {
	const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
	if (conversation === undefined) {
		return
	}
	await conversation.configure(agent, BACKGROUND_CONTEXT)
	await pi.commit(async (tx) => {
		await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: ResetEntry.kind, head: "self" })
		await appendSeedToTx(tx, ROOT_CONVERSATION_ID, request, seed)
	}, BACKGROUND_CONTEXT)
}

const seedInit = (request: PiTurnRequest): ConversationInit | undefined => {
	const seed = request.seed
	if (seed === undefined || (seed.messages.length === 0 && seed.trimmed !== true)) {
		return undefined
	}
	return (tx, conversationId) => appendSeedToTx(tx, conversationId, request, seed)
}

const inFlightAdmissions = new WeakMap<PiDurableBackend, Map<string, Set<Latch.Latch>>>()

const admitPiTurn = (
	backend: PiDurableBackend,
	request: PiTurnRequest,
): Effect.Effect<boolean | "history_required"> => {
	const operationId = request.operationId
	const agent: AgentChange = {
		model: { provider: request.provider, modelId: request.modelId },
		instructions: request.system !== null && request.system.length > 0 ? request.system : null,
	}
	return Effect.acquireUseRelease(
		Effect.sync(() => {
			const barrier = Latch.makeUnsafe(false)
			let byOperation = inFlightAdmissions.get(backend)
			if (byOperation === undefined) {
				byOperation = new Map()
				inFlightAdmissions.set(backend, byOperation)
			}
			let active = byOperation.get(operationId)
			if (active === undefined) {
				active = new Set()
				byOperation.set(operationId, active)
			}
			active.add(barrier)
			return { byOperation, active, barrier }
		}),
		() =>
			Effect.gen(function* () {
				let finalizedPrevious: string | undefined
				while (true) {
					const admitted = yield* backend.withLock(
						Effect.promise(async () => {
							if (await backend.hasSubmission(operationId)) {
								return true
							}
							if (backend.isCancelled(operationId)) {
								return false
							}
							const rooted = await backend.ensureRoot(
								agent,
								seedInit(request) ?? (request.turn === 1 || request.seed !== undefined),
							)
							if (!rooted) {
								return "history_required" as const
							}
							if (backend.isCancelled(operationId)) {
								return false
							}
							while (true) {
								const turnState = await backend.beginUsage(
									operationId,
									finalizedPrevious,
									request.seed !== undefined,
								)
								if (turnState.status === "waiting") {
									return { waitingFor: turnState.operationId }
								}
								if (turnState.status === "finalize") {
									await backend.finalizePrevious(turnState.operationId)
									finalizedPrevious = turnState.operationId
									continue
								}
								if (turnState.status === "history_required") {
									return "history_required" as const
								}
								if (turnState.status === "rebuild") {
									if (request.seed === undefined) {
										return "history_required" as const
									}
									await backend.rebuildRoot(agent, request, request.seed)
									continue
								}
								break
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
					yield* Effect.promise((signal) => backend.wait(admitted.waitingFor, signal))
				}
			}),
		({ byOperation, active, barrier }) =>
			Effect.suspend(() => {
				active.delete(barrier)
				if (active.size === 0) {
					byOperation.delete(operationId)
				}
				return barrier.open
			}),
	)
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
			if (settled.status === "unanswered") {
				if (settled.reason === "aborted") {
					yield* Effect.promise(() => backend.omitEntries(operationId))
					const usage = yield* Effect.promise(() => backend.settleUsage(operationId))
					return { ok: false, error: { _tag: "ModelRequestInterrupted", model_usage: usage } }
				}
				const submissionInfo = yield* Effect.promise(() =>
					backend.readUnansweredSubmission(operationId),
				)
				if (
					submissionInfo?.assistantMessage !== undefined &&
					submissionInfo.assistantMessage.stopReason !== "aborted" &&
					isRefusalAssistantMessage(submissionInfo.assistantMessage)
				) {
					if (submissionInfo.assistantEntryId !== undefined) {
						const entryId = submissionInfo.assistantEntryId
						const message = submissionInfo.assistantMessage
						yield* Effect.promise(() => backend.restoreRefusal(operationId, entryId, message))
					}
					yield* Effect.promise(() => backend.markSeedCommitted())
					const usage = yield* Effect.promise(() => backend.settleUsage(operationId))
					return mapAssistantMessageToOutcome(submissionInfo.assistantMessage, usage)
				}
				yield* Effect.promise(() => backend.omitEntries(operationId))
				const usage = yield* Effect.promise(() => backend.settleUsage(operationId))
				yield* Effect.logWarning("pi turn unanswered").pipe(
					Effect.annotateLogs({
						operationId,
						provider: submissionInfo?.assistantMessage?.provider ?? providerForLog,
						category: classifyUnansweredCategory(settled.reason, submissionInfo),
					}),
				)
				return {
					ok: false,
					error: { ...mapUnansweredToError(settled.reason, submissionInfo), model_usage: usage },
				}
			}

			const assistantMessage = yield* Effect.promise(() => backend.readAnswerEntry(operationId))
			if (assistantMessage === null) {
				yield* Effect.promise(() => backend.omitEntries(operationId))
				const usage = yield* Effect.promise(() => backend.settleUsage(operationId))
				return {
					ok: false,
					error: {
						_tag: "ModelProviderError",
						error_type: "empty_model_reply",
						message: "Pi durable completed without an assistant entry.",
						model_usage: usage,
						terminal: false,
					},
				}
			}
			if (!mapAssistantMessageToOutcome(assistantMessage, ZERO_MODEL_USAGE).ok) {
				yield* Effect.promise(() => backend.omitEntries(operationId))
			} else {
				yield* Effect.promise(() => backend.markSeedCommitted())
			}
			const usage = yield* Effect.promise(() => backend.settleUsage(operationId))
			return mapAssistantMessageToOutcome(assistantMessage, usage)
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
	// Synchronize with any in-progress admission for this operation before
	// probing storage so an RPC disconnect mid-admission cannot observe a false
	// `null` while the original turn proceeds to submit and reply.
	while (true) {
		const pending = inFlightAdmissions.get(backend)?.get(operationId)
		if (pending === undefined || pending.size === 0) {
			break
		}
		yield* Effect.forEach(Array.from(pending), (barrier) => barrier.await, {
			concurrency: "unbounded",
			discard: true,
		})
	}
	const probe = yield* backend.withLock(
		Effect.promise(async () => {
			if (await backend.hasSubmission(operationId)) {
				return "submitted" as const
			}
			return backend.isCancelled(operationId) ? ("cancelled" as const) : ("absent" as const)
		}),
	)
	if (probe === "absent") {
		return null
	}
	if (probe === "cancelled") {
		return { ok: false, error: { _tag: "ModelRequestInterrupted" } }
	}
	const settled = yield* Effect.promise((signal) => backend.wait(operationId, signal))
	return yield* resolveSettledPiTurn(backend, operationId, settled, "unknown")
})

export const runPiDurableTurn = Effect.fn("PiDurableEngine.runTurn")(function* (
	backend: PiDurableBackend,
	request: PiTurnRequest,
): Effect.fn.Return<PiTurnResult> {
	const operationId = request.operationId
	const admitted = yield* admitPiTurn(backend, request)
	if (admitted === "history_required") {
		return admitted
	}
	if (!admitted) {
		return { ok: false, error: { _tag: "ModelRequestInterrupted" } }
	}

	const settled = yield* Effect.promise((signal) => backend.wait(operationId, signal))
	return yield* resolveSettledPiTurn(backend, operationId, settled, request.provider)
})
