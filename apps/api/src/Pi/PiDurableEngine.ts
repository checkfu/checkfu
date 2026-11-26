import type { ModelUsage } from "@checkfu/domain/Session/SessionTypes"
import type { ProviderCredentialCheck } from "@checkfu/pi-providers/catalog"
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
} from "@earendil-works/pi-durable"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { checkCatalogProviderCredentials } from "./PiCatalog.ts"
import { mapAssistantMessageToOutcome, mapUnansweredToError } from "./PiRefusals.ts"
import { beginTurnUsage, isStaleTurn, settleTurnUsage } from "./PiTurnUsage.ts"

import type { PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"

export interface PiDurableBackend {
	readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	readonly hasApiKey: (provider: string) => boolean | Promise<boolean>
	readonly missingCredentialsMessage?: (provider: string) => string | Promise<string>
	readonly checkCredentials?: (
		provider: string,
		signal?: AbortSignal,
	) => ProviderCredentialCheck | Promise<ProviderCredentialCheck>
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

interface TurnEntries {
	readonly ids: ReadonlyArray<EntryId>
	readonly compaction: EntryRecord | undefined
}

const readTurnEntries = async (
	conversation: Conversation,
	userEntryId: EntryId,
): Promise<TurnEntries> => {
	const ids: Array<EntryId> = [userEntryId]
	let compaction: EntryRecord | undefined
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
				return { ids, compaction }
			}
			if (CompactionEntry.is(entry)) {
				compaction = entry
			} else if (AssistantEntry.is(entry) || ToolResultEntry.is(entry)) {
				ids.push(entry.id)
			}
		}
		cursor = page.next
	} while (cursor !== undefined)
	return { ids, compaction }
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

interface PendingCredentialCheck {
	readonly operationId: string
	readonly turn: number
	readonly wake: Deferred.Deferred<void>
}

const pendingCredentialChecks = new WeakMap<PiDurableBackend, Set<PendingCredentialCheck>>()

const pendingChecksOf = (backend: PiDurableBackend) => {
	const existing = pendingCredentialChecks.get(backend)
	if (existing !== undefined) {
		return existing
	}
	const created = new Set<PendingCredentialCheck>()
	pendingCredentialChecks.set(backend, created)
	return created
}

const wakePendingChecks = (
	backend: PiDurableBackend,
	predicate: (entry: PendingCredentialCheck) => boolean,
): Effect.Effect<void> =>
	Effect.suspend(() => {
		const active = pendingCredentialChecks.get(backend)
		if (active === undefined || active.size === 0) {
			return Effect.void
		}
		const matching = [...active].filter(predicate)
		if (matching.length === 0) {
			return Effect.void
		}
		return Effect.forEach(matching, (entry) => Deferred.succeed(entry.wake, undefined), {
			discard: true,
		})
	})

const notifyAdmissionAbort = (
	backend: PiDurableBackend,
	operationId: string,
): Effect.Effect<void> => wakePendingChecks(backend, (entry) => entry.operationId === operationId)

const notifyAdmissionSubmitted = (
	backend: PiDurableBackend,
	operationId: string,
	turn: number,
): Effect.Effect<void> =>
	wakePendingChecks(backend, (entry) => entry.operationId === operationId || entry.turn < turn)

const notifyTurnFenceAdvanced = (backend: PiDurableBackend, turn: number): Effect.Effect<void> =>
	wakePendingChecks(backend, (entry) => entry.turn < turn)

export const abortPiDurableTurn = (
	backend: PiDurableBackend,
	operationId: string,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const grace = yield* AbortGrace
		const watched = yield* Effect.forkDetach(
			Effect.gen(function* () {
				const aborting = yield* Effect.forkDetach(backend.abort(operationId), {
					startImmediately: true,
				})
				yield* notifyAdmissionAbort(backend, operationId)
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

type AdmitPiTurnResult =
	| boolean
	| { readonly _tag: "missing_key"; readonly message: string | undefined }

type AdmitLockOutcome =
	| AdmitPiTurnResult
	| { readonly _tag: "waiting"; readonly waitingFor: string }

const admitPiTurn = (
	backend: PiDurableBackend,
	request: PiTurnRequest,
): Effect.Effect<AdmitPiTurnResult> =>
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
): Effect.Effect<AdmitPiTurnResult> => {
	const operationId = request.operationId
	const agent: AgentChange = {
		model: { provider: request.provider, modelId: request.modelId },
		instructions: request.system !== null && request.system.length > 0 ? request.system : null,
	}
	return Effect.gen(function* () {
		const restoredLimit = yield* RestoredHistoryLimit
		let finalizedPrevious: string | undefined
		let credentialsVerified = false
		while (true) {
			if (!credentialsVerified) {
				const credentialOutcome = yield* Effect.acquireUseRelease(
					Effect.sync(() => {
						const entry: PendingCredentialCheck = {
							operationId,
							turn: request.turn,
							wake: Deferred.makeUnsafe<void>(),
						}
						pendingChecksOf(backend).add(entry)
						return entry
					}),
					(entry) =>
						Effect.gen(function* () {
							const precheck = yield* backend.withLock(
								Effect.gen(function* () {
									const status = yield* Effect.promise(
										async (): Promise<"submitted" | "cancelled" | "check_credentials"> => {
											const pi = await backend.pi()
											if ((await submissionOf(pi, operationId)) !== undefined) {
												return "submitted"
											}
											if (
												backend.isCancelled(operationId) ||
												(await isStaleTurn(pi, operationId, request.turn))
											) {
												return "cancelled"
											}
											return "check_credentials"
										},
									)
									if (status === "submitted") {
										yield* notifyAdmissionSubmitted(backend, operationId, request.turn)
									}
									return status
								}),
							)
							if (precheck === "submitted") {
								return "submitted" as const
							}
							if (precheck === "cancelled") {
								return "cancelled" as const
							}
							return yield* Effect.raceFirst(
								Deferred.await(entry.wake).pipe(Effect.as("woken" as const)),
								Effect.promise(async (signal): Promise<AdmitPiTurnResult> => {
									if (backend.checkCredentials !== undefined) {
										const check = await backend.checkCredentials(request.provider, signal)
										return check.ok ? true : { _tag: "missing_key", message: check.message }
									}
									if (await backend.hasApiKey(request.provider)) {
										return true
									}
									return {
										_tag: "missing_key",
										message:
											backend.missingCredentialsMessage === undefined
												? undefined
												: await backend.missingCredentialsMessage(request.provider),
									}
								}),
							)
						}),
					(entry) =>
						Effect.sync(() => {
							const active = pendingCredentialChecks.get(backend)
							active?.delete(entry)
							if (active?.size === 0) {
								pendingCredentialChecks.delete(backend)
							}
						}),
				)
				if (credentialOutcome === "submitted") {
					return true
				}
				if (credentialOutcome === "cancelled") {
					return false
				}
				if (credentialOutcome === "woken" || typeof credentialOutcome === "object") {
					const raced = yield* backend.withLock(
						Effect.gen(function* () {
							const status = yield* Effect.promise(
								async (): Promise<"submitted" | "cancelled" | "missing"> => {
									const pi = await backend.pi()
									if ((await submissionOf(pi, operationId)) !== undefined) {
										return "submitted"
									}
									if (
										credentialOutcome === "woken" ||
										backend.isCancelled(operationId) ||
										(await isStaleTurn(pi, operationId, request.turn))
									) {
										return "cancelled"
									}
									return "missing"
								},
							)
							if (status === "submitted") {
								yield* notifyAdmissionSubmitted(backend, operationId, request.turn)
							}
							return status
						}),
					)
					if (raced === "submitted") {
						return true
					}
					if (raced === "cancelled") {
						return false
					}
					return credentialOutcome === "woken" ? false : credentialOutcome
				}
				credentialsVerified = true
			}

			const admitted: AdmitLockOutcome = yield* backend.withLock(
				Effect.gen(function* () {
					let turnFenceAdvanced = false
					const outcome = yield* Effect.promise(async (): Promise<AdmitLockOutcome> => {
						const pi = await backend.pi()
						if ((await submissionOf(pi, operationId)) !== undefined) {
							return true
						}
						if (
							backend.isCancelled(operationId) ||
							(await isStaleTurn(pi, operationId, request.turn))
						) {
							return false
						}
						await backend.ensureRoot(agent)
						if (backend.isCancelled(operationId)) {
							return false
						}
						while (true) {
							const turnState = await beginTurnUsage(
								pi,
								operationId,
								request.turn,
								finalizedPrevious,
							)
							if (turnState.status === "stale") {
								return false
							}
							if (turnState.status === "waiting") {
								return { _tag: "waiting", waitingFor: turnState.operationId }
							}
							if (turnState.status === "finalize") {
								await finalizeSettledTurn(pi, turnState.operationId, restoredLimit)
								finalizedPrevious = turnState.operationId
								continue
							}
							turnFenceAdvanced = true
							break
						}
						if (!(await backend.enterWorkspace(request.turn))) {
							await settleTurnUsage(pi, operationId)
							return false
						}
						for (const unpublished of request.unpublishedOperationIds ?? []) {
							await omitTurnEntries(pi, unpublished, restoredLimit)
						}
						if (backend.isCancelled(operationId)) {
							return false
						}
						await backend.submit(request.text, operationId)
						return true
					}).pipe(
						Effect.ensuring(
							Effect.suspend(() =>
								turnFenceAdvanced ? notifyTurnFenceAdvanced(backend, request.turn) : Effect.void,
							),
						),
					)
					if (outcome === true) {
						yield* notifyAdmissionSubmitted(backend, operationId, request.turn)
					}
					return outcome
				}),
			)
			if (typeof admitted === "boolean") {
				return admitted
			}
			if (admitted._tag === "missing_key") {
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
		}),
	)

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
	if (typeof admitted === "object") {
		const fallbackCheck = checkCatalogProviderCredentials(request.provider, { env: {} })
		const message =
			admitted.message ??
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
