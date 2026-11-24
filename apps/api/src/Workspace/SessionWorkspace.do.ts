import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { createRepositoryFetch, githubBaseUrl } from "./Repositories.ts"
import type { RepositoryMount, WorkspacePreparation } from "./Repositories.ts"
import { makeTurnFence } from "./WorkspaceFence.ts"
import type { TurnToken } from "./WorkspaceFence.ts"
import { purgeTables } from "./WorkspaceStorage.ts"
import { grepWithin, readLongLine } from "./WorkspacePaging.ts"
import {
	GIT_TOOL,
	READ_PAGE_BYTES,
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
const tokenKey = (resourceId: string) => `token:${resourceId}`

const refusedPreparation = (resourceId: string, message: string): WorkspacePreparation => ({
	ok: false,
	resource_id: resourceId,
	message,
})

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
		Effect.all({ state: Cloudflare.DurableObjectState, baseUrl: githubBaseUrl }),
		({ state, baseUrl }) =>
			Effect.promise(async () => {
				// Load workerd-only modules after Alchemy has evaluated the stack.
				const [{ Workspace }, { createPiTools }, { createGitClient }] = await Promise.all([
					import("@cloudflare/computer"),
					import("@cloudflare/computer/tools/pi-ai"),
					import("@cloudflare/computer/git"),
				])
				const { storage } = state.raw
				const mounted = (): ReadonlyArray<MountedRepository> =>
					storage.kv.get<ReadonlyArray<MountedRepository>>(REPOSITORIES) ?? []
				const { fs, git } = new Workspace({
					storage,
					git: createGitClient({
						fetch: createRepositoryFetch({
							repositories: mounted,
							token: (resourceId) => storage.kv.get<string>(tokenKey(resourceId)),
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
				// The prompt names this directory, so a new filesystem gets it before its first call.
				// Only a new one: the agent may remove it or put a file there, and setting it up again
				// must not stand between the object and its other methods.
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
				// One clone at a time, so a retried call waits for the clone already under way.
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
					// A new turn retires every turn before it. A turn that is no longer current, or one
					// of an ended session, is refused before it asks a model anything.
					enter: (token: TurnToken): Effect.Effect<boolean> =>
						Effect.promise(
							async () =>
								storage.kv.get(DISCARDED) !== true &&
								(await fence.enter(token)) &&
								// Discard may have come while entry waited.
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
								if (call.name === GIT_TOOL.name) {
									return boundWorkspaceResult(call.name, await runGit(call.arguments))
								}
								if (call.name === "grep") {
									return grepWithin(fs, call.arguments, workspaceOutputLimits("grep").maxBytes)
								}
								const { content, isError } = await files.execute(call, { abortSignal })
								if (isError && call.name === "read") {
									const page = await readLongLine(fs, call.arguments, READ_PAGE_BYTES).catch(
										() => undefined,
									)
									if (page !== undefined) {
										return page
									}
								}
								return boundWorkspaceResult(call.name, { content, isError })
							})
							return (
								result ?? failed("This turn has ended; the workspace no longer accepts its calls.")
							)
						}),
					prepare: (
						token: TurnToken,
						repositories: ReadonlyArray<RepositoryMount>,
					): Effect.Effect<WorkspacePreparation> =>
						Effect.promise(async () => {
							const resourceId = repositories[0]?.id ?? ""
							if (storage.kv.get(DISCARDED) === true) {
								return refusedPreparation(
									resourceId,
									"The session has ended and its workspace was discarded.",
								)
							}
							// Run for the turn that asked, so a later turn refuses it, and held by the fence,
							// so a discard waits for a clone under way before it purges.
							const next = fence.run(token, () => preparing.then(() => prepare(repositories)))
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
					// The marker goes first and stays: from it on every call is refused, also while the
					// files are removed, after a reset part way through, and on a second delivery.
					discard: (): Effect.Effect<void> =>
						Effect.promise(async () => {
							storage.kv.put(DISCARDED, true)
							// A call that started before the marker could still write after a purge.
							await fence.drain()
							// Removing files through the filesystem would leave their paths in its change
							// history, so its tables are emptied instead, with every other key, at once.
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
