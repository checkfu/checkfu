import * as Cloudflare from "@alchemy.run/cloudflare"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import type { PiHarness } from "agents/harness/pi"
import type { Lifecycle } from "agents/lifecycle"
import * as Effect from "effect/Effect"
import { createPiHarnessSettings } from "./PiContextBudget.ts"
import {
	type PiDurableBackend,
	type PiTurnRequest,
	type PiTurnResult,
	createAsyncMutex,
	finalizeSettledTurnFromStorage,
	omitTurnEntriesFromStorage,
	readAssistantMessageFromStorage,
	readUnansweredSubmissionFromStorage,
	rebuildRootInStorage,
	recoverPiDurableTurn,
	restoreRefusalEntryInStorage,
	runPiDurableTurn,
} from "./PiDurableEngine.ts"
import { createPiModels, providerApiKeys, providerBaseUrls } from "./PiModels.ts"
import {
	type PiTurnOutcome,
	createCheckfuRegistry,
	rejectRefusalCompactions,
} from "./PiRefusals.ts"
import { beginTurnUsage, clearSeedRebuild, settleTurnUsage } from "./PiTurnUsage.ts"
import { SqliteTurnFence } from "./TurnFence.ts"

type LifecycleHost = ConstructorParameters<typeof Lifecycle>[0]

class PiSessionHost {
	readonly ctx: LifecycleHost["ctx"]
	constructor(ctx: LifecycleHost["ctx"]) {
		this.ctx = ctx
	}
}

const makePiHarnessBackend = (
	lifecycle: Lifecycle,
	harness: PiHarness,
	fence: SqliteTurnFence,
): PiDurableBackend => {
	const withLock = createAsyncMutex()

	return {
		withLock,
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
			if (create === false) return false
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
		abort: async (operationId) => {
			fence.markCancelled(operationId)
			return withLock(async () => {
				await lifecycle.start()
				await harness.abort({ operationId })
				return true
			})
		},
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

export class PiSession extends Cloudflare.DurableObject<PiSession>()(
	"PiSession",
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
				const rawCtx = state.raw as unknown as LifecycleHost["ctx"]
				const lifecycle = new LifecycleClass(
					new PiSessionHost(rawCtx) as unknown as LifecycleHost,
				).use(harness)
				const fence = new SqliteTurnFence({
					exec: (query, ...bindings) => rawCtx.storage.sql.exec(query, ...bindings),
					transaction: (run) => rawCtx.storage.transactionSync(run),
				})
				const backend = makePiHarnessBackend(lifecycle, harness, fence)

				return {
					alarm: () => Effect.promise(() => lifecycle.alarm()),
					recoverTurn: (operationId: string): Effect.Effect<PiTurnOutcome | null> =>
						Effect.promise((signal) => recoverPiDurableTurn(backend, operationId, signal)),
					runTurn: (request: PiTurnRequest): Effect.Effect<PiTurnResult> =>
						Effect.promise((signal) => runPiDurableTurn(backend, request, signal)),
					abortTurn: (operationId: string): Effect.Effect<boolean> =>
						Effect.promise(() => backend.abort(operationId)),
				}
			}),
	),
) {}
