import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// The names and shapes of Alchemy's `AI.Sandbox` and `AI.Sandboxes`, which its E2B, Daytona,
// Modal, Archil and Boat layers provide. That package is not published yet, so the shapes are
// repeated here: a platform's layer for this service is all a deployment swaps.

/** A sandbox could not be reached, started or asked. A command that ran and failed is not one. */
export class SandboxError extends Schema.TaggedError<
	SandboxError,
	{ readonly brand: unique symbol }
>()("SandboxError", { message: Schema.String }) {}

export interface ExecOptions {
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string>>
	/** Milliseconds after which the command is killed. */
	readonly timeout?: number
}

/** A finished command. A non-zero exit code is returned, not failed. */
export interface ExecResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

/** One machine: a shell line or an argument vector run in it, and its files. */
export interface Sandbox {
	readonly exec: (
		command: string | ReadonlyArray<string>,
		options?: ExecOptions,
	) => Effect.Effect<ExecResult, SandboxError>
	readonly readFile: (path: string) => Effect.Effect<Uint8Array, SandboxError>
	readonly readTextFile: (path: string) => Effect.Effect<string, SandboxError>
	/** Creates or replaces the file, and its parent directories. */
	readonly writeFile: (
		path: string,
		content: string | Uint8Array,
	) => Effect.Effect<void, SandboxError>
}

/**
 * The machines of a deployment, one per key. `suspend` stops paying for compute and keeps the
 * files where the platform can; a sandbox its platform deleted is created again, empty, by the
 * next `open`.
 */
export class Sandboxes extends Context.Service<
	Sandboxes,
	{
		/** The key's sandbox, running: created, resumed, or returned as it is. */
		readonly open: (key: string) => Effect.Effect<Sandbox, SandboxError>
		readonly suspend: (key: string) => Effect.Effect<void, SandboxError>
		/** Deletes the key's sandbox, if there is one. */
		readonly remove: (key: string) => Effect.Effect<void, SandboxError>
	}
>()("@checkfu/api/Sandboxes") {}
