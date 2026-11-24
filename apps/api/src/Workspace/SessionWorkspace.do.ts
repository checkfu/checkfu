import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { admitGeneration } from "./WorkspaceFence.ts"
import type { FenceStore } from "./WorkspaceFence.ts"
import type { WorkspaceToolCall, WorkspaceToolResult } from "./WorkspaceTools.ts"

const DISCARDED = "discarded"
const GENERATION = "generation"
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
			const fence: FenceStore = {
				get: () => storage.kv.get<number>(GENERATION),
				put: (generation) => storage.kv.put(GENERATION, generation),
			}
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
				// A new turn retires the harness generations before it.
				enter: (generation: number): Effect.Effect<void> =>
					Effect.sync(() => {
						admitGeneration(fence, generation)
					}),
				runTool: (
					call: WorkspaceToolCall,
					generation: number,
				): Effect.Effect<WorkspaceToolResult> =>
					Effect.promise(async (abortSignal) => {
						if (storage.kv.get(DISCARDED) === true) {
							return failed("The session has ended and its workspace was discarded.")
						}
						if (!admitGeneration(fence, generation)) {
							return failed("This turn was abandoned; the workspace no longer accepts its calls.")
						}
						await initialize()
						const { content, isError } = await execute(call, { abortSignal })
						return { content, isError }
					}),
				// The marker goes first and stays: from it on every call is refused, also while the
				// files are removed, after a reset part way through, and on a second delivery.
				discard: (): Effect.Effect<void> =>
					Effect.promise(async () => {
						storage.kv.put(DISCARDED, true)
						for (const entry of await fs.readdir("/")) {
							await fs.rm(`/${entry.name}`, { recursive: true, force: true })
						}
						for (const [key] of storage.kv.list()) {
							if (key !== DISCARDED) {
								storage.kv.delete(key)
							}
						}
					}),
			}
		}),
	),
) {}
