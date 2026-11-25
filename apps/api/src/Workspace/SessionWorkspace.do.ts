import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { makeTurnFence } from "./WorkspaceFence.ts"
import type { TurnToken } from "./WorkspaceFence.ts"
import { purgeTables } from "./WorkspaceStorage.ts"
import { grepWithin, refusedFind } from "./WorkspacePaging.ts"
import {
	WORKSPACE_TOOL_OPTIONS,
	boundWorkspaceResult,
	workspaceOutputLimits,
} from "./WorkspaceTools.ts"
import type { WorkspaceToolCall, WorkspaceToolResult } from "./WorkspaceTools.ts"

const DISCARDED = "discarded"
const NEWEST_TURN = "newest-turn"
const INITIALIZED = "initialized"
const WORKING_DIRECTORY = "/workspace"

const failed = (text: string): WorkspaceToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
})

export class SessionWorkspace extends Cloudflare.DurableObject<SessionWorkspace>()(
	"SessionWorkspace",
	Effect.map(Cloudflare.DurableObjectState, (state) =>
		Effect.promise(async () => {
			const [{ Workspace }, { createPiTools }] = await Promise.all([
				import("@cloudflare/computer"),
				import("@cloudflare/computer/tools/pi-ai"),
			])
			const { storage } = state.raw
			const { fs } = new Workspace({ storage })
			const { execute } = createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: { fs } })
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
							await initialize()
							const { content, isError } =
								call.name === "grep"
									? await grepWithin(fs, call.arguments, workspaceOutputLimits("grep").maxBytes)
									: ((call.name === "find" ? refusedFind(call.arguments) : undefined) ??
										(await execute(call, { abortSignal })))
							return boundWorkspaceResult(call.name, { content, isError })
						})
						return (
							result ?? failed("This turn has ended; the workspace no longer accepts its calls.")
						)
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
