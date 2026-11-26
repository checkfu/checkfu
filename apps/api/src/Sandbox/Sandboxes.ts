import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import type { ExecOptions, ExecResult } from "alchemy/Sandbox"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class SandboxError extends Schema.TaggedError<
	SandboxError,
	{ readonly brand: unique symbol }
>()("SandboxError", { message: Schema.String }) {}

export type { ExecOptions, ExecResult } from "alchemy/Sandbox"

export const TIMED_OUT = 124

export const MACHINE_IDLE_ENV = "CHECKFU_MACHINE_IDLE"

export const machineIdle = Config.withDefault(
	Config.Duration(MACHINE_IDLE_ENV),
	Duration.minutes(10),
)

export interface Sandbox {
	readonly incarnation: string
	readonly exec: (
		command: string | ReadonlyArray<string>,
		options?: ExecOptions,
	) => Effect.Effect<ExecResult, SandboxError>
	readonly readFile: (path: string) => Effect.Effect<Uint8Array, SandboxError>
	readonly readTextFile: (path: string) => Effect.Effect<string, SandboxError>
	readonly writeFile: (
		path: string,
		content: string | Uint8Array,
	) => Effect.Effect<void, SandboxError>
}

export class Sandboxes extends Context.Service<
	Sandboxes,
	{
		readonly open: (key: string) => Effect.Effect<Sandbox, SandboxError>
		readonly remove: (key: string) => Effect.Effect<void, SandboxError>
	}
>()("@checkfu/api/Sandboxes") {}
