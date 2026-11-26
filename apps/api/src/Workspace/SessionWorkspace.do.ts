import * as Cloudflare from "@alchemy.run/cloudflare"
import type { DurableObjectStorageLike } from "@cloudflare/computer"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import { makeSessionOutputs } from "./SessionOutputs.ts"
import type { OutputBytes, OutputsListing } from "./SessionOutputs.ts"
import { makeTurnFence } from "./WorkspaceFence.ts"
import type { TurnToken } from "./WorkspaceFence.ts"
import { purgeTables } from "./WorkspaceStorage.ts"
import { WORKSPACE_TOOL_OPTIONS, asLiteral, boundWorkspaceResult } from "./WorkspaceTools.ts"
import type { WorkspaceToolCall, WorkspaceToolResult } from "./WorkspaceTools.ts"

const DISCARDED = "discarded"
const NEWEST_TURN = "newest-turn"
const WORKING_DIRECTORY = "/workspace"
export const SCRIPT_OUTPUT_DIRECTORY = "/workspace/.scripts"

const isScriptOutputPath = (path: string): boolean =>
	path.startsWith(`${SCRIPT_OUTPUT_DIRECTORY}/`) && !path.split("/").includes("..")

const failed = (text: string): WorkspaceToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
})

const isMissing = (error: unknown): boolean =>
	Predicate.hasProperty(error, "code") && error.code === "ENOENT"

const openWorkspace = async (storage: DurableObjectStorageLike) => {
	const [{ Workspace }, { createPiTools }] = await Promise.all([
		import("@cloudflare/computer"),
		import("@cloudflare/computer/tools/pi-ai"),
	])
	const { fs } = new Workspace({ storage })
	return { fs, ...createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: { fs } }) }
}

const keepWorkingDirectory = (fs: Awaited<ReturnType<typeof openWorkspace>>["fs"]) =>
	fs.stat(WORKING_DIRECTORY).then(
		() => undefined,
		async (error: unknown) => {
			if (!isMissing(error)) {
				throw error
			}
			await fs.mkdir(WORKING_DIRECTORY, { recursive: true })
		},
	)

export class SessionWorkspace extends Cloudflare.DurableObject<SessionWorkspace>()(
	"SessionWorkspace",
	Effect.map(Cloudflare.DurableObjectState, (state) =>
		Effect.sync(() => {
			const { storage } = state.raw
			const fence = makeTurnFence({
				get: () => storage.kv.get<TurnToken>(NEWEST_TURN),
				put: (token) => storage.kv.put(NEWEST_TURN, token),
			})
			let opened: ReturnType<typeof openWorkspace> | undefined
			const workspace = async () => {
				opened ??= openWorkspace(storage)
				return opened.catch((error: unknown) => {
					opened = undefined
					throw error
				})
			}
			const outputs = async () => {
				const { fs } = await workspace()
				return makeSessionOutputs({
					list: (directory, limit) => fs.find(directory, undefined, { limit }),
					size: async (file) => (await fs.stat(file)).size,
					read: async (file) =>
						new Uint8Array(await new Response(await fs.readFile(file)).arrayBuffer()),
				})
			}

			return {
				enter: (token: TurnToken): Effect.Effect<boolean> =>
					Effect.promise(
						async () =>
							storage.kv.get(DISCARDED) !== true &&
							(await fence.enter(token)) &&
							storage.kv.get(DISCARDED) !== true,
					),
				runTool: (call: WorkspaceToolCall, token: TurnToken): Effect.Effect<WorkspaceToolResult> =>
					Effect.promise(async (abortSignal) => {
						if (storage.kv.get(DISCARDED) === true) {
							return failed("The session has ended and its workspace was discarded.")
						}
						const result = await fence.run(token, async () => {
							const { fs, execute } = await workspace()
							await keepWorkingDirectory(fs)
							const { content, isError } = await execute(asLiteral(call), { abortSignal })
							return boundWorkspaceResult(call.name, { content, isError })
						})
						return (
							result ?? failed("This turn has ended; the workspace no longer accepts its calls.")
						)
					}),
				listOutputs: (turn: number): Effect.Effect<OutputsListing | null> =>
					Effect.promise(async () =>
						storage.kv.get(DISCARDED) === true
							? { ok: true, files: [] }
							: ((await fence.run({ turn }, async () => (await outputs()).list())) ?? null),
					),
				readOutputs: (
					turn: number,
					paths: ReadonlyArray<string>,
				): Effect.Effect<ReadonlyArray<OutputBytes> | null> =>
					Effect.promise(async () =>
						storage.kv.get(DISCARDED) === true
							? []
							: ((await fence.run({ turn }, async () => (await outputs()).read(paths))) ?? null),
					),
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
							const { fs } = await workspace()
							await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true })
							await fs.writeFile(path, content)
							return true
						})
						return written === undefined
							? "This turn has ended; the workspace no longer accepts its calls."
							: undefined
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
