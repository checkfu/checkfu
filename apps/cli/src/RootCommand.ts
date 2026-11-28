import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as HttpClient from "effect/http/HttpClient"
import type * as Path from "effect/Path"
import * as Stdio from "effect/Stdio"
import { makeCheckfuClient } from "./Client.ts"
import type { CheckfuClient } from "./Client.ts"
import {
	ACTION_REQUIRED_EXIT_CODE,
	AUTH_EXIT_CODE,
	CONFLICT_EXIT_CODE,
	FAILURE_EXIT_CODE,
	INTERRUPTED_EXIT_CODE,
	NOT_FOUND_EXIT_CODE,
	RETRY_EXIT_CODE,
	SUCCESS_EXIT_CODE,
	USAGE_EXIT_CODE,
} from "./Errors.ts"
import type { CliFailure } from "./Errors.ts"
import { readSavedConnection } from "./SavedConnection.ts"
import { writeStdoutLine } from "./TerminalOutput.ts"
import { OUTPUT_FORMATS, formatOutput } from "./Transform.ts"

export const SharedFlags = {
	baseUrl: Flag.String("base-url").pipe(
		Flag.withMetavar("URL"),
		Flag.withDescription(
			"Checkfu API base URL (defaults to CHECKFU_BASE_URL, the saved deployment, or http://localhost:1337)",
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
	Command.withDescription(
		[
			"Run managed agents in sessions and on a schedule",
			"",
			"Exit codes",
			`  ${SUCCESS_EXIT_CODE}  Success`,
			`  ${FAILURE_EXIT_CODE}  Other failure`,
			`  ${USAGE_EXIT_CODE}  Invalid arguments or configuration`,
			`  ${ACTION_REQUIRED_EXIT_CODE}  Action required`,
			`  ${NOT_FOUND_EXIT_CODE}  Resource not found`,
			`  ${CONFLICT_EXIT_CODE}  Conflict or precondition failed`,
			`  ${AUTH_EXIT_CODE}  Authentication or permission denied`,
			`  ${RETRY_EXIT_CODE}  Transient service or network failure`,
			`  ${INTERRUPTED_EXIT_CODE}  Interrupted`,
		].join("\n"),
	),
	Command.withSharedFlags(SharedFlags),
)

export const getClient: Effect.Effect<
	CheckfuClient,
	CliFailure,
	| Command.CommandContext<"checkfu">
	| HttpClient.HttpClient
	| SecureRandom.SecureRandom
	| FileSystem.FileSystem
	| Path.Path
> = Effect.gen(function* () {
	const root = yield* RootCommand
	return yield* makeCheckfuClient(root.baseUrl, readSavedConnection)
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
