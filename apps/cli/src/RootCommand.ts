import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Stdio from "effect/Stdio"
import { makeCheckfuClient } from "./Client.ts"
import type { CheckfuClient } from "./Client.ts"
import type { CliFailure } from "./Errors.ts"
import { writeStdoutLine } from "./TerminalOutput.ts"
import { OUTPUT_FORMATS, formatOutput } from "./Transform.ts"

export const SharedFlags = {
	baseUrl: Flag.String("base-url").pipe(
		Flag.withMetavar("URL"),
		Flag.withDescription(
			"Checkfu API base URL (defaults to CHECKFU_API_URL, CHECKFU_URL, or http://localhost:1337)",
		),
		Flag.optional,
	),
	format: Flag.Literals("format", OUTPUT_FORMATS).pipe(
		Flag.withDefault("auto"),
		Flag.withDescription("Output format: auto, json, jsonl, yaml, pretty, raw"),
	),
	transform: Flag.String("transform").pipe(
		Flag.withMetavar("EXPR"),
		Flag.withDescription(
			"Extract or reshape output using a GJSON-style path expression (e.g. id, content.0.text, {id,name})",
		),
		Flag.optional,
	),
	rawOutput: Flag.Boolean("raw-output").pipe(
		Flag.withAlias("r"),
		Flag.withDefault(false),
		Flag.withDescription("Write string results directly without JSON quotes"),
	),
} as const

export const RootCommand = Command.make("checkfu").pipe(
	Command.withDescription("Manage Checkfu agents, environments, and sessions"),
	Command.withSharedFlags(SharedFlags),
)

export const getClient: Effect.Effect<
	CheckfuClient,
	CliFailure,
	Command.CommandContext<"checkfu"> | HttpClient.HttpClient | SecureRandom.SecureRandom
> = Effect.gen(function* () {
	const root = yield* RootCommand
	return yield* makeCheckfuClient(root.baseUrl)
})

export const renderOutput = (
	value: unknown,
	options?: { readonly streaming?: boolean },
): Effect.Effect<void, CliFailure, Command.CommandContext<"checkfu"> | Stdio.Stdio> =>
	Effect.gen(function* () {
		const root = yield* RootCommand
		const stdio = yield* Stdio.Stdio
		const isTerminal = yield* stdio.stdoutIsTerminal
		const formatted = formatOutput(value, {
			format: root.format,
			transform: root.transform,
			rawOutput: root.rawOutput,
			isTerminal,
			...(options?.streaming === undefined ? {} : { streaming: options.streaming }),
		})
		yield* writeStdoutLine(formatted)
	})
