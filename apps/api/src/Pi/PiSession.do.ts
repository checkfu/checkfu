import * as Cloudflare from "@alchemy.run/cloudflare"
import type {
	CloudflareAiBindingLike,
	ProviderCredentialCheck,
	ProviderSpec,
} from "@checkfu/pi-providers/catalog"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import type { PiHarness } from "agents/harness/pi"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Semaphore from "effect/Semaphore"
import { placedStub, placement } from "../Placement.ts"
import { SessionWorkspace } from "../Workspace/SessionWorkspace.do.ts"
import { workspaceExtension, workspaceToolDeclarations } from "../Workspace/WorkspaceTools.ts"
import { checkCatalogProviderCredentials } from "./PiCatalog.ts"
import { PI_HARNESS_SETTINGS } from "./PiContextBudget.ts"
import { abortPiDurableTurn, recoverPiDurableTurn, runPiDurableTurn } from "./PiDurableEngine.ts"
import type { PiDurableBackend } from "./PiDurableEngine.ts"
import { toProviderRuntimeConfig } from "./PiModels.ts"
import type { ProviderApiKeysInput } from "./PiModels.ts"
import { PiProviderRuntime, loadEnvPiProviderRuntime } from "./PiProviderRuntime.ts"
import { createCheckfuRegistry } from "./PiRefusals.ts"
import type { PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"
import { SqliteTurnFence } from "./TurnFence.ts"

export {
	EnvPiProviderRuntimeLive,
	PiProviderRuntime,
	loadEnvPiProviderRuntime,
	staticPiProviderRuntime,
} from "./PiProviderRuntime.ts"
export type {
	PiProviderRuntimeService,
	PiProviderSessionContext,
	PiSessionProviders,
} from "./PiProviderRuntime.ts"

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
	options?: {
		readonly aiBinding?: CloudflareAiBindingLike | null
		readonly customProviders?: ReadonlyArray<ProviderSpec>
		readonly checkCredentials?: (provider: string) => ProviderCredentialCheck
	},
): PiDurableBackend => {
	const lock = Semaphore.makeUnsafe(1)
	const withLock: PiDurableBackend["withLock"] = (effect) =>
		lock.withPermit(Effect.uninterruptible(effect))
	const runtimeConfig = toProviderRuntimeConfig(apiKeys, undefined, options)
	const customProviders = options?.customProviders
	const checkCredentials = (provider: string): ProviderCredentialCheck =>
		options?.checkCredentials !== undefined
			? options.checkCredentials(provider)
			: checkCatalogProviderCredentials(provider, runtimeConfig, customProviders)

	return {
		withLock,
		hasApiKey: (provider) => checkCredentials(provider).ok,
		missingCredentialsMessage: (provider) => {
			const check = checkCredentials(provider)
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

const piSessionInit = Effect.gen(function* () {
	const state = yield* Cloudflare.DurableObjectState
	const injectedRuntime = yield* Effect.serviceOption(PiProviderRuntime)
	const providerRuntime = Option.isSome(injectedRuntime)
		? injectedRuntime.value
		: yield* loadEnvPiProviderRuntime
	const workspaces = yield* SessionWorkspace
	const where = yield* Effect.orDie(placement)
	return { state, providerRuntime, workspaces, where }
})

export const PiSessionLive = PiSession.make(
	Effect.map(piSessionInit, ({ state, providerRuntime, workspaces, where }) =>
		Effect.gen(function* () {
			const rawCtx = state.raw
			const sessionId = rawCtx.id.name
			if (sessionId === undefined) {
				return yield* Effect.die(new Error("PiSession must be addressed by its session id."))
			}
			const sessionProviders = yield* providerRuntime.forSession({ sessionId })
			const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())

			// Load workerd-only modules after Alchemy has evaluated the stack.
			const [{ Lifecycle: LifecycleClass }, { PiHarness: PiHarnessClass }] = yield* Effect.promise(
				() => Promise.all([import("agents/lifecycle"), import("agents/harness/pi")]),
			)

			const workspaceStub = placedStub(workspaces, where)
			const workspace = () => workspaceStub(sessionId)
			const workspaceTools = yield* Effect.promise(() => workspaceToolDeclarations())
			const admittedTurn = (): number => rawCtx.storage.kv.get<number>(ADMITTED_TURN) ?? 0

			// PiHarness calls this factory again when it reopens after a storage error.
			const harness = new PiHarnessClass({
				harness: ({ storage, context, onWake }) => {
					const models = sessionProviders.createModels()
					const registry = createCheckfuRegistry()
					registry.install(
						workspaceExtension(workspaceTools, (call, signal) =>
							runPromise(
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
				{},
				() => {
					rawCtx.abort("A turn did not stop when aborted")
				},
				async (turn) => {
					const entered = await runPromise(workspace().enter({ turn }))
					if (entered) {
						rawCtx.storage.kv.put(ADMITTED_TURN, turn)
					}
					return entered
				},
				{
					checkCredentials: (provider) => sessionProviders.checkCredentials(provider),
				},
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
