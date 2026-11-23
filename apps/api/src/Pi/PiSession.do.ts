import * as Cloudflare from "@alchemy.run/cloudflare"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import type { PiHarness } from "agents/harness/pi"
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import { PI_HARNESS_SETTINGS } from "./PiContextBudget.ts"
import { abortPiDurableTurn, recoverPiDurableTurn, runPiDurableTurn } from "./PiDurableEngine.ts"
import type { PiDurableBackend } from "./PiDurableEngine.ts"
import { createPiModels, providerApiKeys, providerBaseUrls } from "./PiModels.ts"
import { createCheckfuRegistry } from "./PiRefusals.ts"
import type { PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"
import { SqliteTurnFence } from "./TurnFence.ts"

type RawDurableObjectState = Cloudflare.DurableObjectState["Service"]["raw"]

class PiSessionHost {
	readonly ctx: RawDurableObjectState
	constructor(ctx: RawDurableObjectState) {
		this.ctx = ctx
	}
}

export const makePiHarnessBackend = (
	harness: PiHarness,
	fence: SqliteTurnFence,
	apiKeys: Effect.Success<typeof providerApiKeys>,
	reset: () => void,
): PiDurableBackend => {
	const lock = Semaphore.makeUnsafe(1)
	const withLock: PiDurableBackend["withLock"] = (effect) =>
		lock.withPermit(Effect.uninterruptible(effect))

	return {
		withLock,
		hasApiKey: (provider) => apiKeys[provider] !== null,
		reset: Effect.andThen(Effect.sync(reset), Effect.never),
		isCancelled: (operationId) => fence.isCancelled(operationId),
		pi: () => harness.pi(),
		ensureRoot: async (agent) => {
			const pi = await harness.pi()
			const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
			if (conversation === undefined) {
				await harness.root({ agent })
			} else {
				await conversation.configure(agent, BACKGROUND_CONTEXT)
			}
		},
		submit: async (text, operationId) => {
			await harness.submit(text, { operationId, whenBusy: "followUp", onAbort: "keep" })
		},
		wait: async (operationId, signal) => {
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
							await harness.abort({ operationId })
							return true
						}),
					)
				}),
			),
	}
}

export interface PiSessionShape {
	readonly alarm: (info?: Cloudflare.AlarmInvocationInfo) => Effect.Effect<void>
	readonly recoverTurn: (operationId: string) => Effect.Effect<PiTurnOutcome | null>
	readonly runTurn: (request: PiTurnRequest) => Effect.Effect<PiTurnOutcome>
	readonly abortTurn: (operationId: string) => Effect.Effect<boolean>
}

export class PiSession extends Cloudflare.DurableObject<PiSession, PiSessionShape>()("PiSession") {}

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
								models,
								registry: createCheckfuRegistry(),
								onWake,
								settings: PI_HARNESS_SETTINGS,
							},
							context,
						)
					},
				})
				const rawCtx = state.raw
				const lifecycle = new LifecycleClass(new PiSessionHost(rawCtx)).use(harness)
				const fence = new SqliteTurnFence({
					exec: (query, ...bindings) => rawCtx.storage.sql.exec(query, ...bindings),
				})
				const backend = makePiHarnessBackend(harness, fence, apiKeys, () => {
					rawCtx.abort("A turn did not stop when aborted")
				})

				return {
					alarm: () => Effect.promise(() => lifecycle.alarm()),
					recoverTurn: (operationId) => recoverPiDurableTurn(backend, operationId),
					runTurn: (request) => runPiDurableTurn(backend, request),
					abortTurn: (operationId) => abortPiDurableTurn(backend, operationId),
				}
			}),
	),
)
