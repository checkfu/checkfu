import * as Cloudflare from "@alchemy.run/cloudflare"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import type { PiHarness } from "agents/harness/pi"
import type { Lifecycle } from "agents/lifecycle"
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import { createPiHarnessSettings } from "./PiContextBudget.ts"
import {
	finalizeSettledTurnFromStorage,
	omitTurnEntriesFromStorage,
	readAssistantMessageFromStorage,
	readUnansweredSubmissionFromStorage,
	rebuildRootInStorage,
	recoverPiDurableTurn,
	restoreRefusalEntryInStorage,
	runPiDurableTurn,
} from "./PiDurableEngine.ts"
import type { PiDurableBackend } from "./PiDurableEngine.ts"
import { createPiModels, providerApiKeys, providerBaseUrls } from "./PiModels.ts"
import { createCheckfuRegistry, rejectRefusalCompactions } from "./PiRefusals.ts"
import type { PiTurnOutcome, PiTurnRequest, PiTurnResult } from "./PiTurn.ts"
import { beginTurnUsage, clearSeedRebuild, settleTurnUsage } from "./PiTurnUsage.ts"
import { SqliteTurnFence } from "./TurnFence.ts"

type RawDurableObjectState = Cloudflare.DurableObjectState["Service"]["raw"]

class PiSessionHost {
	readonly ctx: RawDurableObjectState
	constructor(ctx: RawDurableObjectState) {
		this.ctx = ctx
	}
}

export const makePiHarnessBackend = (
	lifecycle: Lifecycle,
	harness: PiHarness,
	fence: SqliteTurnFence,
	apiKeys: Effect.Success<typeof providerApiKeys>,
): PiDurableBackend => {
	const lock = Semaphore.makeUnsafe(1)
	const withLock: PiDurableBackend["withLock"] = (effect) =>
		lock.withPermit(Effect.uninterruptible(effect))

	return {
		withLock,
		hasApiKey: (provider) => apiKeys[provider] !== null,
		isCancelled: (operationId) => fence.isCancelled(operationId),
		beginUsage: async (operationId, finalizedPrevious, hasSeed) =>
			beginTurnUsage(await harness.pi(), operationId, finalizedPrevious, hasSeed),
		settleUsage: async (operationId) => settleTurnUsage(await harness.pi(), operationId),
		hasSubmission: async (operationId) => {
			await lifecycle.start()
			const storage = await harness.storage()
			return (
				(await storage.submissionByRequest(
					ROOT_CONVERSATION_ID,
					operationId,
					BACKGROUND_CONTEXT,
				)) !== undefined
			)
		},
		ensureRoot: async (agent, create) => {
			await lifecycle.start()
			const pi = await harness.pi()
			const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
			if (conversation !== undefined) {
				await conversation.configure(agent, BACKGROUND_CONTEXT)
				return true
			}
			if (create === false) {
				return false
			}
			await harness.root(create === true ? { agent } : { agent, init: create })
			return true
		},
		rebuildRoot: async (agent, request, seed) => {
			await lifecycle.start()
			const pi = await harness.pi()
			await rebuildRootInStorage(pi, agent, request, seed)
		},
		markSeedCommitted: async () => {
			await lifecycle.start()
			await clearSeedRebuild(await harness.pi())
		},
		submit: async (text, operationId) => {
			await lifecycle.start()
			await harness.submit(text, { operationId, whenBusy: "followUp", onAbort: "keep" })
		},
		wait: async (operationId, signal) => {
			await lifecycle.start()
			const result = await harness.wait(operationId, signal === undefined ? {} : { signal })
			return result.status === "done"
				? { status: "done" }
				: result.reason === undefined
					? { status: "unanswered" }
					: { status: "unanswered", reason: result.reason }
		},
		abort: (operationId) =>
			// Once the durable cancellation fence is written, keep both permit
			// acquisition and `harness.abort` uninterruptible so an interrupted
			// caller cannot leave a cancelled marker without stopping a turn
			// that was already inside `submit`.
			Effect.uninterruptible(
				Effect.suspend(() => {
					fence.markCancelled(operationId)
					return withLock(
						Effect.promise(async () => {
							await lifecycle.start()
							await harness.abort({ operationId })
							return true
						}),
					)
				}),
			),
		readAnswerEntry: async (operationId) => {
			await lifecycle.start()
			const pi = await harness.pi()
			const storage = await harness.storage()
			return readAssistantMessageFromStorage(pi, storage, operationId)
		},
		readUnansweredSubmission: async (operationId) => {
			await lifecycle.start()
			const pi = await harness.pi()
			const storage = await harness.storage()
			return readUnansweredSubmissionFromStorage(pi, storage, operationId)
		},
		restoreRefusal: async (operationId, entryId, message) => {
			await lifecycle.start()
			const pi = await harness.pi()
			await restoreRefusalEntryInStorage(pi, operationId, entryId, message)
		},
		omitEntries: async (operationId) => {
			await lifecycle.start()
			const pi = await harness.pi()
			const storage = await harness.storage()
			await omitTurnEntriesFromStorage(pi, storage, operationId)
		},
		finalizePrevious: async (operationId) => {
			await lifecycle.start()
			const pi = await harness.pi()
			const storage = await harness.storage()
			await finalizeSettledTurnFromStorage(pi, storage, operationId)
		},
	}
}

export interface PiSessionShape {
	readonly alarm: (info?: Cloudflare.AlarmInvocationInfo) => Effect.Effect<void>
	readonly recoverTurn: (operationId: string) => Effect.Effect<PiTurnOutcome | null>
	readonly runTurn: (request: PiTurnRequest) => Effect.Effect<PiTurnResult>
	readonly abortTurn: (operationId: string) => Effect.Effect<boolean>
}

export class PiSession extends Cloudflare.DurableObject<PiSession, PiSessionShape>()("PiSession", {
	transferredFrom: "ApiWorker",
}) {}

export const PiSessionLive = PiSession.make(
	Effect.map(
		Effect.all({
			state: Cloudflare.DurableObjectState,
			apiKeys: providerApiKeys,
			baseUrls: providerBaseUrls,
		}),
		({ state, apiKeys, baseUrls }) =>
			Effect.promise(async () => {
				// Load workerd-only modules after Alchemy has evaluated the stack.
				const [{ Lifecycle: LifecycleClass }, { PiHarness: PiHarnessClass }] = await Promise.all([
					import("agents/lifecycle"),
					import("agents/harness/pi"),
				])

				// PiHarness calls this factory again when it reopens after a storage error.
				const harness = new PiHarnessClass({
					harness: ({ storage, context, onWake }) => {
						const models = createPiModels(apiKeys, baseUrls)
						return Harness.open(
							storage,
							{
								models: rejectRefusalCompactions(models),
								registry: createCheckfuRegistry(),
								onWake,
								settings: createPiHarnessSettings(models),
							},
							context,
						)
					},
				})
				const rawCtx = state.raw
				const lifecycle = new LifecycleClass(new PiSessionHost(rawCtx)).use(harness)
				const fence = new SqliteTurnFence({
					exec: (query, ...bindings) => rawCtx.storage.sql.exec(query, ...bindings),
					transaction: (run) => rawCtx.storage.transactionSync(run),
				})
				const backend = makePiHarnessBackend(lifecycle, harness, fence, apiKeys)

				return {
					alarm: () => Effect.promise(() => lifecycle.alarm()),
					recoverTurn: (operationId) => recoverPiDurableTurn(backend, operationId),
					runTurn: (request) => runPiDurableTurn(backend, request),
					abortTurn: (operationId) => backend.abort(operationId),
				}
			}),
	),
)
