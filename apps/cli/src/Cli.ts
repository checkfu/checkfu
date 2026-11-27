import { version } from "../package.json"
import * as CliError from "effect/cli/CliError"
import * as CliOutput from "effect/cli/CliOutput"
import * as Command from "effect/cli/Command"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { agentCommand } from "./Commands/Agent.ts"
import { applyCommand } from "./Commands/Apply.ts"
import { deployCommand, destroyCommand } from "./Commands/Deploy.ts"
import { loginCommand, logoutCommand } from "./Commands/Login.ts"
import { sessionsConnectCommand } from "./Commands/SessionsConnect.ts"
import { CliFailure } from "./Errors.ts"
import { buildGeneratedResourceCommands } from "./generated/Commands.ts"
import { RootCommand } from "./RootCommand.ts"
import { escapeTerminalControlCharacters, writeStderrLine } from "./TerminalOutput.ts"

export const CLI_VERSION = version

export const CheckfuCli = RootCommand.pipe(
	Command.withSubcommands([
		applyCommand,
		agentCommand,
		deployCommand,
		loginCommand,
		logoutCommand,
		destroyCommand,
		...buildGeneratedResourceCommands({
			sessions: [sessionsConnectCommand],
		}),
	]),
)

const writeToSink = (sink: ReturnType<Stdio.Stdio["stdout"]>, text: string): Effect.Effect<void> =>
	Stream.make(text).pipe(Stream.run(sink), Effect.ignore)

export const StdioPresenterLive = Layer.effect(
	CliOutput.Presenter,
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio
		return {
			present: (event) =>
				Effect.gen(function* () {
					const stdoutIsTty = yield* stdio.stdoutIsTerminal
					switch (event._tag) {
						case "Help": {
							const formatter = CliOutput.defaultFormatter({ colors: stdoutIsTty })
							yield* writeToSink(
								stdio.stdout({ endOnDone: false }),
								`${formatter.formatHelpDoc(event.helpDoc)}\n`,
							)
							return
						}
						case "Version": {
							const formatter = CliOutput.defaultFormatter({ colors: stdoutIsTty })
							yield* writeToSink(
								stdio.stdout({ endOnDone: false }),
								`${formatter.formatVersion(event.name, event.version)}\n`,
							)
							return
						}
						case "InvalidInvocation": {
							const formatter = CliOutput.defaultFormatter({ colors: false })
							yield* writeToSink(
								stdio.stderr({ endOnDone: false }),
								`${escapeTerminalControlCharacters(formatter.formatErrors(event.errors))}\n`,
							)
							return
						}
					}
				}),
		} satisfies CliOutput.Presenter
	}),
)

export const runCli = (
	args?: ReadonlyArray<string>,
): Effect.Effect<
	void,
	CliFailure,
	Command.Environment | HttpClient.HttpClient | SecureRandom.SecureRandom
> => {
	const runner =
		args === undefined
			? Command.run(CheckfuCli, { version: CLI_VERSION })
			: Command.runWith(CheckfuCli, { version: CLI_VERSION })(args)

	return runner.pipe(
		Effect.provide(StdioPresenterLive),
		Effect.catch((error) =>
			Effect.gen(function* () {
				if (CliError.isCliError(error)) {
					if (error._tag === "ShowHelp") {
						if (error.errors.length === 0) {
							return
						}
						return yield* new CliFailure({
							message: error.errors.map((e) => e.message).join("; "),
							exitCode: 1,
						})
					}
					yield* writeStderrLine(`Error: ${error.message}`)
					return yield* new CliFailure({ message: error.message, exitCode: 1 })
				}
				yield* writeStderrLine(`Error: ${error.message}`)
				return yield* error
			}),
		),
		Effect.catchDefect((defect) =>
			Effect.gen(function* () {
				const detail =
					defect instanceof Error
						? defect.message
						: typeof defect === "string"
							? defect
							: String(defect)
				const failure = new CliFailure({
					message: `Unexpected error: ${detail}`,
					exitCode: 1,
				})
				yield* writeStderrLine(`Error: ${failure.message}`)
				return yield* failure
			}),
		),
	)
}
