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
import {
	ARTIFACT_DATA_OPERATIONS,
	DEFAULT_ARTIFACT_DATA_LIMIT,
	MAX_ARTIFACT_DATA_LIMIT,
	MAX_TOOL_ARTIFACT_FILE_BYTES,
	MAX_TOOL_ARTIFACT_FILES,
	MAX_TOOL_ARTIFACT_TOTAL_BYTES,
} from "./SessionArtifactTool.ts"

export type WorkspaceTool = PiTool
export type WorkspaceToolCall = Required<PiToolCall>
export type WorkspaceToolResult = Pick<PiToolResult, "content" | "isError">

export const WORKSPACE_EXTENSION = "checkfu.workspace"

const REPLAY_SAFE: ReadonlySet<string> = new Set(["read", "ls", "find", "grep"])

const MEBIBYTE = 1024 * 1024

const WORKSPACE_PROMPT = `You have a durable workspace that lasts for the whole session. Its working directory is /workspace. Use the read, ls, find, grep, write, edit and delete tools with absolute paths, and the bash tool to run commands. Files you leave in ${SESSION_OUTPUTS_PATH} are saved for the user after each completed turn. Put there what the user should keep. A file over ${MAX_OUTPUT_FILE_BYTES / MEBIBYTE} MiB, or past ${MAX_OUTPUT_TOTAL_BYTES / MEBIBYTE} MiB in total, is not saved. With more than ${MAX_OUTPUT_FILES} files, or more than ${MAX_OUTPUT_ENTRIES} files and folders counted together, none are. A file you remove is no longer listed for the user.`

export const BASH_SECONDS = 120
export const MAX_BASH_SECONDS = 600

export const BASH_TOOL: WorkspaceTool = {
	name: "bash",
	description: `Run a command with bash in the session's Linux machine, which starts the first time this is called. \`cwd\` is the directory to run in, /workspace when left out. Use /workspace for working files. Write deliverables to ${SESSION_OUTPUTS_PATH} to save them for the user after the turn completes. The machine and the file tools share both directories. The machine saves both when it sleeps after a period of inactivity. Running processes stop, and files and installations elsewhere on the machine are lost. Keep a setup script in /workspace. Access attached artifacts, uploaded files, memory stores and skills with the file tools, and copy files you need for Bash into /workspace first. git, node, npm, python3 (without pip), ripgrep, jq, curl, unzip and zstd are installed, and only HTTP and HTTPS leave the machine, to the hosts the session's environment allows: clone over https, not ssh. The credentials of the repositories mounted in this session are added to their requests for you; they are never inside the machine. stdout and stderr come back together, and only the end of a long output is returned: send it to a file and read that when you need all of it. \`timeout\` is in seconds, ${BASH_SECONDS} when left out and at most ${MAX_BASH_SECONDS}. A command still running then is stopped, so start a server in the background with its output sent to a file. Once the machine has started, list a very large directory with find in a command: the find tool walks at most 100,000 files and directories.`,
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

export const ARTIFACT_TOOL: WorkspaceTool = {
	name: "save_artifact",
	description: `Save files from /workspace or /mnt/session/outputs as an artifact the user can open, share or publish after the session. Pass an absolute directory and a name. Reusing the name adds a version when the files or source change. Pages start at index.html. An optional artifact.json declares document collections, for example {"capabilities":{"database":{"collections":{"responses":{"visitors":"add"}}}}}. Visitor modes are none, read, add (submit only) and write. The page loads <script src="_/data.js"></script> and calls artifactData.collection("responses").add(value), .list(), .get(id), .put(id, value) or .delete(id) with the access granted when shared. Lists return data and next_page. Deletes and add-only submissions return receipts with the document ID. Other document reads and writes return the stored document. To start from an attached artifact, pass its mount path as made_from, such as /mnt/artifacts/document. Read its README.md for the content it expects. Leave inherited paths and artifact.json out of your directory. Use an existing empty directory if the active source supplies every file. Include source files in the limits of ${MAX_TOOL_ARTIFACT_FILES} regular files, ${MAX_TOOL_ARTIFACT_FILE_BYTES / MEBIBYTE} MiB each and ${MAX_TOOL_ARTIFACT_TOTAL_BYTES / MEBIBYTE} MiB total.`,
	parameters: {
		type: "object",
		properties: {
			name: { type: "string" },
			directory: { type: "string" },
			made_from: { type: "string" },
		},
		required: ["name", "directory"],
		additionalProperties: false,
	},
}

export const ARTIFACT_DATA_TOOL: WorkspaceTool = {
	name: "artifact_data",
	description: `Read or write the data of an artifact you saved in this session with save_artifact: the documents its page reaches through artifactData. Use it to fill a dashboard's numbers or to read what a form collected. \`name\` is the artifact's name and \`collection\` one of its collections. \`operation\` is list, get, add, put or delete: list returns documents oldest first, up to \`limit\` (${DEFAULT_ARTIFACT_DATA_LIMIT} when left out, at most ${MAX_ARTIFACT_DATA_LIMIT}), with a next_page to pass as \`page\`; get, put and delete take the document's \`id\`; add and put take \`data\`, any JSON value, and put stores it under an id you choose. Use the same \`key\` when repeating an add to avoid another document. Large responses give a workspace \`path\`. Use read on that path and pass next_byte_offset as byteOffset to retrieve subsequent JSON chunks. You may use any collection.`,
	parameters: {
		type: "object",
		properties: {
			name: { type: "string" },
			collection: { type: "string" },
			operation: { type: "string", enum: [...ARTIFACT_DATA_OPERATIONS] },
			id: { type: "string" },
			data: {},
			key: { type: "string" },
			page: { type: "string" },
			limit: { type: "integer", minimum: 1, maximum: MAX_ARTIFACT_DATA_LIMIT },
		},
		required: ["name", "collection", "operation"],
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
		ARTIFACT_TOOL,
		ARTIFACT_DATA_TOOL,
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
