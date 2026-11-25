import type { PiTool, PiToolCall, PiToolResult } from "@cloudflare/computer/tools/pi-ai"
import type { Extension, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable"
import * as Predicate from "effect/Predicate"

export type WorkspaceTool = PiTool
export type WorkspaceToolCall = Required<PiToolCall>
export type WorkspaceToolResult = Pick<PiToolResult, "content" | "isError">

export const WORKSPACE_EXTENSION = "checkfu.workspace"

const REPLAY_SAFE: ReadonlySet<string> = new Set(["read", "ls", "find", "grep"])

const WORKSPACE_PROMPT =
	"You have a durable workspace that lasts for the whole session. Its working directory is /workspace. Use the read, ls, find, grep, write, edit and delete tools with absolute paths."

export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024

const RESULT_BYTES = 50 * 1024
const RESULT_LINES = 2000

export const READ_PAGE_BYTES = 48 * 1024
const READ_RESULT_BYTES = READ_PAGE_BYTES * 6 + 4 * 1024

const DIFF_BYTES = 12 * 1024

export const WORKSPACE_TOOL_OPTIONS = {
	edit: { maxDiffBytes: DIFF_BYTES },
	read: {
		maxModelBytes: MAX_INLINE_IMAGE_BYTES,
		maxBytes: READ_PAGE_BYTES,
		maxLines: RESULT_LINES,
		lineTruncation: { chars: 2000 },
	},
} as const

export const workspaceOutputLimits = (tool: string) =>
	({
		maxBytes: tool === "read" ? READ_RESULT_BYTES : RESULT_BYTES,
		maxLines: RESULT_LINES,
	}) as const

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).byteLength

const textOf = (result: WorkspaceToolResult): string =>
	result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

type OutputLimits = ReturnType<typeof workspaceOutputLimits>

const fits = (text: string, { maxBytes, maxLines }: OutputLimits): boolean =>
	byteLength(text) <= maxBytes && text.split("\n").length <= maxLines

export const boundWorkspaceResult = (
	tool: string,
	result: WorkspaceToolResult,
): WorkspaceToolResult => {
	const limits = workspaceOutputLimits(tool)
	const { maxBytes, maxLines } = limits
	const text = textOf(result)
	if (fits(text, limits)) {
		return result
	}
	const bytes = byteLength(text)
	const lines = text.split("\n").length
	if (!result.isError && !REPLAY_SAFE.has(tool)) {
		return result
	}
	return {
		content: [
			{
				type: "text",
				text: `${tool} returned ${bytes} bytes in ${lines} lines, more than the ${maxBytes} bytes or ${maxLines} lines one call can return. Ask for less: a narrower path or pattern, a lower limit, fewer context lines, or a later offset.`,
			},
		],
		isError: true,
	}
}

const declaredOnly = (): Promise<never> =>
	Promise.reject(new Error("Workspace tools run in the session's workspace, not here."))

const DECLARATIONS_ONLY = {
	fs: {
		stat: declaredOnly,
		readFile: declaredOnly,
		writeFile: declaredOnly,
		mkdir: declaredOnly,
		rm: declaredOnly,
		find: declaredOnly,
		grep: declaredOnly,
		readdir: declaredOnly,
	},
}

export const asLiteral = (call: WorkspaceToolCall): WorkspaceToolCall =>
	call.name === "grep" && Predicate.isObject(call.arguments)
		? { ...call, arguments: { ...call.arguments, regex: false } }
		: call

const GREP_DESCRIPTION =
	"Search workspace text for a string, matched as written. Results include paths and line numbers and can include surrounding lines."
const GREP_QUERY = "Text to search for, matched as written."

const asDeclared = (tool: WorkspaceTool): WorkspaceTool => {
	if (tool.name !== "grep") {
		return tool
	}
	const properties = Object.entries(tool.parameters.properties ?? {}).flatMap(
		([name, schema]): Array<[string, unknown]> =>
			name === "regex"
				? []
				: [[name, name === "query" ? { type: "string", description: GREP_QUERY } : schema]],
	)
	return {
		...tool,
		description: GREP_DESCRIPTION,
		parameters: { ...tool.parameters, properties: Object.fromEntries(properties) },
	}
}

export const workspaceToolDeclarations = async (): Promise<ReadonlyArray<WorkspaceTool>> => {
	const { createPiTools } = await import("@cloudflare/computer/tools/pi-ai")
	return createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: DECLARATIONS_ONLY }).tools.map(
		asDeclared,
	)
}

const INTERRUPTED: ToolExecutionResult = {
	output: [{ type: "text", text: "The turn was interrupted before this call ran." }],
	isError: true,
}

export const workspaceExtension = (
	tools: ReadonlyArray<WorkspaceTool>,
	run: (call: WorkspaceToolCall, signal: AbortSignal | undefined) => Promise<WorkspaceToolResult>,
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
		outputLimits: workspaceOutputLimits(tool.name),
		execute: async (args, api, context) => {
			if (context.abortSignal?.aborted === true) {
				return INTERRUPTED
			}
			const { content, isError } = await run(
				{ id: api.callId, name: tool.name, arguments: args },
				context.abortSignal,
			)
			return { output: content, isError }
		},
	})),
})
