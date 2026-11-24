import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { admitGeneration } from "./WorkspaceFence.ts"
import type { FenceStore } from "./WorkspaceFence.ts"
import type { WorkspaceTool, WorkspaceToolCall, WorkspaceToolResult } from "./WorkspaceTools.ts"

const DISCARDED = "discarded"
const GENERATION = "generation"
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
			const { tools, execute } = createPiTools({ workspace: { fs } })
			const fence: FenceStore = {
				get: () => storage.kv.get<number>(GENERATION),
				put: (generation) => storage.kv.put(GENERATION, generation),
			}
			// The prompt names this directory, so it exists before the first tool call.
			if (storage.kv.get(DISCARDED) !== true) {
				await fs.mkdir(WORKING_DIRECTORY, { recursive: true })
			}

			return {
				// A harness asks for the tools when it opens, which retires the generations before it.
				tools: (generation: number): Effect.Effect<ReadonlyArray<WorkspaceTool>> =>
					Effect.sync(() => {
						admitGeneration(fence, generation)
						return tools
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
						const { content, isError } = await execute(call, { abortSignal })
						return { content, isError }
					}),
				discard: (): Effect.Effect<void> =>
					Effect.promise(async () => {
						await storage.deleteAll()
						storage.kv.put(DISCARDED, true)
					}),
			}
		}),
	),
) {}
