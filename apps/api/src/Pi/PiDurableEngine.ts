import type { ModelUsage } from "@checkfu/domain/Session/SessionTypes"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import type { AgentChange, EntryId, Harness } from "@earendil-works/pi-durable"
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

export interface PiDurableBackend {
	readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	readonly hasApiKey: (provider: SupportedProvider) => boolean
	readonly isCancelled: (operationId: string) => boolean
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

const omitTurnEntries = async (pi: Harness, operationId: string): Promise<void> => {
	const record = await submissionOf(pi, operationId)
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
