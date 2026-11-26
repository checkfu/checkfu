import * as Cloudflare from "@alchemy.run/cloudflare"
import type { Workspace } from "@cloudflare/computer"
import type { createPiTools } from "@cloudflare/computer/tools/pi-ai"
import { makeCallback } from "alchemy/Callback"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import { Sandboxes, machineIdle } from "../Sandbox/Sandboxes.ts"
import { createMachineEgress, isAllowedHost } from "./MachineEgress.ts"
import {
	GITHUB_HOST,
	cloneCommand,
	githubBaseUrl,
	repositoryTokenGate,
	withRepositoryCredentials,
} from "./Repositories.ts"
import { makeSandboxMount } from "./SandboxMount.ts"
import { makeSessionOutputs } from "./SessionOutputs.ts"
import type { OutputBytes, OutputsListing } from "./SessionOutputs.ts"
import { makeTurnFence } from "./WorkspaceFence.ts"
import type { FencedTurn, TurnToken } from "./WorkspaceFence.ts"
import { makeSavedDisk } from "./SavedDisk.ts"
import type { SavedDisk } from "./SavedDisk.ts"
import { makeWorkspaceMachine } from "./WorkspaceMachine.ts"
import type { RepositoryMount, WorkspacePreparation } from "./WorkspaceShapes.ts"
import { purgeTables } from "./WorkspaceStorage.ts"
import {
	BASH_SECONDS,
	BASH_TOOL,
	WORKSPACE_TOOL_OPTIONS,
	asLiteral,
	boundWorkspaceResult,
	decodeBashToolArguments,
} from "./WorkspaceTools.ts"
import type { WorkspaceToolCall, WorkspaceToolResult } from "./WorkspaceTools.ts"

const DISCARDED = "discarded"
const NEWEST_TURN = "newest-turn"
const WORKING_DIRECTORY = "/workspace"
export const SCRIPT_OUTPUT_DIRECTORY = "/workspace/.scripts"

const isScriptOutputPath = (path: string): boolean =>
	path.startsWith(`${SCRIPT_OUTPUT_DIRECTORY}/`) && !path.split("/").includes("..")
const ALLOWED_HOSTS = "allowed-hosts"
const SLEEP = "sleep"
const CLONE_SECONDS = 600
const tokenKey = (resourceId: string) => `token:${resourceId}`
const REPOSITORIES = "repositories"

const notAllowed = (host: string) =>
	`The session's environment does not let the workspace reach ${host}: add it to its networking's allowed_hosts.`

const PREPARED: WorkspacePreparation = { ok: true }
const INTERRUPTED: WorkspacePreparation = { ok: false, interrupted: true }

const failed = (text: string): WorkspaceToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
})

interface Files {
	readonly fs: Workspace["fs"]
	readonly tools: ReturnType<typeof createPiTools>
}

const writeFileIn = async (
	fs: Workspace["fs"],
	path: string,
	content: string | Uint8Array,
): Promise<void> => {
	await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true })
	await fs.writeFile(path, content)
}

const outputsIn = (fs: Workspace["fs"]) =>
	makeSessionOutputs({
		list: (directory, limit) => fs.find(directory, undefined, { limit }),
		size: async (file) => (await fs.stat(file)).size,
		read: async (file) => new Uint8Array(await new Response(await fs.readFile(file)).arrayBuffer()),
	})

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

export interface SessionWorkspaceShape {
	readonly fetch: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest
	>
	readonly enter: (token: TurnToken) => Effect.Effect<boolean>
	readonly interrupt: (token: TurnToken) => Effect.Effect<void>
	readonly runTool: (
		call: WorkspaceToolCall,
		token: TurnToken,
	) => Effect.Effect<WorkspaceToolResult>
	readonly stopCall: (callId: string) => Effect.Effect<void>
	readonly listOutputs: (turn: number) => Effect.Effect<OutputsListing | null>
	readonly readOutputs: (
		turn: number,
		paths: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<OutputBytes> | null>
	readonly writeScriptOutput: (
		path: string,
		content: string | Uint8Array,
		token: TurnToken,
	) => Effect.Effect<string | undefined>
	readonly prepare: (
		token: TurnToken,
		repositories: ReadonlyArray<RepositoryMount>,
		allowedHosts: ReadonlyArray<string> | null,
	) => Effect.Effect<WorkspacePreparation>
	readonly storeRepositoryToken: (
		resourceId: string,
		token: string,
		replace: boolean,
	) => Effect.Effect<void>
	readonly discard: (sessionId: string) => Effect.Effect<void>
}

export class SessionWorkspace extends Cloudflare.DurableObject<
	SessionWorkspace,
	SessionWorkspaceShape
>()("SessionWorkspace") {}

export const SessionWorkspaceLive = SessionWorkspace.make(
	Effect.map(
		Effect.all({
			state: Cloudflare.DurableObjectState,
			sandboxes: Sandboxes,
			idleAfter: Effect.orDie(machineIdle),
			baseUrl: githubBaseUrl,
		}),
		({ state, sandboxes, idleAfter, baseUrl }) =>
			Effect.gen(function* () {
				const { storage } = state.raw
				const tokens = yield* repositoryTokenGate(
					(id) => storage.kv.get(tokenKey(id)) !== undefined,
				)
				const context = yield* Effect.context<never>()
				const fork = Effect.runForkWith(context)
				const runPromise = Effect.runPromiseWith(context)
				const sessionId = state.raw.id.name ?? ""
				const allowedHosts = (): ReadonlyArray<string> | null => {
					const allowed = storage.kv.get<ReadonlyArray<string> | null>(ALLOWED_HOSTS)
					return allowed === undefined ? [] : allowed
				}
				const open = async () => {
					const [{ Workspace }, { createPiTools }] = await Promise.all([
						import("@cloudflare/computer"),
						import("@cloudflare/computer/tools/pi-ai"),
					])
					const { fs } = new Workspace({ storage })
					let overMachine: Files | undefined
					return {
						fs,
						local: { fs, tools: createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: { fs } }) },
						shared: (): Files => {
							if (overMachine === undefined) {
								const over = new Workspace({
									storage,
									mounts: {
										[WORKING_DIRECTORY]: makeSandboxMount(WORKING_DIRECTORY, machine.inMachine),
									},
								})
								overMachine = {
									fs: over.fs,
									tools: createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: { fs: over.fs } }),
								}
							}
							return overMachine
						},
					}
				}
				let opened: ReturnType<typeof open> | undefined
				const workspace = (): ReturnType<typeof open> => {
					opened ??= open().catch((error: unknown) => {
						opened = undefined
						throw error
					})
					return opened
				}
				let savedDisk: SavedDisk | undefined
				const disk = (): SavedDisk =>
					(savedDisk ??= makeSavedDisk({
						exec: (query, ...bindings) => storage.sql.exec(query, ...bindings),
						atomically: (work) => storage.transactionSync(work),
					}))
				const stored = new Set<Promise<unknown>>()
				const onStored = async <A>(work: () => Promise<A>): Promise<A> => {
					const done = work()
					stored.add(done)
					try {
						return await done
					} finally {
						stored.delete(done)
					}
				}
				const machine = makeWorkspaceMachine({
					sandboxes,
					key: sessionId,
					store: {
						get: (key) => storage.kv.get(key),
						put: (key, value) => storage.kv.put(key, value),
						delete: (key) => {
							storage.kv.delete(key)
						},
					},
					disk: {
						read: () => disk().read(),
						replace: (archive) => disk().replace(archive),
					},
					directory: WORKING_DIRECTORY,
					stored: {
						readdir: async (path) => (await workspace()).fs.readdir(path),
						lstat: async (path) => (await workspace()).fs.lstat(path),
						readlink: async (path) => (await workspace()).fs.readlink(path),
						readFile: async (path) => (await workspace()).fs.readFile(path),
					},
					settled: async () => {
						await Promise.allSettled(stored)
					},
					touched: () => {
						fork(stayAwake)
					},
				})
				const mounted = (): ReadonlyArray<RepositoryMount> =>
					storage.kv.get<ReadonlyArray<RepositoryMount>>(REPOSITORIES) ?? []
				const egress = createMachineEgress({
					allowedHosts,
					fetch: withRepositoryCredentials({
						repositories: mounted,
						token: (resourceId) => storage.kv.get<string>(tokenKey(resourceId)),
						baseUrl,
						fetch: (request) => fetch(request),
					}),
				})
				const fence = makeTurnFence({
					get: () => storage.kv.get<FencedTurn>(NEWEST_TURN),
					put: (fenced) => storage.kv.put(NEWEST_TURN, fenced),
				})
				const initialize = async (fs: Workspace["fs"]): Promise<void> => {
					await fs.stat(WORKING_DIRECTORY).catch(async (error: unknown) => {
						if (!Predicate.hasProperty(error, "code") || error.code !== "ENOENT") {
							throw error
						}
						await fs.mkdir(WORKING_DIRECTORY, { recursive: true })
					})
				}

				const prepare = async (
					repositories: ReadonlyArray<RepositoryMount>,
					signal: AbortSignal,
				): Promise<WorkspacePreparation> => {
					storage.kv.put(REPOSITORIES, repositories)
					for (const repository of repositories) {
						if (signal.aborted) {
							return INTERRUPTED
						}
						if (repository.requires_token && isAllowedHost(allowedHosts(), GITHUB_HOST)) {
							const ready = await runPromise(tokens.awaitToken(repository.id), {
								signal,
							}).catch((error: unknown) => {
								if (signal.aborted) {
									return false
								}
								throw error
							})
							if (!ready) {
								return signal.aborted
									? INTERRUPTED
									: {
											ok: false,
											resource_id: repository.id,
											message: "Repository token was not stored.",
										}
							}
						}
						await initialize((await workspace()).fs)
						const cloned = await machine
							.command(cloneCommand(repository), { cwd: "/", seconds: CLONE_SECONDS }, signal)
							.catch((error: unknown) => failed(messageOf(error)))
						if (signal.aborted) {
							return INTERRUPTED
						}
						if (cloned.isError) {
							return {
								ok: false,
								resource_id: repository.id,
								message: isAllowedHost(allowedHosts(), GITHUB_HOST)
									? cloned.content.map((part) => (part.type === "text" ? part.text : "")).join("")
									: notAllowed(GITHUB_HOST),
							}
						}
					}
					return PREPARED
				}
				let preparing: Promise<unknown> = Promise.resolve()

				const runBash = async (
					input: unknown,
					signal: AbortSignal,
				): Promise<WorkspaceToolResult> => {
					const decoded = decodeBashToolArguments(input)
					if (Option.isNone(decoded)) {
						return failed(
							"bash takes `command`, and optionally `cwd`, a path, and `timeout`, whole seconds up to 600.",
						)
					}
					try {
						return await machine.command(
							["bash", "-c", decoded.value.command],
							{
								cwd: decoded.value.cwd ?? WORKING_DIRECTORY,
								seconds: decoded.value.timeout ?? BASH_SECONDS,
							},
							signal,
						)
					} catch (error) {
						return failed(messageOf(error))
					}
				}

				let wasInMachine = false
				const onActive = async <A>(work: (on: Files) => Promise<A>): Promise<A> => {
					const inMachine = machine.engaged()
					if (wasInMachine && !inMachine) {
						opened = undefined
					}
					wasInMachine = inMachine
					const files = await workspace()
					return inMachine ? work(files.shared()) : onStored(() => work(files.local))
				}

				const answer = async (
					call: WorkspaceToolCall,
					signal: AbortSignal,
				): Promise<WorkspaceToolResult> => {
					if (call.name === BASH_TOOL.name) {
						return runBash(call.arguments, signal)
					}
					return onActive((on) => on.tools.execute(asLiteral(call), { abortSignal: signal }))
				}

				const underWay = new Map<
					string,
					{ readonly stop: () => void; readonly ended: Promise<unknown> }
				>()

				const runtime = yield* RuntimeContext
				const stayAwake: Effect.Effect<void> = Effect.suspend(() =>
					idle
						.schedule(SLEEP, { after: idleAfter, payload: null })
						.pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie),
				)
				const idle = yield* makeCallback(SLEEP, (_: null) =>
					Effect.suspend(() =>
						machine.busy()
							? stayAwake
							: Effect.promise(() => machine.sleep()).pipe(
									Effect.flatMap((slept) =>
										slept ? Effect.logInfo("Machine asleep", sessionId) : Effect.void,
									),
									Effect.catchCause((cause) =>
										Effect.andThen(
											Effect.logError("Machine not put to sleep", sessionId, cause),
											stayAwake,
										),
									),
								),
					),
				)

				return {
					fetch: Effect.gen(function* () {
						const request = yield* HttpServerRequest.toWeb(
							yield* HttpServerRequest.HttpServerRequest,
						)
						if (storage.kv.get(DISCARDED) === true) {
							return HttpServerResponse.text(
								"The session has ended and its workspace was discarded.",
								{
									status: 403,
								},
							)
						}
						return HttpServerResponse.fromWeb(yield* Effect.promise(() => egress(request)))
					}).pipe(Effect.orDie),
					enter: (token: TurnToken): Effect.Effect<boolean> =>
						Effect.promise(
							async () =>
								storage.kv.get(DISCARDED) !== true &&
								(await fence.enter(token)) &&
								storage.kv.get(DISCARDED) !== true,
						),
					interrupt: (token: TurnToken): Effect.Effect<void> =>
						Effect.sync(() => {
							fence.interrupt(token)
						}),
					runTool: (call: WorkspaceToolCall, token: TurnToken) =>
						Effect.promise(async (interrupted) => {
							if (storage.kv.get(DISCARDED) === true) {
								return failed("The session has ended and its workspace was discarded.")
							}
							const stopping = new AbortController()
							interrupted.addEventListener("abort", () => stopping.abort(), { once: true })
							const ended = fence
								.run(token, async (turn): Promise<WorkspaceToolResult> => {
									const signal = AbortSignal.any([stopping.signal, turn])
									await initialize((await workspace()).fs)
									const { content, isError } = await answer(call, signal)
									return boundWorkspaceResult(call.name, { content, isError })
								})
								.finally(() => {
									underWay.delete(call.id)
								})
							underWay.set(call.id, { stop: () => stopping.abort(), ended })
							return (
								(await ended) ??
								failed("This turn has ended; the workspace no longer accepts its calls.")
							)
						}),
					writeScriptOutput: (
						path: string,
						content: string | Uint8Array,
						token: TurnToken,
					): Effect.Effect<string | undefined> =>
						Effect.promise(async () => {
							if (!isScriptOutputPath(path)) {
								return `Scripts can only save files under ${SCRIPT_OUTPUT_DIRECTORY}.`
							}
							if (storage.kv.get(DISCARDED) === true) {
								return "The session has ended and its workspace was discarded."
							}
							const written = await fence.run(token, async () => {
								await onActive((on) => writeFileIn(on.fs, path, content))
								return true
							})
							return written === undefined
								? "This turn has ended; the workspace no longer accepts its calls."
								: undefined
						}),
					listOutputs: (turn: number): Effect.Effect<OutputsListing | null> =>
						Effect.promise(async () =>
							storage.kv.get(DISCARDED) === true
								? { ok: true, files: [] }
								: ((await fence.run({ turn }, () => onActive((on) => outputsIn(on.fs).list()))) ??
									null),
						),
					readOutputs: (
						turn: number,
						paths: ReadonlyArray<string>,
					): Effect.Effect<ReadonlyArray<OutputBytes> | null> =>
						Effect.promise(async () =>
							storage.kv.get(DISCARDED) === true
								? []
								: ((await fence.run({ turn }, () =>
										onActive((on) => outputsIn(on.fs).read(paths)),
									)) ?? null),
						),
					stopCall: (callId: string) =>
						Effect.promise(async () => {
							const call = underWay.get(callId)
							call?.stop()
							await call?.ended.catch(() => undefined)
						}),
					prepare: (
						token: TurnToken,
						repositories: ReadonlyArray<RepositoryMount>,
						hosts: ReadonlyArray<string> | null,
					): Effect.Effect<WorkspacePreparation> =>
						Effect.promise(async () => {
							if (storage.kv.get(DISCARDED) === true || !(await fence.enter(token))) {
								return INTERRUPTED
							}
							const next = fence.run(token, (signal) =>
								preparing.then(() => {
									storage.kv.put(ALLOWED_HOSTS, hosts)
									return prepare(repositories, signal)
								}),
							)
							preparing = next.catch(() => undefined)
							return (await next) ?? INTERRUPTED
						}),
					storeRepositoryToken: (
						resourceId: string,
						token: string,
						replace: boolean,
					): Effect.Effect<void> =>
						Effect.gen(function* () {
							const stored = storage.kv.get<string>(tokenKey(resourceId)) !== undefined
							if (storage.kv.get(DISCARDED) !== true && (replace || !stored)) {
								storage.kv.put(tokenKey(resourceId), token)
								yield* tokens.stored(resourceId)
							}
						}),
					discard: (discarded: string) =>
						Effect.gen(function* () {
							if (discarded !== sessionId) {
								return yield* Effect.die(
									new Error(`The workspace of ${sessionId} was asked to discard ${discarded}.`),
								)
							}
							storage.kv.put(DISCARDED, true)
							fence.stop()
							yield* idle
								.cancel(SLEEP)
								.pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie)
							yield* Effect.promise(() => fence.drain())
							if (yield* Effect.promise(() => machine.remove())) {
								yield* Effect.logInfo("Machine removed", sessionId)
							}
							storage.transactionSync(() => {
								purgeTables({ exec: (query) => storage.sql.exec(query) })
								for (const [key] of storage.kv.list()) {
									if (key !== DISCARDED) {
										storage.kv.delete(key)
									}
								}
							})
						}),
				}
			}).pipe(Effect.provide(Cloudflare.DurableObjectCallbacks)),
	),
)
