import * as Cloudflare from "@alchemy.run/cloudflare"
import type {
	CloudflareAiBindingLike,
	ProviderCredentialCheck,
	ProviderSpec,
} from "@checkfu/pi-providers/catalog"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { decodeAgentTools } from "@checkfu/domain/Mcp/McpServers"
import type { AgentTool, CustomTool } from "@checkfu/domain/Mcp/McpServers"
import type { ModelUsage } from "@checkfu/domain/Session/SessionTypes"
import type { PiHarness } from "agents/harness/pi"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Semaphore from "effect/Semaphore"
import { Connection } from "../Connection/Connection.do.ts"
import { placedStub, placement } from "../Placement.ts"
import { SessionWorkspace } from "../Workspace/SessionWorkspace.do.ts"
import { workspaceExtension, workspaceToolDeclarations } from "../Workspace/WorkspaceTools.ts"
import { checkCatalogProviderCredentials } from "./PiCatalog.ts"
import {
	codemodeSandboxes,
	loadToolSurface,
	scriptOutputEnv,
	withScriptBounds,
} from "./PiCodemode.ts"
import { PI_HARNESS_SETTINGS } from "./PiContextBudget.ts"
import { actionsExtension, customToolsExtension } from "./PiActions.ts"
import {
	abortOperation,
	abortPiDurableTurn,
	answerPiDurableCall,
	pausePiDurableTurn,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "./PiDurableEngine.ts"
import type { PiDurableBackend } from "./PiDurableEngine.ts"
import { toProviderRuntimeConfig } from "./PiModels.ts"
import type { ProviderApiKeysInput } from "./PiModels.ts"
import { PiProviderRuntime, loadEnvPiProviderRuntime } from "./PiProviderRuntime.ts"
import type { SessionMcp } from "./PiMcpSession.ts"
import { createCheckfuRegistry } from "./PiRefusals.ts"
import { MCP_TURN_KEY } from "./PiTurn.ts"
import type { PiActionAnswer, PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"
import { turnCallLog } from "./PiTurnCalls.ts"
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
const AGENT_TOOLS = "agent-tools"

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
	const stoppable = new Map<string, Set<AbortController>>()

	return {
		withLock,
		hasApiKey: (provider) => checkCredentials(provider).ok,
		missingCredentialsMessage: (provider) => {
			const check = checkCredentials(provider)
			return check.ok ? `Missing credentials for provider "${provider}".` : check.message
		},
		reset: Effect.andThen(Effect.sync(reset), Effect.never),
		isCancelled: (operationId) => fence.isCancelled(operationId),
		untilCancelled: async (operationId, work) => {
			const controller = new AbortController()
			const running = stoppable.get(operationId) ?? new Set()
			stoppable.set(operationId, running.add(controller))
			if (fence.isCancelled(operationId)) {
				controller.abort()
			}
			try {
				return await work(controller.signal)
			} finally {
				running.delete(controller)
				if (running.size === 0) {
					stoppable.delete(operationId)
				}
			}
		},
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
		signal: (taskId, token, key, value) => harness.signal(taskId, token, key, value),
		abort: (operationId) =>
			Effect.uninterruptible(
				Effect.suspend(() => {
					fence.markCancelled(operationId)
					for (const controller of stoppable.get(operationId) ?? []) {
						controller.abort()
					}
					return withLock(
						Effect.promise(async () => {
							await abortOperation(await harness.pi(), operationId)
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
	readonly pauseUsage: (operationId: string, pause: string) => Effect.Effect<ModelUsage>
	readonly answerCall: (
		toolUseId: string,
		answer: typeof PiActionAnswer.Type,
	) => Effect.Effect<"delivered" | "gone">
}

export class PiSession extends Cloudflare.DurableObject<PiSession, PiSessionShape>()("PiSession") {}

const piSessionInit = Effect.gen(function* () {
	const state = yield* Cloudflare.DurableObjectState
	const injectedRuntime = yield* Effect.serviceOption(PiProviderRuntime)
	const providerRuntime = Option.isSome(injectedRuntime)
		? injectedRuntime.value
		: yield* loadEnvPiProviderRuntime
	const workspaces = yield* SessionWorkspace
	const connections = yield* Connection
	const sandboxes = yield* codemodeSandboxes
	const where = yield* Effect.orDie(placement)
	return { state, providerRuntime, workspaces, connections, sandboxes, where }
})

export const PiSessionLive = PiSession.make(
	Effect.map(
		piSessionInit,
		({ state, providerRuntime, workspaces, connections, sandboxes, where }) =>
			Effect.gen(function* () {
				const rawCtx = state.raw
				const sessionId = rawCtx.id.name
				if (sessionId === undefined) {
					return yield* Effect.die(new Error("PiSession must be addressed by its session id."))
				}
				const sessionProviders = yield* providerRuntime.forSession({ sessionId })
				const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())

				// Load workerd-only modules after Alchemy has evaluated the stack.
				const [
					{ Lifecycle: LifecycleClass },
					{ PiHarness: PiHarnessClass },
					{ RemoteCodemodeSandbox },
					withToolSurface,
				] = yield* Effect.promise(() =>
					Promise.all([
						import("agents/lifecycle"),
						import("agents/harness/pi"),
						import("@earendil-works/pi-codemode/portable"),
						loadToolSurface(),
					]),
				)

				const workspaceStub = placedStub(workspaces, where)
				const workspace = () => workspaceStub(sessionId)
				const workspaceDeclarations = yield* Effect.promise(() => workspaceToolDeclarations())
				const admittedTurn = (): number => rawCtx.storage.kv.get<number>(ADMITTED_TURN) ?? 0
				const writeScriptOutput = (path: string, content: string | Uint8Array) =>
					runPromise(workspace().writeScriptOutput(path, content, { turn: admittedTurn() }))
				const outputEnv = scriptOutputEnv(writeScriptOutput)
				const turnCalls = turnCallLog({
					exec: (query, ...bindings) => rawCtx.storage.sql.exec(query, ...bindings),
				})
				let declared: ReadonlyArray<AgentTool> | undefined
				const agentTools = (): ReadonlyArray<AgentTool> => {
					declared ??= decodeAgentTools(rawCtx.storage.kv.get<string>(AGENT_TOOLS))
					return declared
				}
				const keepAgentTools = (text: string): boolean => {
					if (rawCtx.storage.kv.get<string>(AGENT_TOOLS) !== undefined) {
						return false
					}
					rawCtx.storage.kv.put(AGENT_TOOLS, text)
					declared = undefined
					return true
				}
				const connectionStub = placedStub(connections, where)
				let mcp: SessionMcp | undefined
				const loadMcp = async (): Promise<SessionMcp> => {
					const { makeSessionMcp, vaultsOver } = await import("./PiMcpSession.ts")
					mcp ??= makeSessionMcp({
						kv: {
							get: (key) => rawCtx.storage.kv.get<string>(key),
							put: (key, value) => {
								rawCtx.storage.kv.put(key, value)
							},
						},
						vaults: vaultsOver((vaultId) => {
							const vault = connectionStub(vaultId)
							return {
								mcpList: (...asked) => runPromise(vault.mcpList(...asked)),
								mcpCall: (...asked) => runPromise(vault.mcpCall(...asked)),
								mcpCancel: (callId) => runPromise(vault.mcpCancel(callId)),
							}
						}, sessionId),
						admittedTurn,
						agentTools,
					})
					return mcp
				}
				if (rawCtx.storage.kv.get<string>(MCP_TURN_KEY) !== undefined) {
					yield* Effect.promise(loadMcp)
				}
				const sandboxStub = placedStub(sandboxes, where)
				const sandbox = withScriptBounds(
					new RemoteCodemodeSandbox({
						remote: () => ({
							execute: (request, exchange) =>
								runPromise(sandboxStub(sessionId).execute(request, exchange)),
						}),
					}),
				)

				const workspaceTools = workspaceExtension(workspaceDeclarations, (call, signal) =>
					runPromise(
						workspace().runTool(call, { turn: admittedTurn() }),
						signal === undefined ? undefined : { signal },
					),
				)
				let registry = createCheckfuRegistry()
				const installTools = () => {
					for (const extension of withToolSurface(sandbox, [
						workspaceTools,
						...(mcp?.extensions() ?? []),
						customToolsExtension(
							agentTools().filter((tool): tool is CustomTool => tool.type === "custom"),
						),
					])) {
						registry.install(extension)
					}
					registry.install(
						actionsExtension(
							(name) => mcp?.toolOf(name),
							{ admit: (taskId) => turnCalls(admittedTurn()).admit(taskId) },
							(name) => agentTools().some((tool) => tool.type === "custom" && tool.name === name),
						),
					)
				}

				// PiHarness calls this factory again when it reopens after a storage error.
				const harness = new PiHarnessClass({
					harness: ({ storage, context, onWake }) => {
						const models = sessionProviders.createModels()
						registry = createCheckfuRegistry()
						installTools()
						return Harness.open(
							storage,
							{
								models,
								registry,
								onWake,
								settings: PI_HARNESS_SETTINGS,
								env: () => outputEnv,
							},
							context,
						)
					},
				})
				const lifecycle = new LifecycleClass(new PiSessionHost(rawCtx)).use(harness)
				const fence = new SqliteTurnFence({
					exec: (query, ...bindings) => rawCtx.storage.sql.exec(query, ...bindings),
				})
				const harnessBackend = makePiHarnessBackend(
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
				const backend: PiDurableBackend = {
					...harnessBackend,
					turnCalls,
					publishMcp: async (request) => {
						const session = request.mcp === undefined ? undefined : await loadMcp()
						const published =
							session !== undefined &&
							request.mcp !== undefined &&
							session.publish(request.turn, request.mcp)
						if (request.tools !== undefined && keepAgentTools(request.tools)) {
							installTools()
						}
						return published && session !== undefined && session.undiscovered()
					},
					discoverMcp: async (request, signal) => {
						await mcp?.discover(request.turn, signal)
						installTools()
					},
					mcpToolOf: (name) => mcp?.toolOf(name),
				}

				return {
					alarm: () => Effect.promise(() => lifecycle.alarm()),
					recoverTurn: (operationId) => recoverPiDurableTurn(backend, operationId),
					runTurn: (request) => runPiDurableTurn(backend, request),
					abortTurn: (operationId) => abortPiDurableTurn(backend, operationId),
					pauseUsage: (operationId, pause) => pausePiDurableTurn(backend, operationId, pause),
					answerCall: (toolUseId, answer) => answerPiDurableCall(backend, toolUseId, answer),
				}
			}),
	),
)
