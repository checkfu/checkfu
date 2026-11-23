import * as Cloudflare from "@alchemy.run/cloudflare"
import type {
	CodemodeRemoteExchange,
	CodemodeRemoteRequest,
	CodemodeSandboxBase,
} from "@earendil-works/pi-codemode/portable"
import type { Extension } from "@earendil-works/pi-durable"
import type { Dependencies } from "alchemy/Dependencies"
import type * as Effect from "effect/Effect"

// Both sit under DEFAULT_TURN_TIMEOUT_MS, so a stuck script ends as a tool error, not a lost turn.
export const SCRIPT_DEADLINE = { defaultMs: 120_000, maxMs: 300_000 } as const

const SANDBOX_CLASS = "CodemodeSandbox"

// Its own Worker: a script that computes would otherwise hold the session object's thread.
export const CodemodeSandboxWorker = Cloudflare.Worker("CodemodeSandboxWorker", {
	main: new URL("./PiCodemodeSandboxWorker.ts", import.meta.url).href,
	compatibility: { date: "2026-11-17" },
	workersDev: false,
	// Longer than the longest script, so a deploy does not cut one off.
	codeUpdateStrategy: { mode: "deferred", maxDelay: "6 minutes" },
	env: { [SANDBOX_CLASS]: Cloudflare.DurableObject(SANDBOX_CLASS) },
	observability: { enabled: true },
	dev: { port: 1340 },
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
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a plain Worker's type cannot declare the classes it hosts; the binding is by script name
	CodemodeSandboxWorker as typeof CodemodeSandboxWorker &
		Effect.Effect<
			Dependencies<CodemodeSandbox>,
			never,
			Effect.Services<typeof CodemodeSandboxWorker>
		>,
)

/**
 * Pi's durable code mode starts a script with no deadline unless the script
 * names one, so a call that never returns would hold the turn until the turn's
 * own deadline. Every script gets one here, and none can ask for more than the
 * cap.
 */
export const withScriptDeadline = <Sandbox extends CodemodeSandboxBase>(
	sandbox: Sandbox,
	{ defaultMs, maxMs }: { readonly defaultMs: number; readonly maxMs: number } = SCRIPT_DEADLINE,
): Sandbox => {
	const start = sandbox.start.bind(sandbox)
	sandbox.start = (code, options) =>
		start(code, { ...options, timeoutMs: Math.min(options.timeoutMs ?? defaultMs, maxMs) })
	return sandbox
}

export type ToolSurface = (
	sandbox: CodemodeSandboxBase,
	extensions: ReadonlyArray<Extension>,
) => ReadonlyArray<Extension>

/**
 * A session's tools plus the two ways to use many of them: scripts that call
 * them, and search over the deferred ones. Search is offered only when there
 * is something deferred to find. Loaded on first use, so the isolates that
 * never host a session do not parse it at start-up.
 */
export const loadToolSurface = async (): Promise<ToolSurface> => {
	const [{ createCodemodeExtension }, { createToolSearchExtension }] = await Promise.all([
		import("@earendil-works/pi-durable/codemode"),
		import("@earendil-works/pi-durable/tool-search"),
	])
	return (sandbox, extensions) => [
		...extensions,
		createCodemodeExtension({ sandbox, models: false }),
		...(extensions.some((extension) => extension.tools?.some((tool) => tool.deferred === true))
			? [createToolSearchExtension()]
			: []),
	]
}
