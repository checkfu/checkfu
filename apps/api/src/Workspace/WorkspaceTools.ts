import type { PiTool, PiToolCall, PiToolResult } from "@cloudflare/computer/tools/pi-ai"
import type { Extension, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable"
import * as Predicate from "effect/Predicate"
import {
	MAX_OUTPUT_ENTRIES,
	MAX_OUTPUT_FILES,
	MAX_OUTPUT_FILE_BYTES,
	MAX_OUTPUT_TOTAL_BYTES,
	SESSION_OUTPUTS_PATH,
} from "./SessionOutputs.ts"
import * as Schema from "effect/Schema"

export type WorkspaceTool = PiTool
export type WorkspaceToolCall = Required<PiToolCall>
export type WorkspaceToolResult = Pick<PiToolResult, "content" | "isError">

export const WORKSPACE_EXTENSION = "checkfu.workspace"

const REPLAY_SAFE: ReadonlySet<string> = new Set(["read", "ls", "find", "grep"])

const MEBIBYTE = 1024 * 1024

const WORKSPACE_PROMPT = `You have a durable workspace that lasts for the whole session. Its working directory is /workspace. Use the read, ls, find, grep, write, edit and delete tools with absolute paths, and the bash tool to run commands. Files you leave in ${SESSION_OUTPUTS_PATH} are published as this session's artifact each time your turn ends, so put there what the user should keep. The directory holds at most ${MAX_OUTPUT_FILES} files, ${MAX_OUTPUT_FILE_BYTES / MEBIBYTE} MiB each and ${MAX_OUTPUT_TOTAL_BYTES / MEBIBYTE} MiB in total, and at most ${MAX_OUTPUT_ENTRIES} files and folders counted together; beyond that, nothing is published. An empty directory publishes nothing either, so the last version stays.`

export const BASH_SECONDS = 120
export const MAX_BASH_SECONDS = 600

export const BASH_TOOL: WorkspaceTool = {
	name: "bash",
	description: `Run a command with bash in the session's Linux machine, which starts the first time this is called. \`cwd\` is the directory to run in, /workspace when left out. The machine and the file tools share /workspace, and /workspace is all the machine keeps: after a while without use it is put to sleep, and when it wakes every process has stopped and whatever was installed or written outside /workspace is gone, so keep what sets it up in a script there. A command does not see /mnt, so copy what it needs into /workspace first. git, node, python3, ripgrep and curl are installed, and only HTTP and HTTPS leave the machine, to the hosts the session's environment allows: clone over https, not ssh. The credentials of the repositories mounted in this session are added to their requests for you; they are never inside the machine. stdout and stderr come back together, and only the end of a long output is returned: send it to a file and read that when you need all of it. \`timeout\` is in seconds, ${BASH_SECONDS} when left out and at most ${MAX_BASH_SECONDS}. A command still running then is stopped, so start a server in the background with its output sent to a file. Once the machine has started, list a very large directory with find in a command: the find tool walks at most 100,000 files and directories.`,
	parameters: {
		type: "object",
		properties: {
			command: { type: "string" },
			cwd: { type: "string" },
			timeout: { type: "integer", minimum: 1, maximum: MAX_BASH_SECONDS },
		},
		required: ["command"],
		additionalProperties: false,
	},
}

export const decodeBashToolArguments = Schema.decodeUnknownOption(
	Schema.Struct({
		command: Schema.String.check(Schema.isMinLength(1)),
		cwd: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
		timeout: Schema.optionalKey(
			Schema.Int.check(
				Schema.isGreaterThanOrEqualTo(1),
				Schema.isLessThanOrEqualTo(MAX_BASH_SECONDS),
			),
		),
	}),
)

export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024

const RESULT_BYTES = 50 * 1024
const RESULT_LINES = 2000

export const COMMAND_OUTPUT_BYTES = RESULT_BYTES - 2 * 1024
export const COMMAND_OUTPUT_LINES = RESULT_LINES - 10

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
	"Search workspace text for a string, matched as written. Results include paths and line numbers and can include surrounding lines. For a regular expression, or a large tree once the machine has started, run rg with bash."
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
	return [
		...createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: DECLARATIONS_ONLY }).tools.map(
			asDeclared,
		),
		BASH_TOOL,
	]
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
