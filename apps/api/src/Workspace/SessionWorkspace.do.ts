import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { makeTurnFence } from "./WorkspaceFence.ts"
import type { TurnToken } from "./WorkspaceFence.ts"
import { purgeTables } from "./WorkspaceStorage.ts"
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
			// Load workerd-only modules after Alchemy has evaluated the stack.
			const [{ Workspace }, { createPiTools }] = await Promise.all([
				import("@cloudflare/computer"),
				import("@cloudflare/computer/tools/pi-ai"),
			])
			const { storage } = state.raw
			const { fs } = new Workspace({ storage })
			const { execute } = createPiTools({ workspace: { fs } })
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

			return {
				// A new turn retires every turn before it. A turn that is no longer current, or one
				// of an ended session, is refused before it asks a model anything.
				enter: (token: TurnToken): Effect.Effect<boolean> =>
					Effect.promise(
						async () => storage.kv.get(DISCARDED) !== true && (await fence.enter(token)),
					),
				runTool: (call: WorkspaceToolCall, token: TurnToken): Effect.Effect<WorkspaceToolResult> =>
					Effect.promise(async (abortSignal) => {
						if (storage.kv.get(DISCARDED) === true) {
							return failed("The session has ended and its workspace was discarded.")
						}
						const result = await fence.run(token, async () => {
							await initialize()
							const { content, isError } = await execute(call, { abortSignal })
							return { content, isError }
						})
						return (
							result ?? failed("This turn has ended; the workspace no longer accepts its calls.")
						)
					}),
				// The marker goes first and stays: from it on every call is refused, also while the
				// files are removed, after a reset part way through, and on a second delivery.
				discard: (): Effect.Effect<void> =>
					Effect.promise(async () => {
						storage.kv.put(DISCARDED, true)
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
