import * as Cloudflare from "@alchemy.run/cloudflare"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import type { Registry } from "@earendil-works/pi-durable"
import type { PiHarness } from "agents/harness/pi"
import type { McpServerBinding } from "@checkfu/domain/Mcp/McpServers"
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import { Connection, connectionName } from "../Connection/Connection.do.ts"
import type { McpUpstream } from "../Connection/McpUpstream.ts"
import { ApiCatalog } from "../OpenApi/ApiCatalog.do.ts"
import { placedStub, placement } from "../Placement.ts"
import { SessionWorkspace } from "../Workspace/SessionWorkspace.do.ts"
import { workspaceExtension, workspaceToolDeclarations } from "../Workspace/WorkspaceTools.ts"
import { apiExtension, apiToolPermissions, fencedApiCall } from "./PiApi.ts"
import { PiApprovalStore, TOOL_DECISION_KEY, ToolDecision, makeToolGate } from "./PiApprovals.ts"
import type { ToolAnswer, ToolGate } from "./PiApprovals.ts"
import { codemodeSandboxes, loadToolSurface, withScriptDeadline } from "./PiCodemode.ts"
import { CUSTOM_TOOL_RESULT_KEY, CustomToolResult, PiCustomToolStore } from "./PiCustomTools.ts"
import { PI_HARNESS_SETTINGS } from "./PiContextBudget.ts"
import { servedFrom } from "./PiDurableEngine.ts"
import type { PiDurableBackend } from "./PiDurableEngine.ts"
import { fencedMcpCall, mcpExtension, mcpToolPermissions } from "./PiMcp.ts"
import { PiMcpStore } from "./PiMcpStore.ts"
import { createPiModels, providerApiKeys, providerBaseUrls } from "./PiModels.ts"
import { createCheckfuRegistry } from "./PiRefusals.ts"
import type { PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"
import { makePiTurns } from "./PiTurns.ts"
import { SqliteTurnFence } from "./TurnFence.ts"

// One server cannot crowd out the rest of a conversation's tools.
const MAX_MCP_SERVER_TOOLS = 512

// Until Pi is open there is no call an answer could reach.
const NOT_OPEN = () => Promise.resolve("not_found" as const)

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
	apiKeys: Effect.Success<typeof providerApiKeys>,
	reset: () => void,
	enterWorkspace: (turn: number) => Promise<boolean>,
	mcp?: Pick<PiMcpStore, "served">,
	gate?: Pick<ToolGate, "settleOrPause">,
	custom?: Pick<PiCustomToolStore, "served">,
): PiDurableBackend => {
	const lock = Semaphore.makeUnsafe(1)
	const withLock: PiDurableBackend["withLock"] = (effect) =>
		lock.withPermit(Effect.uninterruptible(effect))

	const wait: PiDurableBackend["wait"] = async (operationId, signal) => {
		const result = await harness.wait(operationId, signal === undefined ? {} : { signal })
		return result.status === "done"
			? { status: "done" }
			: result.reason === undefined
				? { status: "unanswered" }
				: { status: "unanswered", reason: result.reason }
	}

	return {
		withLock,
		hasApiKey: (provider) => apiKeys[provider] !== null,
		reset: Effect.andThen(Effect.sync(reset), Effect.never),
		isCancelled: (operationId) => fence.isCancelled(operationId),
		enterWorkspace,
		...(mcp === undefined && custom === undefined
			? {}
			: { servedToolCalls: () => servedFrom(custom?.served(), mcp?.served()) }),
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
		wait,
		settleOrPause: (operationId, signal) =>
			gate === undefined
				? wait(operationId, signal)
				: gate.settleOrPause((stop) => wait(operationId, stop), signal),
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
	readonly resumeTurn: (
		operationId: string,
		answers: ReadonlyArray<ToolAnswer>,
	) => Effect.Effect<PiTurnOutcome | null>
	// A Durable Object RPC method: the stub calls it, so it cannot be a plain Effect value.
	// oxlint-disable-next-line effecttsgo/lazy-effect
	readonly waitingCalls: () => Effect.Effect<ReadonlyArray<string>>
	readonly cancelWaiting: (operationId: string) => Effect.Effect<void>
}

export class PiSession extends Cloudflare.DurableObject<PiSession, PiSessionShape>()("PiSession") {}

export const PiSessionLive = PiSession.make(
	Effect.map(
		Effect.all({
			state: Cloudflare.DurableObjectState,
			apiKeys: providerApiKeys,
			baseUrls: providerBaseUrls,
			workspaces: SessionWorkspace,
			sandboxes: codemodeSandboxes,
			connections: Connection,
			catalogs: ApiCatalog,
			where: Effect.orDie(placement),
		}),
		({ state, apiKeys, baseUrls, workspaces, sandboxes, connections, catalogs, where }) =>
			Effect.promise(async () => {
				// Load workerd-only modules after Alchemy has evaluated the stack.
				// Code mode loads here too, so only the isolates that host a session parse it.
				const [
					{ Lifecycle: LifecycleClass },
					{ PiHarness: PiHarnessClass },
					{ RemoteCodemodeSandbox },
					withToolSurface,
				] = await Promise.all([
					import("agents/lifecycle"),
					import("agents/harness/pi"),
					import("@earendil-works/pi-codemode/portable"),
					loadToolSurface(),
				])

				const rawCtx = state.raw
				// The object is named by its session, and so is the session's workspace.
				const sessionId = rawCtx.id.name
				if (sessionId === undefined) {
					throw new Error("PiSession must be addressed by its session id.")
				}
				// A stub stays broken after its object disconnects, so each call takes a new one,
				// placed as the harness Worker places it: a different placement is a different object.
				const workspaceStub = placedStub(workspaces, where)
				const workspace = () => workspaceStub(sessionId)
				const workspaceTools = await workspaceToolDeclarations()
				const admittedTurn = (): number => rawCtx.storage.kv.get<number>(ADMITTED_TURN) ?? 0
				const sandboxStub = placedStub(sandboxes, where)
				const connection = placedStub(connections, where)
				const catalog = placedStub(catalogs, where)
				const sandbox = withScriptDeadline(
					new RemoteCodemodeSandbox({
						remote: () => ({
							execute: (request, exchange) =>
								Effect.runPromise(sandboxStub(sessionId).execute(request, exchange)),
						}),
					}),
				)

				const sql = {
					exec: (query: string, ...bindings: ReadonlyArray<unknown>) =>
						rawCtx.storage.sql.exec(query, ...bindings),
					transaction: (run: () => void) => rawCtx.storage.transactionSync(run),
				}
				const mcp = new PiMcpStore(sql)
				// This session's own MCP clients, one per bound server: their protocol state, such as a
				// stateful server's session id, is never shared with another session. They live as long
				// as this object and send every request through the server's connection.
				const upstreams = new Map<string, Promise<McpUpstream>>()
				const upstream = (binding: McpServerBinding): Promise<McpUpstream> => {
					const key = JSON.stringify([binding.name, binding.url, binding.credential_id])
					const existing = upstreams.get(key)
					if (existing !== undefined) {
						return existing
					}
					const created = import("../Connection/McpUpstream.ts").then(({ makeMcpUpstream }) =>
						makeMcpUpstream(binding.url, (request) =>
							Effect.runPromise(connection(connectionName(binding)).forward(request)),
						),
					)
					upstreams.set(key, created)
					// A failed load or connect is forgotten, so the next call tries again.
					created.catch(() => {
						if (upstreams.get(key) === created) {
							upstreams.delete(key)
						}
					})
					return created
				}
				const approvals = new PiApprovalStore(sql)
				const customTools = new PiCustomToolStore(sql)
				let permissions = mcpToolPermissions([])
				let signalTool: Parameters<typeof makeToolGate>[0]["signal"] = NOT_OPEN
				let signalToolResult: Parameters<typeof makeToolGate>[0]["signalResult"] = NOT_OPEN
				const gate = makeToolGate({
					store: approvals,
					permission: (toolName) => permissions.get(toolName),
					ledger: {
						began: (call) => mcp.began(call),
						ended: (callId, result) => mcp.ended(callId, result),
					},
					signal: (taskId, value) => signalTool(taskId, value),
					signalResult: (taskId, value) => signalToolResult(taskId, value),
				})
				// A call belongs to the turn admitted when it starts, as a workspace call does.
				const admitted = () => Effect.runPromise(workspace().enter({ turn: admittedTurn() }))
				let registry: Registry | undefined
				// Installing a name that is installed replaces it, so this also refreshes.
				const installTools = async (into: Registry) => {
					const servers = mcp.servers()
					const apiServers = mcp.apiServers()
					// A name both kinds of server could give a tool is prefixed by its kind, so none collide.
					permissions = new Map([...mcpToolPermissions(servers), ...apiToolPermissions(apiServers)])
					const extensions = withToolSurface(sandbox, [
						gate.extension,
						workspaceExtension(workspaceTools, (call, signal) =>
							Effect.runPromise(
								// The turn this call belongs to is the one admitted when it starts.
								workspace().runTool(call, { turn: admittedTurn() }),
								signal === undefined ? undefined : { signal },
							),
						),
						customTools.extension(gate.park),
						...servers.map((server) =>
							mcpExtension(server, {
								call: fencedMcpCall(admitted, async (binding, tool, args) =>
									(await upstream(binding)).callTool(tool, args),
								),
								began: (call) => mcp.began(call),
								ended: (callId, result) => mcp.ended(callId, result),
							}),
						),
						...apiServers.map((server) =>
							apiExtension(server, {
								// The catalog turns the call into a request; only the connection sends it.
								call: fencedApiCall(admitted, async (binding, operation, args) => {
									const built = await Effect.runPromise(
										catalog(binding.catalog_id).request(operation, args),
									)
									return built.ok
										? Effect.runPromise(
												connection(
													connectionName({
														url: binding.base_url,
														credential_id: binding.credential_id,
													}),
												).callApi(binding.base_url, built.request),
											)
										: built
								}),
								began: (call) => mcp.began(call),
								ended: (callId, result) => mcp.ended(callId, result),
							}),
						),
					])
					for (const extension of extensions) {
						into.install(extension)
					}
				}
				/**
				 * A turn names the session's servers and custom tools. Each server's tools are listed once
				 * per conversation, so what the model is offered does not shift under
				 * it; a server that could not be reached is asked again next turn.
				 */
				const bindTools = async (request: PiTurnRequest) => {
					const customToolsChanged = customTools.bind(request.custom_tools ?? [])
					const apiChanged = mcp.bindApi(request.api_servers ?? [])
					let changed = mcp.bind(request.mcp_servers ?? []) || customToolsChanged || apiChanged
					for (const { binding, tools } of mcp.servers()) {
						if (tools !== null) {
							continue
						}
						const listed = await upstream(binding)
							.then((client) => client.listTools())
							.catch(() => undefined)
						if (listed?.ok === true) {
							mcp.listed(binding.name, listed.tools.slice(0, MAX_MCP_SERVER_TOOLS))
							changed = true
						}
					}
					for (const { binding, tools } of mcp.apiServers()) {
						if (tools !== null) {
							continue
						}
						const listed = await Effect.runPromise(catalog(binding.catalog_id).tools()).catch(
							() => undefined,
						)
						if (listed?.ok === true) {
							mcp.listedApi(binding.name, listed.tools)
							changed = true
						}
					}
					if (changed && registry !== undefined) {
						await installTools(registry)
					}
				}

				// PiHarness calls this factory again when it reopens after a storage error.
				const harness = new PiHarnessClass({
					harness: async ({ storage, context, onWake }) => {
						const models = createPiModels(apiKeys, baseUrls)
						const opened = createCheckfuRegistry()
						await installTools(opened)
						registry = opened
						return Harness.open(
							storage,
							{
								models,
								registry: opened,
								onWake,
								settings: PI_HARNESS_SETTINGS,
							},
							context,
						)
					},
				})
				const lifecycle = new LifecycleClass(new PiSessionHost(rawCtx)).use(harness)
				const fence = new SqliteTurnFence(sql)
				signalTool = async (taskId, value) => {
					await lifecycle.start()
					return harness.signal(taskId, ToolDecision, TOOL_DECISION_KEY, value)
				}
				signalToolResult = async (taskId, value) => {
					await lifecycle.start()
					return harness.signal(taskId, CustomToolResult, CUSTOM_TOOL_RESULT_KEY, {
						content: value.content.map((block) => ({ type: "text" as const, text: block.text })),
						is_error: value.is_error,
					})
				}
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
					mcp,
					gate,
					customTools,
				)
				const turns = makePiTurns({
					backend,
					approvals,
					gate,
					prepare: bindTools,
					// A turn Pi has not seen yet starts after the last one's calls were published.
					begin: () => {
						mcp.forgetCalls()
						customTools.forgetRequests()
					},
				})

				return {
					alarm: () => Effect.promise(() => lifecycle.alarm()),
					recoverTurn: (operationId: string): Effect.Effect<PiTurnOutcome | null> =>
						turns.recoverTurn(operationId),
					runTurn: (request: PiTurnRequest): Effect.Effect<PiTurnOutcome> => turns.runTurn(request),
					resumeTurn: (
						operationId: string,
						answers: ReadonlyArray<ToolAnswer>,
					): Effect.Effect<PiTurnOutcome | null> => turns.resumeTurn(operationId, answers),
					abortTurn: (operationId: string): Effect.Effect<boolean> => turns.abortTurn(operationId),
					waitingCalls: (): Effect.Effect<ReadonlyArray<string>> => turns.waitingCalls(),
					cancelWaiting: (operationId: string): Effect.Effect<void> =>
						turns.cancelWaiting(operationId),
				}
			}),
	),
)
