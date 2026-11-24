import type { PiTool, PiToolCall, PiToolResult } from "@cloudflare/computer/tools/pi-ai"
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable"

export type WorkspaceTool = PiTool
export type WorkspaceToolCall = Required<PiToolCall>
export type WorkspaceToolResult = Pick<PiToolResult, "content" | "isError">

export const WORKSPACE_EXTENSION = "checkfu.workspace"

// Only a call that changes nothing may run again after it was cut off. Pi runs the calls of one
// round in parallel, so a write or a delete run a second time can undo what a sibling call did
// after it; the model is told such a call was interrupted instead.
const REPLAY_SAFE: ReadonlySet<string> = new Set(["read", "ls", "find", "grep"])

const WORKSPACE_PROMPT =
	"You have a durable workspace that lasts for the whole session. Its working directory is /workspace. Use the read, ls, find, grep, write, edit and delete tools with absolute paths."

export const workspaceExtension = (
	tools: ReadonlyArray<WorkspaceTool>,
	run: (call: WorkspaceToolCall) => Promise<WorkspaceToolResult>,
): Extension => ({
	name: WORKSPACE_EXTENSION,
	sections: [{ key: "workspace", render: () => WORKSPACE_PROMPT }],
	tools: tools.map((tool): ToolRegistration => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.constrainedSampling === undefined
			? {}
			: { constrainedSampling: tool.constrainedSampling }),
		replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
		execute: async (args, api) => {
			const { content, isError } = await run({
				id: api.callId,
				name: tool.name,
				arguments: args,
			})
			return { output: content, isError }
		},
	})),
})
