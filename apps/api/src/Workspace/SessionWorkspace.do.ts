import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import type { WorkspaceTool, WorkspaceToolCall, WorkspaceToolResult } from "./WorkspaceTools.ts"

const DISCARDED = "discarded"

const DISCARDED_RESULT: WorkspaceToolResult = {
	content: [{ type: "text", text: "The session has ended and its workspace was discarded." }],
	isError: true,
}

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

			return {
				tools: (): Effect.Effect<ReadonlyArray<WorkspaceTool>> => Effect.succeed(tools),
				runTool: (call: WorkspaceToolCall): Effect.Effect<WorkspaceToolResult> =>
					Effect.promise(async (abortSignal) => {
						if (storage.kv.get(DISCARDED) === true) {
							return DISCARDED_RESULT
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
