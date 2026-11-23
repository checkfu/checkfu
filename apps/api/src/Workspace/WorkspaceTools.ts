import type { PiTool, PiToolCall, PiToolResult } from "@cloudflare/computer/tools/pi-ai"
import type { Extension, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable"
import * as Schema from "effect/Schema"

export type WorkspaceTool = PiTool
export type WorkspaceToolCall = Required<PiToolCall>
export type WorkspaceToolResult = Pick<PiToolResult, "content" | "isError">

export const WORKSPACE_EXTENSION = "checkfu.workspace"

// Only a call that changes nothing may run again after it was cut off. Pi runs the calls of one
// round in parallel, so a write or a delete run a second time can undo what a sibling call did
// after it; the model is told such a call was interrupted instead.
const REPLAY_SAFE: ReadonlySet<string> = new Set(["read", "ls", "find", "grep"])

const WORKSPACE_PROMPT =
	"You have a durable workspace that lasts for the whole session. Its working directory is /workspace. Use the read, ls, find, grep, write, edit and delete tools with absolute paths, and the git tool for version control."

export const GIT_TOOL: WorkspaceTool = {
	name: "git",
	description:
		'Run a git command in the workspace. `args` is everything after `git`, one argument per item, for example ["status"] or ["commit", "-m", "Fix the parser"]. `cwd` is the absolute path of the repository to run it in. fetch, pull and push reach only the repositories mounted in this session, and their credentials are supplied for you.',
	parameters: {
		type: "object",
		properties: {
			args: { type: "array", items: { type: "string" }, minItems: 1 },
			cwd: { type: "string" },
		},
		required: ["args", "cwd"],
		additionalProperties: false,
	},
}

export const decodeGitToolArguments = Schema.decodeUnknownOption(
	Schema.Struct({
		args: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
		cwd: Schema.String.check(Schema.isMinLength(1)),
	}),
)

/**
 * The largest image `read` sends inline. A tool result is stored as one row of the session's
 * storage, which holds 2 MB; the default 3.5 MiB is about 4.9 MB once base64-encoded. A larger
 * image comes back as text saying so.
 */
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024

// Pi keeps the head of a tool result up to its output limits and drops the rest. A paged result
// is JSON with its continuation offsets after the content, so a cut result loses them: every
// result is made to fit instead. Pi's own default for a tool's text is 50 KB in 2,000 lines.
const RESULT_BYTES = 50 * 1024
const RESULT_LINES = 2000

// A page of `read` is sent as a JSON string. Escaping turns one byte into at most six characters
// (a control character as \u00XX), and the page's offsets and flags follow it.
const READ_PAGE_BYTES = 48 * 1024
const READ_RESULT_BYTES = READ_PAGE_BYTES * 6 + 4 * 1024

export const WORKSPACE_TOOL_OPTIONS = {
	read: {
		maxModelBytes: MAX_INLINE_IMAGE_BYTES,
		maxBytes: READ_PAGE_BYTES,
		maxLines: RESULT_LINES,
		// A longer line is cut with a marker, as Claude Code's Read cuts it, so no line is too long
		// to read and the page goes on after it.
		lineTruncation: { chars: 2000 },
	},
} as const

/** What Pi keeps of a workspace tool's result: a result the workspace returns always fits it. */
export const workspaceOutputLimits = (tool: string) =>
	({
		maxBytes: tool === "read" ? READ_RESULT_BYTES : RESULT_BYTES,
		maxLines: RESULT_LINES,
	}) as const

/**
 * A result over its tool's limits, `grep` with long matching lines and context, say, is refused
 * in the workspace: Pi would cut it, and one large enough would not cross between the objects.
 */
const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).byteLength

const textOf = (result: WorkspaceToolResult): string =>
	result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

// A field this small is kept when a result has to be shortened: counts, paths and flags.
const KEPT_FIELD_BYTES = 1024

// The start of a text, cut to at most `bytes`. A streaming decoder holds back a character the
// cut would split instead of emitting a replacement for it.
const headOf = (text: string, bytes: number): string =>
	new TextDecoder().decode(encoder.encode(text).subarray(0, bytes), { stream: true })

type OutputLimits = ReturnType<typeof workspaceOutputLimits>

const fits = (text: string, { maxBytes, maxLines }: OutputLimits): boolean =>
	byteLength(text) <= maxBytes && text.split("\n").length <= maxLines

const succeeded = (text: string): WorkspaceToolResult => ({
	content: [{ type: "text", text }],
	isError: false,
})

// A change was made, so its result stays a success: what is too large to return is left out, and
// the model is told so rather than told the change failed. Whatever is built is measured against
// both limits before it is returned.
const acknowledge = (tool: string, text: string, limits: OutputLimits): WorkspaceToolResult => {
	const fields = Option.getOrUndefined(Schema.decodeOption(JsonObject)(text))
	if (fields !== undefined) {
		const small = ([, value]: readonly [string, unknown]) =>
			byteLength(JSON.stringify(value) ?? "") <= KEPT_FIELD_BYTES
		const entries = Object.entries(fields)
		const kept = Object.fromEntries(entries.filter(small))
		const omitted = entries.filter((entry) => !small(entry)).map(([key]) => key)
		const note = `${tool} succeeded. Left out as too large to return: ${omitted.join(", ")}.`
		const shortened = JSON.stringify({ ...kept, note })
		if (fits(shortened, limits)) {
			return succeeded(shortened)
		}
	}
	// The notice takes one line and well under 256 bytes.
	const lines = text.split("\n")
	const shown = headOf(lines.slice(0, limits.maxLines - 1).join("\n"), limits.maxBytes - 256)
	return succeeded(
		`${shown}\n[${tool} succeeded. ${byteLength(text) - byteLength(shown)} more bytes of its output are not shown.]`,
	)
}

/**
 * Holds a result to its tool's limits before it leaves the workspace: Pi would cut a larger one,
 * and one large enough would not cross between the objects. A call that only reads asks for less;
 * a call that changed something stays a success, shortened.
 */
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
		return acknowledge(tool, text, limits)
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

// The tools' declarations do not read the filesystem, so the session builds them without its
// workspace: reading a turn that already ended must not wait for another object.
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

export const workspaceToolDeclarations = async (): Promise<ReadonlyArray<WorkspaceTool>> => {
	const { createPiTools } = await import("@cloudflare/computer/tools/pi-ai")
	return [
		...createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: DECLARATIONS_ONLY }).tools,
		GIT_TOOL,
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
			// An interrupted turn sends nothing more to its workspace.
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
