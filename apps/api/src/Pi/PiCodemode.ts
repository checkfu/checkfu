import * as Cloudflare from "@alchemy.run/cloudflare"
import type {
	CodemodeHostCall,
	CodemodeRemoteExchange,
	CodemodeRemoteRequest,
	CodemodeResult,
	CodemodeRunOptions,
	CodemodeSandboxBase,
} from "@earendil-works/pi-codemode/portable"
import { ToolTask, defineExtension, hook } from "@earendil-works/pi-durable"
import type { Extension, ToolExecutionResult } from "@earendil-works/pi-durable"
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env"
import type { ExecutionEnv, Result } from "@earendil-works/pi-durable/env"
import type * as CodemodeSource from "@earendil-works/pi-codemode/source"
import type * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { COMPATIBILITY_DATE } from "../Compatibility.ts"
import { hostOf } from "../WorkerHost.ts"
import { SCRIPT_OUTPUT_DIRECTORY } from "../Workspace/SessionWorkspace.do.ts"

export const SCRIPT_DEADLINE = { defaultMs: 120_000, maxMs: 300_000 } as const

export const SCRIPT_LIMITS = {
	callArgumentBytes: 512 * 1024,
	argumentBytes: 1024 * 1024,
	toolCalls: 64,
	globalCalls: 128,
	maxOutputTokens: 32_000,
	resultBytes: 512 * 1024,
	storeBytes: 256 * 1024,
} as const

export type ScriptLimits = { readonly [Key in keyof typeof SCRIPT_LIMITS]: number }

export type ScriptDeadline = { readonly defaultMs: number; readonly maxMs: number }

const SANDBOX_CLASS = "CodemodeSandbox"

const IMAGE_LABEL_BYTES = 512

export const CodemodeSandboxWorker = Cloudflare.Worker("CodemodeSandboxWorker", {
	main: new URL("./PiCodemodeSandboxWorker.ts", import.meta.url).href,
	compatibility: { date: COMPATIBILITY_DATE },
	workersDev: false,
	codeUpdateStrategy: { mode: "deferred", maxDelay: "6 minutes" },
	env: { [SANDBOX_CLASS]: Cloudflare.DurableObject(SANDBOX_CLASS) },
	observability: { enabled: true },
	dev: { port: 1342 },
})

export class CodemodeSandbox extends Cloudflare.DurableObject<
	CodemodeSandbox,
	{
		readonly execute: (
			request: CodemodeRemoteRequest,
			exchange: CodemodeRemoteExchange,
		) => Effect.Effect<void>
	}
>()(SANDBOX_CLASS) {}

export const codemodeSandboxes = CodemodeSandbox.from(
	hostOf<CodemodeSandbox, typeof CodemodeSandboxWorker>(CodemodeSandboxWorker),
)

const serializedBytes = (value: unknown): number =>
	new TextEncoder().encode(JSON.stringify(value) ?? "").length

export type ScriptSource = Pick<
	typeof CodemodeSource,
	"parseCodemodeSource" | "CODEMODE_OPTIONS_PREFIX"
>

export const clampScriptOptions = (
	{ parseCodemodeSource, CODEMODE_OPTIONS_PREFIX }: ScriptSource,
	source: string,
	deadline: ScriptDeadline = SCRIPT_DEADLINE,
	maxOutputTokens: number = SCRIPT_LIMITS.maxOutputTokens,
): string | undefined => {
	let parsed: ReturnType<ScriptSource["parseCodemodeSource"]>
	try {
		parsed = parseCodemodeSource(source)
	} catch {
		return undefined
	}
	const asked = parsed.options
	const tokens =
		asked.maxOutputTokens === undefined
			? undefined
			: Math.min(asked.maxOutputTokens, maxOutputTokens)
	const timeout = Math.min(asked.timeoutMs ?? deadline.defaultMs, deadline.maxMs)
	if (tokens === asked.maxOutputTokens && timeout === asked.timeoutMs) {
		return undefined
	}
	const line = `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify({
		...(tokens === undefined ? {} : { max_output_tokens: tokens }),
		timeout_ms: timeout,
	})}`
	return parsed.code === source ? `${line}\n${source}` : `${line}${parsed.code}`
}

const callName = (call: CodemodeHostCall): string =>
	call.target === "tool" ? `tools.${call.name}` : `${call.name}()`

const callLimits = (limits: ScriptLimits) => {
	let argumentBytes = 0
	let toolCalls = 0
	let globalCalls = 0
	return (call: CodemodeHostCall): string | undefined => {
		const bytes = serializedBytes(call.args ?? {})
		const name = callName(call)
		if (bytes > limits.callArgumentBytes) {
			return `${name} passed ${bytes} bytes of arguments, and one call may pass at most ${limits.callArgumentBytes}. Pass less at a time.`
		}
		if (argumentBytes + bytes > limits.argumentBytes) {
			return `${name} would bring the script's arguments past ${limits.argumentBytes} bytes. Do the rest in another script.`
		}
		if (call.target === "tool" && toolCalls >= limits.toolCalls) {
			return `${name} went past the ${limits.toolCalls} tool calls one script may make. Do the rest in another script.`
		}
		if (call.target === "global" && globalCalls >= limits.globalCalls) {
			return `${name} went past the ${limits.globalCalls} calls to globals one script may make. Do the rest in another script.`
		}
		argumentBytes += bytes
		toolCalls += call.target === "tool" ? 1 : 0
		globalCalls += call.target === "global" ? 1 : 0
		return undefined
	}
}

const failed = (result: CodemodeResult, name: string, message: string): CodemodeResult => ({
	ok: false,
	error: { kind: "script", name, message },
	output: [],
	calls: result.calls,
	...(result.during === undefined ? {} : { during: result.during }),
})

const stringLength = (value: unknown): number =>
	typeof value === "string" ? value.length : (JSON.stringify(value) ?? "").length

const resultBytes = (result: CodemodeResult, budget: number) => {
	const chars =
		result.output.reduce(
			(total, item) => total + (item.type === "text" ? item.text.length : item.data.length),
			0,
		) +
		(result.ok
			? stringLength(result.value) + stringLength(result.storeWrites)
			: result.error.message.length +
				(result.error.name?.length ?? 0) +
				(result.error.stack?.length ?? 0))
	if (chars > budget) {
		return { bytes: chars, atLeast: true }
	}
	const images = result.output.filter((item) => item.type === "image").length
	return { bytes: serializedBytes(result) + images * IMAGE_LABEL_BYTES, atLeast: false }
}

const boundStore = (
	result: CodemodeResult,
	store: CodemodeRunOptions["store"],
	budget: number,
): CodemodeResult => {
	if (
		!result.ok ||
		(Object.keys(result.storeWrites.set).length === 0 && result.storeWrites.delete.length === 0)
	) {
		return result
	}
	const before = store ?? {}
	const deleted = new Set(result.storeWrites.delete)
	const bytes = serializedBytes({
		...Object.fromEntries(Object.entries(before).filter(([key]) => !deleted.has(key))),
		...result.storeWrites.set,
	})
	return bytes <= budget || bytes <= serializedBytes(before)
		? result
		: {
				ok: false,
				error: {
					kind: "script",
					name: "StoreLimitError",
					message: `The script's store() writes were not kept: the store would hold ${bytes} bytes, more than the ${budget} it keeps. Store less, or delete keys you no longer need.`,
				},
				output: result.output,
				calls: result.calls,
				...(result.during === undefined ? {} : { during: result.during }),
			}
}

export const withScriptBounds = <Sandbox extends CodemodeSandboxBase>(
	sandbox: Sandbox,
	limits: ScriptLimits = SCRIPT_LIMITS,
): Sandbox => {
	const start = sandbox.start.bind(sandbox)
	sandbox.start = (code, options) => {
		const check = callLimits(limits)
		const stop = new AbortController()
		let breach: string | undefined
		const signal =
			options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal])
		const run = start(code, {
			...options,
			signal,
			onCall: (call) => {
				if (breach !== undefined) {
					return
				}
				breach = check(call)
				if (breach === undefined) {
					options.onCall(call)
				} else {
					stop.abort(new Error(breach))
				}
			},
		})
		const result = run.result.then((done) => {
			if (breach !== undefined && options.signal?.aborted !== true) {
				return failed(done, "CallLimitError", `The script was stopped: ${breach}`)
			}
			const { bytes, atLeast } = resultBytes(done, limits.resultBytes)
			if (bytes > limits.resultBytes) {
				return failed(
					done,
					"ResultTooLarge",
					`The script's result was ${atLeast ? "at least " : ""}${bytes} bytes; the limit is ${limits.resultBytes}. Write large output to a file in /workspace with the file tools and return its path.`,
				)
			}
			return boundStore(done, options.store, limits.storeBytes)
		})
		return {
			get finished() {
				return run.finished
			},
			deliver: (seq, delivered, id, outcome) => run.deliver(seq, delivered, id, outcome),
			result,
		}
	}
	return sandbox
}

const SCRIPT_CUT = {
	severity: "warn",
	code: "truncated",
	message: "Output truncated: the script's full output was saved to a file.",
} as const

const decodeOutputPath = Schema.decodeUnknownOption(
	Schema.Struct({ fullOutputPath: Schema.String }),
)

export const markSavedOutput = (result: ToolExecutionResult): ToolExecutionResult | undefined => {
	const diagnostics = result.diagnostics ?? []
	return Option.isSome(decodeOutputPath(result.details)) &&
		!diagnostics.some((diagnostic) => diagnostic.code === "truncated")
		? { ...result, diagnostics: [...diagnostics, SCRIPT_CUT] }
		: undefined
}

export interface ScriptSurfaceOptions {
	readonly deadline?: ScriptDeadline
	readonly limits?: ScriptLimits
}

const scriptOptionsExtension = (
	codemodeTool: string,
	source: ScriptSource,
	{ deadline = SCRIPT_DEADLINE, limits = SCRIPT_LIMITS }: ScriptSurfaceOptions,
): Extension =>
	defineExtension({
		name: "checkfu.script-options",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call) => {
					if (call.parent !== undefined || call.name !== codemodeTool) {
						return undefined
					}
					const code = call.arguments["code"]
					const clamped =
						typeof code === "string"
							? clampScriptOptions(source, code, deadline, limits.maxOutputTokens)
							: undefined
					return clamped === undefined
						? undefined
						: { arguments: { ...call.arguments, code: clamped } }
				},
				afterTool: (call, result) =>
					call.parent === undefined && call.name === codemodeTool
						? markSavedOutput(result)
						: undefined,
			}),
		],
	})

export type WorkspaceWrite = (
	path: string,
	content: string | Uint8Array,
) => Promise<string | undefined>

const refused = (): Promise<Result<never, FileError>> =>
	Promise.resolve({
		ok: false,
		error: new FileError("not_supported", "Scripts can only save their output."),
	})

export const scriptOutputEnv = (write: WorkspaceWrite): ExecutionEnv => ({
	id: "checkfu-workspace",
	cwd: "/workspace",
	createTempDir: (prefix) =>
		Promise.resolve({
			ok: true,
			value: `${SCRIPT_OUTPUT_DIRECTORY}/${prefix ?? "script-"}${crypto.randomUUID()}`,
		}),
	writeFile: async (path, content) => {
		const message = await write(path, content).catch((error: unknown) =>
			error instanceof Error ? error.message : String(error),
		)
		return message === undefined
			? { ok: true, value: undefined }
			: { ok: false, error: new FileError("unknown", message, path) }
	},
	absolutePath: refused,
	joinPath: refused,
	readTextFile: refused,
	openTextLineReader: refused,
	readTextLines: refused,
	readBinaryFile: refused,
	openBinaryReader: refused,
	appendFile: refused,
	truncateFile: refused,
	flushFile: refused,
	renameFile: refused,
	fileInfo: refused,
	listDir: refused,
	openDirReader: refused,
	watch: refused,
	canonicalPath: refused,
	exists: refused,
	createDir: refused,
	remove: refused,
	createTempFile: refused,
	exec: () =>
		Promise.resolve({
			ok: false,
			error: new ExecutionError("shell_unavailable", "Scripts have no shell."),
		}),
	cleanup: () => Promise.resolve(),
})

export type ToolSurface = (
	sandbox: CodemodeSandboxBase,
	extensions: ReadonlyArray<Extension>,
	options?: ScriptSurfaceOptions,
) => ReadonlyArray<Extension>

export const loadToolSurface = async (): Promise<ToolSurface> => {
	const [codemode, { createToolSearchExtension }, source] = await Promise.all([
		import("@earendil-works/pi-durable/codemode"),
		import("@earendil-works/pi-durable/tool-search"),
		import("@earendil-works/pi-codemode/source"),
	])
	return (sandbox, extensions, options = {}) => {
		const created = codemode.createCodemodeExtension({ sandbox, models: false })
		return [
			scriptOptionsExtension(codemode.CODEMODE_TOOL_NAME, source, options),
			...extensions,
			{
				...created,
				tools: (created.tools ?? []).map((tool) =>
					tool.name === codemode.CODEMODE_TOOL_NAME
						? { ...tool, executionMode: "sequential" as const }
						: tool,
				),
			},
			...(extensions.some((extension) => extension.tools?.some((tool) => tool.deferred === true))
				? [createToolSearchExtension()]
				: []),
		]
	}
}
