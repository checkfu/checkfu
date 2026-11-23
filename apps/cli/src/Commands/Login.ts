import * as Command from "effect/cli/Command"
import * as Prompt from "effect/cli/Prompt"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Stdio from "effect/Stdio"
import { explicitBaseUrl, normalizeApiUrl, verifyApiKey } from "../Client.ts"
import { CliFailure, configError, usageError } from "../Errors.ts"
import { RootCommand } from "../RootCommand.ts"
import type { SavedConnection } from "../SavedConnection.ts"
import {
	readSavedConnection,
	removeSavedConnection,
	writeSavedConnection,
} from "../SavedConnection.ts"
import { writeStderrLine } from "../TerminalOutput.ts"

const apiKeyFromEnvOrPrompt = Effect.gen(function* () {
	const fromEnv = yield* Config.option(Config.Redacted("CHECKFU_API_KEY")).pipe(
		Effect.map(Option.map((key) => Redacted.value(key).trim())),
		Effect.map(Option.filter((key) => key.length > 0)),
		Effect.orElseSucceed(() => Option.none<string>()),
	)
	if (Option.isSome(fromEnv)) {
		return fromEnv.value
	}
	const stdio = yield* Stdio.Stdio
	if (!(yield* stdio.stdinIsTerminal)) {
		return yield* configError("Export CHECKFU_API_KEY to log in without a terminal.")
	}
	const key = yield* Prompt.run(
		Prompt.Hidden({
			message: "API key",
			validate: (value) =>
				value.trim().length === 0 ? Effect.fail("An API key is required.") : Effect.succeed(value),
		}),
	).pipe(Effect.mapError(() => new CliFailure({ message: "Login cancelled.", exitCode: 130 })))
	return Redacted.value(key).trim()
})

export const loginCommand = Command.make("login", {}, () =>
	Effect.gen(function* () {
		const root = yield* RootCommand
		const explicit = yield* explicitBaseUrl(root.baseUrl)
		if (Option.isNone(explicit)) {
			return yield* usageError(
				"Pass the deployment URL: checkfu --base-url https://<your-worker>.workers.dev login",
			)
		}
		const url = yield* normalizeApiUrl(explicit.value)
		const apiKey = yield* apiKeyFromEnvOrPrompt
		yield* verifyApiKey(url, apiKey)
		const saved = yield* readSavedConnection.pipe(
			Effect.orElseSucceed(() => Option.none<SavedConnection>()),
			Effect.map(Option.filter((connection) => connection.url === url)),
		)
		const file = yield* writeSavedConnection({
			...Option.getOrUndefined(saved),
			url,
			api_key: apiKey,
		})
		yield* writeStderrLine(`Connected to ${url}. Saved to ${file}.`)
	}),
).pipe(
	Command.withDescription("Connect this CLI to an existing Checkfu deployment"),
	Command.withExamples([
		{
			command: "checkfu --base-url https://checkfu.example.workers.dev login",
			description: "Save a deployment's URL and API key",
		},
	]),
)

export const logoutCommand = Command.make("logout", {}, () =>
	Effect.gen(function* () {
		const removed = yield* removeSavedConnection
		yield* writeStderrLine(
			Option.isSome(removed) ? `Removed ${removed.value}.` : "No saved deployment.",
		)
	}),
).pipe(Command.withDescription("Forget the saved deployment URL and API key"))
