import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Cause from "effect/Cause"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Runtime from "effect/Runtime"
import { runCli } from "./Cli.ts"
import { isCliFailure } from "./Errors.ts"
import { SigintCoordinator, makeSigintController } from "./Signals.ts"
import { startupRefusal } from "./Standalone.ts"
import { escapeTerminalControlCharacters } from "./TerminalOutput.ts"

const refusal = startupRefusal(process.execArgv, process.cwd())
if (refusal !== undefined) {
	process.stderr.write(`Error: ${refusal}\n`)
	process.exit(1)
}

const sigintController = makeSigintController()

const MainLive = Layer.mergeAll(
	BunServices.layer,
	BunHttpClient.layerOptions({ redirect: "manual" }),
	SecureRandom.layerWebCrypto,
	Layer.succeed(SigintCoordinator, sigintController),
)

const releaseStdin = () => {
	process.stdin.pause()
	if (typeof process.stdin.unref === "function") {
		process.stdin.unref()
	}
}

const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
	let exitSignalCode: number | undefined

	const onSigint = () => {
		if (sigintController.handleSigint()) {
			return
		}
		exitSignalCode = 130
		fiber.interruptUnsafe(fiber.id)
	}

	const onSigterm = () => {
		exitSignalCode = 143
		fiber.interruptUnsafe(fiber.id)
	}

	fiber.addObserver((exit) => {
		process.removeListener("SIGINT", onSigint)
		process.removeListener("SIGTERM", onSigterm)
		releaseStdin()
		if (exit._tag === "Failure" && exitSignalCode === undefined) {
			const hasDefect = Cause.hasDies(exit.cause)
			const hasUnreportedFailure =
				Cause.hasFails(exit.cause) &&
				!exit.cause.reasons.some((reason) => reason._tag === "Fail" && isCliFailure(reason.error))
			if (hasDefect || hasUnreportedFailure) {
				process.stderr.write(`${escapeTerminalControlCharacters(Cause.pretty(exit.cause))}\n`)
			}
		}
		teardown(exit, (code) => {
			releaseStdin()
			const finalCode = exitSignalCode ?? code
			if (finalCode !== 0) {
				process.exit(finalCode)
			}
		})
	})

	process.on("SIGINT", onSigint)
	process.on("SIGTERM", onSigterm)

	// `bun checkfu` runs this as a child of Bun's script runner. If the runner is killed,
	// this process is handed to another parent; stop then, as the old launcher did when
	// its IPC channel closed, so a long-lived stream does not outlive the command.
	if (process.env["npm_lifecycle_event"] === "checkfu") {
		const runner = process.ppid
		const watch = setInterval(() => {
			if (process.ppid !== runner) {
				exitSignalCode ??= 129
				fiber.interruptUnsafe(fiber.id)
			}
		}, 200)
		watch.unref()
		fiber.addObserver(() => clearInterval(watch))
	}
})

runMain(runCli().pipe(Effect.provide(MainLive)), {
	disableErrorReporting: true,
})
