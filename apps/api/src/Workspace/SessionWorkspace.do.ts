import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { createRepositoryFetch, githubBaseUrl } from "./Repositories.ts"
import type { RepositoryMount, WorkspacePreparation } from "./Repositories.ts"
import { ApiWorker } from "../Api.ts"
import { makeMemoryMount } from "./MemoryMount.ts"
import { makeSessionMemory } from "./SessionMemory.ts"
import { makeTurnFence } from "./WorkspaceFence.ts"
import type { TurnToken } from "./WorkspaceFence.ts"
import { purgeTables } from "./WorkspaceStorage.ts"
import { grepWithin, refusedFind } from "./WorkspacePaging.ts"
import {
	GIT_TOOL,
	WORKSPACE_TOOL_OPTIONS,
	boundWorkspaceResult,
	decodeGitToolArguments,
	workspaceOutputLimits,
} from "./WorkspaceTools.ts"
import type { WorkspaceToolCall, WorkspaceToolResult } from "./WorkspaceTools.ts"

const DISCARDED = "discarded"
const NEWEST_TURN = "newest-turn"
const INITIALIZED = "initialized"
const WORKING_DIRECTORY = "/workspace"
const REPOSITORIES = "repositories"
const ALLOWED_HOSTS = "allowed-hosts"
const tokenKey = (resourceId: string) => `token:${resourceId}`

const refusedPreparation = (resourceId: string, message: string): WorkspacePreparation => ({
	ok: false,
	resource_id: resourceId,
	message,
})

const MEMORY_ROOT = "/mnt/memory"

const failed = (text: string): WorkspaceToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
})

interface MountedRepository extends RepositoryMount {
	readonly cloned: boolean
}

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

export class SessionWorkspace extends Cloudflare.DurableObject<SessionWorkspace>()(
	"SessionWorkspace",
	Effect.map(
		Effect.all({
			state: Cloudflare.DurableObjectState,
			baseUrl: githubBaseUrl,
			api: Cloudflare.Workers.bindWorker(Cloudflare.Worker.ref(ApiWorker)),
			services: Effect.context<never>(),
		}),
		({ state, baseUrl, api, services }) =>
			Effect.promise(async () => {
				const [{ Workspace }, { createPiTools }, { createGitClient }] = await Promise.all([
					import("@cloudflare/computer"),
					import("@cloudflare/computer/tools/pi-ai"),
					import("@cloudflare/computer/git"),
				])
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
				const { fs, git } = new Workspace({
					storage,
					mounts: {
						[MEMORY_ROOT]: makeMemoryMount(memory),
					},
					git: createGitClient({
						fetch: createRepositoryFetch({
							repositories: mounted,
							token: (resourceId) => storage.kv.get<string>(tokenKey(resourceId)),
							allowedHosts: () =>
								storage.kv.get<ReadonlyArray<string> | null>(ALLOWED_HOSTS) ?? null,
							baseUrl,
							fetch: (input, init) => fetch(input, init),
						}),
					}),
					defaultGitIdentity: { name: "Checkfu", email: "agent@checkfu.com" },
				})
				const files = createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: { fs } })
				const fence = makeTurnFence({
					get: () => storage.kv.get<TurnToken>(NEWEST_TURN),
					put: (token) => storage.kv.put(NEWEST_TURN, token),
				})
				const initialize = async (): Promise<void> => {
					if (storage.kv.get(INITIALIZED) !== true) {
						await fs.mkdir(WORKING_DIRECTORY, { recursive: true })
						storage.kv.put(INITIALIZED, true)
					}
				}

				const clone = async (repository: RepositoryMount): Promise<void> => {
					await fs.rm(repository.mount_path, { recursive: true, force: true })
					const { checkout } = repository
					await git.clone({
						url: repository.url,
						dir: repository.mount_path,
						depth: 1,
						...(checkout === null
							? {}
							: { ref: checkout.type === "commit" ? checkout.sha : checkout.name }),
					})
				}

				const prepare = async (
					repositories: ReadonlyArray<RepositoryMount>,
				): Promise<WorkspacePreparation> => {
					for (const repository of repositories) {
						if (mounted().some(({ id, cloned }) => id === repository.id && cloned)) {
							continue
						}
						const others = mounted().filter(({ id }) => id !== repository.id)
						storage.kv.put(REPOSITORIES, [...others, { ...repository, cloned: false }])
						try {
							await clone(repository)
						} catch (error) {
							return { ok: false, resource_id: repository.id, message: messageOf(error) }
						}
						storage.kv.put(REPOSITORIES, [...others, { ...repository, cloned: true }])
					}
					return { ok: true }
				}
				let preparing: Promise<unknown> = Promise.resolve()

				const runGit = async (input: unknown): Promise<WorkspaceToolResult> => {
					const decoded = decodeGitToolArguments(input)
					if (Option.isNone(decoded)) {
						return failed("git takes `args`, a non-empty list of strings, and `cwd`, a path.")
					}
					try {
						const { stdout, stderr, exitCode } = await git.cli({
							argv: [...decoded.value.args],
							cwd: decoded.value.cwd,
						})
						return {
							content: [{ type: "text", text: `${stdout}${stderr}` || `exit code ${exitCode}` }],
							isError: exitCode !== 0,
						}
					} catch (error) {
						return failed(messageOf(error))
					}
				}

				return {
					enter: (token: TurnToken): Effect.Effect<boolean> =>
						Effect.promise(
							async () =>
								storage.kv.get(DISCARDED) !== true &&
								(await fence.enter(token)) &&
								storage.kv.get(DISCARDED) !== true,
						),
					runTool: (
						call: WorkspaceToolCall,
						token: TurnToken,
					): Effect.Effect<WorkspaceToolResult> =>
						Effect.promise(async (abortSignal) => {
							if (storage.kv.get(DISCARDED) === true) {
								return failed("The session has ended and its workspace was discarded.")
							}
							const result = await fence.run(token, async (): Promise<WorkspaceToolResult> => {
								await initialize()
								const { content, isError } =
									call.name === GIT_TOOL.name
										? await runGit(call.arguments)
										: call.name === "grep"
											? await grepWithin(fs, call.arguments, workspaceOutputLimits("grep").maxBytes)
											: ((call.name === "find" ? refusedFind(call.arguments) : undefined) ??
												(await files.execute(call, { abortSignal })))
								return boundWorkspaceResult(call.name, { content, isError })
							})
							return (
								result ?? failed("This turn has ended; the workspace no longer accepts its calls.")
							)
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
								preparing.then(() => {
									storage.kv.put(ALLOWED_HOSTS, allowedHosts)
									return prepare(repositories)
								}),
							)
							preparing = next.catch(() => undefined)
							return (
								(await next) ??
								refusedPreparation(
									resourceId,
									"This turn has ended; the workspace no longer accepts its calls.",
								)
							)
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
					discard: (): Effect.Effect<void> =>
						Effect.promise(async () => {
							storage.kv.put(DISCARDED, true)
							await fence.drain()
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
			}),
	),
) {}
