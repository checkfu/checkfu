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
import { Sandboxes } from "../Sandbox/Sandboxes.ts"
import {
	createMachineEgress,
	createRepositoryFetch,
	githubBaseUrl,
	makeGitCalls,
} from "./Repositories.ts"
import type { RepositoryMount, WorkspacePreparation } from "./Repositories.ts"
import { ApiWorker } from "../Api.ts"
import { ARTIFACT_MOUNT_ROOT, SKILL_MOUNT_ROOT } from "@checkfu/domain/Session/SessionResource"
import { makeArtifactMount } from "./ArtifactMount.ts"
import { makeMemoryMount } from "./MemoryMount.ts"
import { makeSandboxMount } from "./SandboxMount.ts"
import type { SessionArtifacts } from "./SessionArtifacts.ts"
import { makeSessionMemory } from "./SessionMemory.ts"
import { makeTurnFence } from "./WorkspaceFence.ts"
import type { TurnToken } from "./WorkspaceFence.ts"
import { makeSavedDisk } from "./SavedDisk.ts"
import type { SavedDisk } from "./SavedDisk.ts"
import { machineIdle, makeWorkspaceMachine } from "./WorkspaceMachine.ts"
import { purgeTables } from "./WorkspaceStorage.ts"
import {
	BASH_SECONDS,
	BASH_TOOL,
	GIT_TOOL,
	WORKSPACE_TOOL_OPTIONS,
	asLiteral,
	boundWorkspaceResult,
	decodeBashToolArguments,
	decodeGitToolArguments,
	gitAnswer,
} from "./WorkspaceTools.ts"
import type { WorkspaceToolCall, WorkspaceToolResult } from "./WorkspaceTools.ts"

const DISCARDED = "discarded"
const NEWEST_TURN = "newest-turn"
const INTERRUPTED_TURN = "interrupted-turn"
const WORKING_DIRECTORY = "/workspace"
const REPOSITORIES = "repositories"
const ALLOWED_HOSTS = "allowed-hosts"
const SLEEP = "sleep"
const tokenKey = (resourceId: string) => `token:${resourceId}`

const refusedPreparation = (resourceId: string, message: string): WorkspacePreparation => ({
	ok: false,
	resource_id: resourceId,
	message,
})

const INTERRUPTED: WorkspacePreparation = { ok: false, interrupted: true }

const MEMORY_ROOT = "/mnt/memory"

const newTurnScope = (): AbortController => new AbortController()

const failed = (text: string): WorkspaceToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
})

interface MountedRepository extends RepositoryMount {
	readonly cloned: boolean
}

interface Files {
	readonly fs: Workspace["fs"]
	readonly tools: ReturnType<typeof createPiTools>
}

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
			baseUrl: githubBaseUrl,
			api: Cloudflare.Workers.bindWorker(Cloudflare.Worker.ref(ApiWorker)),
			sandboxes: Sandboxes,
			idleAfter: Effect.orDie(machineIdle),
			services: Effect.context<never>(),
		}),
		({ state, baseUrl, api, sandboxes, idleAfter, services }) =>
			Effect.gen(function* () {
				const { storage } = state.raw
				const mounted = (): ReadonlyArray<MountedRepository> =>
					storage.kv.get<ReadonlyArray<MountedRepository>>(REPOSITORIES) ?? []
				const sessionId = state.raw.id.name ?? ""
				const call = Effect.runPromiseWith(services)
				const memory = makeSessionMemory({
					mounts: () => call(api.memoryMounts(sessionId)),
					list: (name, after) => call(api.memoryList(sessionId, name, after)),
					read: (name, path) => call(api.memoryRead(sessionId, name, path)),
					write: (name, path, content, exclusive) =>
						call(api.memoryWrite(sessionId, name, path, content, exclusive)),
					remove: (name, path, expected) => call(api.memoryRemove(sessionId, name, path, expected)),
				})
				const artifacts: SessionArtifacts = {
					mounts: () => call(api.artifactMounts(sessionId)),
					files: (mountPath) => call(api.artifactFiles(sessionId, mountPath)),
					read: (mountPath, path, offset, length) =>
						call(api.artifactRead(sessionId, mountPath, path, offset, length)),
				}
				const mounts = () => ({
					[MEMORY_ROOT]: makeMemoryMount(memory),
					[ARTIFACT_MOUNT_ROOT]: makeArtifactMount(ARTIFACT_MOUNT_ROOT, artifacts),
					[SKILL_MOUNT_ROOT]: makeArtifactMount(SKILL_MOUNT_ROOT, artifacts),
				})
				const access = {
					repositories: mounted,
					token: (resourceId: string) => storage.kv.get<string>(tokenKey(resourceId)),
					allowedHosts: (): ReadonlyArray<string> | null => {
						const allowed = storage.kv.get<ReadonlyArray<string> | null>(ALLOWED_HOSTS)
						return allowed === undefined ? [] : allowed
					},
					baseUrl,
					fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init),
				}
				const gitCalls = makeGitCalls()
				let turnScope = newTurnScope()
				const open = async () => {
					const [{ Workspace }, { createPiTools }, { createGitClient }] = await Promise.all([
						import("@cloudflare/computer"),
						import("@cloudflare/computer/tools/pi-ai"),
						import("@cloudflare/computer/git"),
					])
					const { fs, git } = new Workspace({
						storage,
						mounts: mounts(),
						git: createGitClient({
							fetch: createRepositoryFetch({ ...access, signal: gitCalls.signal }),
						}),
						defaultGitIdentity: { name: "Checkfu", email: "agent@checkfu.com" },
					})
					let overMachine: Files | undefined
					return {
						fs,
						git,
						local: { fs, tools: createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: { fs } }) },
						shared: (): Files => {
							if (overMachine === undefined) {
								const over = new Workspace({
									storage,
									mounts: {
										...mounts(),
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
						append: (archive) => disk().append(archive),
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
				})
				const egress = createMachineEgress(access)
				const fence = makeTurnFence({
					get: () => storage.kv.get<TurnToken>(NEWEST_TURN),
					put: (token) => storage.kv.put(NEWEST_TURN, token),
				})
				const initialize = async (fs: Workspace["fs"]): Promise<void> => {
					await fs.stat(WORKING_DIRECTORY).catch(async (error: unknown) => {
						if (!Predicate.hasProperty(error, "code") || error.code !== "ENOENT") {
							throw error
						}
						await fs.mkdir(WORKING_DIRECTORY, { recursive: true })
					})
				}

				const clone = async (repository: RepositoryMount, signal: AbortSignal): Promise<void> => {
					const { fs, git } = await workspace()
					await fs.rm(repository.mount_path, { recursive: true, force: true })
					const { checkout } = repository
					await gitCalls.run(signal, () =>
						git.clone({
							url: repository.url,
							dir: repository.mount_path,
							depth: 1,
							...(checkout === null
								? {}
								: {
										ref: checkout.type === "commit" ? checkout.sha : `refs/heads/${checkout.name}`,
									}),
						}),
					)
				}

				const prepare = async (
					repositories: ReadonlyArray<RepositoryMount>,
					signal: AbortSignal,
				): Promise<WorkspacePreparation> => {
					for (const repository of repositories) {
						if (signal.aborted) {
							return INTERRUPTED
						}
						if (mounted().some(({ id, cloned }) => id === repository.id && cloned)) {
							continue
						}
						const others = mounted().filter(({ id }) => id !== repository.id)
						storage.kv.put(REPOSITORIES, [...others, { ...repository, cloned: false }])
						try {
							await clone(repository, signal)
							await machine.add(repository.mount_path)
						} catch (error) {
							return signal.aborted
								? INTERRUPTED
								: { ok: false, resource_id: repository.id, message: messageOf(error) }
						}
						storage.kv.put(REPOSITORIES, [...others, { ...repository, cloned: true }])
					}
					return { ok: true }
				}
				let preparing: Promise<unknown> = Promise.resolve()

				const runGit = async (
					input: unknown,
					inMachine: boolean,
					signal: AbortSignal,
				): Promise<WorkspaceToolResult> => {
					const decoded = decodeGitToolArguments(input)
					if (Option.isNone(decoded)) {
						return failed("git takes `args`, a non-empty list of strings, and `cwd`, a path.")
					}
					try {
						if (inMachine) {
							return await machine.command(
								["git", ...decoded.value.args],
								{ cwd: decoded.value.cwd, seconds: BASH_SECONDS },
								signal,
							)
						}
						const { git } = await workspace()
						const { stdout, stderr, exitCode } = await gitCalls.run(signal, () =>
							git.cli({ argv: [...decoded.value.args], cwd: decoded.value.cwd }),
						)
						return gitAnswer(stdout, stderr, exitCode)
					} catch (error) {
						return failed(
							signal?.aborted === true
								? "git was stopped: its turn was interrupted."
								: messageOf(error),
						)
					}
				}

				const runBash = async (
					input: unknown,
					signal: AbortSignal | undefined,
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

				const answer = async (
					call: WorkspaceToolCall,
					abortSignal: AbortSignal,
				): Promise<WorkspaceToolResult> => {
					if (call.name === BASH_TOOL.name) {
						return runBash(call.arguments, abortSignal)
					}
					const inMachine = machine.engaged()
					const files = await workspace()
					const on = inMachine ? files.shared() : files.local
					const work = (): Promise<WorkspaceToolResult> =>
						call.name === GIT_TOOL.name
							? runGit(call.arguments, inMachine, AbortSignal.any([abortSignal, turnScope.signal]))
							: on.tools.execute(asLiteral(call), { abortSignal })
					return inMachine ? work() : onStored(work)
				}

				const underWay = new Map<
					string,
					{ readonly stop: () => void; readonly ended: Promise<unknown> }
				>()
				const stopAll = (): void => {
					for (const { stop } of underWay.values()) {
						stop()
					}
				}

				let calls = 0
				const runtime = yield* RuntimeContext
				const stayAwake: Effect.Effect<void> = Effect.suspend(() =>
					idle
						.schedule(SLEEP, { after: idleAfter, payload: null })
						.pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie),
				)
				const idle = yield* makeCallback(SLEEP, (_: null) =>
					Effect.suspend(() =>
						calls > 0
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
						return HttpServerResponse.fromWeb(yield* Effect.promise(() => egress(request)))
					}).pipe(Effect.orDie),
					enter: (token: TurnToken): Effect.Effect<boolean> =>
						Effect.promise(async () => {
							if (
								storage.kv.get(DISCARDED) === true ||
								storage.kv.get(INTERRUPTED_TURN) === token.turn
							) {
								return false
							}
							const newest = storage.kv.get<TurnToken>(NEWEST_TURN)
							if (newest === undefined || token.turn > newest.turn) {
								turnScope.abort()
								turnScope = newTurnScope()
								stopAll()
							}
							return (await fence.enter(token)) && storage.kv.get(DISCARDED) !== true
						}),
					interrupt: (token: TurnToken): Effect.Effect<void> =>
						Effect.sync(() => {
							storage.kv.put(INTERRUPTED_TURN, token.turn)
							if (storage.kv.get<TurnToken>(NEWEST_TURN)?.turn === token.turn) {
								turnScope.abort()
								stopAll()
							}
						}),
					runTool: (call: WorkspaceToolCall, token: TurnToken) => {
						const touch = Effect.suspend(() =>
							call.name === BASH_TOOL.name || machine.engaged() ? stayAwake : Effect.void,
						)
						const run = Effect.promise(async (interrupted) => {
							if (storage.kv.get(DISCARDED) === true) {
								return failed("The session has ended and its workspace was discarded.")
							}
							const stopping = new AbortController()
							interrupted.addEventListener("abort", () => stopping.abort(), { once: true })
							calls += 1
							const ended = fence
								.run(token, async (): Promise<WorkspaceToolResult> => {
									await initialize((await workspace()).fs)
									const { content, isError } = await answer(call, stopping.signal)
									return boundWorkspaceResult(call.name, { content, isError })
								})
								.finally(() => {
									calls -= 1
									underWay.delete(call.id)
								})
							underWay.set(call.id, { stop: () => stopping.abort(), ended })
							return (
								(await ended) ??
								failed("This turn has ended; the workspace no longer accepts its calls.")
							)
						})
						return Effect.andThen(touch, Effect.ensuring(run, touch))
					},
					stopCall: (callId: string) =>
						Effect.promise(async () => {
							const call = underWay.get(callId)
							call?.stop()
							await call?.ended.catch(() => undefined)
						}),
					prepare: (
						token: TurnToken,
						repositories: ReadonlyArray<RepositoryMount>,
						allowedHosts: ReadonlyArray<string> | null,
					): Effect.Effect<WorkspacePreparation> =>
						Effect.promise(async () => {
							const resourceId = repositories[0]?.id ?? ""
							if (storage.kv.get(DISCARDED) === true) {
								return refusedPreparation(
									resourceId,
									"The session has ended and its workspace was discarded.",
								)
							}
							const next = fence.run(token, () =>
								preparing.then(async () => {
									storage.kv.put(ALLOWED_HOSTS, allowedHosts)
									return prepare(repositories, turnScope.signal)
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
						Effect.sync(() => {
							const stored = storage.kv.get<string>(tokenKey(resourceId)) !== undefined
							if (storage.kv.get(DISCARDED) !== true && (replace || !stored)) {
								storage.kv.put(tokenKey(resourceId), token)
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
							turnScope.abort()
							yield* idle
								.cancel(SLEEP)
								.pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie)
							stopAll()
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
