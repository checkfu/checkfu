import * as Cloudflare from "@alchemy.run/cloudflare"
import type { CloudflareAiBindingLike } from "@checkfu/pi-providers/catalog"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import type { PiHarness } from "agents/harness/pi"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Semaphore from "effect/Semaphore"
import { checkCatalogProviderCredentials } from "./PiCatalog.ts"
import { placedStub, placement } from "../Placement.ts"
import { SessionWorkspace } from "../Workspace/SessionWorkspace.do.ts"
import { workspaceExtension, workspaceToolDeclarations } from "../Workspace/WorkspaceTools.ts"
import { PI_HARNESS_SETTINGS } from "./PiContextBudget.ts"
import { abortPiDurableTurn, recoverPiDurableTurn, runPiDurableTurn } from "./PiDurableEngine.ts"
import type { PiDurableBackend } from "./PiDurableEngine.ts"
import {
	createPiModels,
	extractAiBinding,
	providerApiKeys,
	providerBaseUrls,
	toProviderRuntimeConfig,
} from "./PiModels.ts"
import type { ProviderApiKeysInput } from "./PiModels.ts"
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

const ADMITTED_TURN = "workspace-turn"

export const makePiHarnessBackend = (
	harness: PiHarness,
	fence: SqliteTurnFence,
	apiKeys: ProviderApiKeysInput,
	reset: () => void,
	enterWorkspace: (turn: number) => Promise<boolean>,
	options?: { readonly aiBinding?: CloudflareAiBindingLike | null },
): PiDurableBackend => {
	const lock = Semaphore.makeUnsafe(1)
	const withLock: PiDurableBackend["withLock"] = (effect) =>
		lock.withPermit(Effect.uninterruptible(effect))
	const runtimeConfig = toProviderRuntimeConfig(apiKeys, undefined, options)

	return {
		withLock,
		hasApiKey: (provider) => checkCatalogProviderCredentials(provider, runtimeConfig).ok,
		missingCredentialsMessage: (provider) => {
			const check = checkCatalogProviderCredentials(provider, runtimeConfig)
			return check.ok ? `Missing credentials for provider "${provider}".` : check.message
		},
		reset: Effect.andThen(Effect.sync(reset), Effect.never),
		isCancelled: (operationId) => fence.isCancelled(operationId),
		enterWorkspace,
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
			workerEnv: Effect.serviceOption(Cloudflare.Workers.WorkerEnvironment),
			apiKeys: providerApiKeys,
			baseUrls: providerBaseUrls,
			workspaces: SessionWorkspace,
			where: Effect.orDie(placement),
		}),
		({ state, workerEnv, apiKeys, baseUrls, workspaces, where }) =>
			Effect.promise(async () => {
				const aiBinding = extractAiBinding(Option.getOrUndefined(workerEnv))
				const [{ Lifecycle: LifecycleClass }, { PiHarness: PiHarnessClass }] = await Promise.all([
					import("agents/lifecycle"),
					import("agents/harness/pi"),
				])

				const rawCtx = state.raw
				const sessionId = rawCtx.id.name
				if (sessionId === undefined) {
					throw new Error("PiSession must be addressed by its session id.")
				}
				const workspaceStub = placedStub(workspaces, where)
				const workspace = () => workspaceStub(sessionId)
				const workspaceTools = await workspaceToolDeclarations()
				const admittedTurn = (): number => rawCtx.storage.kv.get<number>(ADMITTED_TURN) ?? 0

				const harness = new PiHarnessClass({
					harness: ({ storage, context, onWake }) => {
						const models = createPiModels(apiKeys, baseUrls, { aiBinding })
						const registry = createCheckfuRegistry()
						registry.install(
							workspaceExtension(workspaceTools, (call, signal) =>
								Effect.runPromise(
									workspace().runTool(call, { turn: admittedTurn() }),
									signal === undefined ? undefined : { signal },
								),
							),
						)
						return Harness.open(
							storage,
							{
								models,
								registry,
								onWake,
								settings: PI_HARNESS_SETTINGS,
							},
							context,
						)
					},
				})
				const lifecycle = new LifecycleClass(new PiSessionHost(rawCtx)).use(harness)
				const fence = new SqliteTurnFence({
					exec: (query, ...bindings) => rawCtx.storage.sql.exec(query, ...bindings),
				})
				const backend = makePiHarnessBackend(
					harness,
					fence,
					apiKeys,
					() => {
						rawCtx.abort("A turn did not stop when aborted")
					},
					async (turn) => {
						const entered = await Effect.runPromise(workspace().enter({ turn }))
						if (entered) {
							rawCtx.storage.kv.put(ADMITTED_TURN, turn)
						}
						return entered
					},
					{ aiBinding },
				)

				return {
					alarm: () => Effect.promise(() => lifecycle.alarm()),
					recoverTurn: (operationId) => recoverPiDurableTurn(backend, operationId),
					runTurn: (request) => runPiDurableTurn(backend, request),
					abortTurn: (operationId) => abortPiDurableTurn(backend, operationId),
				}
			}),
	),
)
