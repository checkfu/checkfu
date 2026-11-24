import { realpathSync } from "node:fs"
import { resolve } from "node:path"
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
import { isStandalone } from "./Standalone.ts"
import { escapeTerminalControlCharacters } from "./TerminalOutput.ts"

const resolvePhysicalPath = (path: string): string | undefined => {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

const trustedBunfigPath = resolvePhysicalPath(resolve(import.meta.dirname, "../bunfig.toml"))

const launchedWithPinnedCliConfig = (execArgv: ReadonlyArray<string>): boolean => {
	if (!execArgv.includes("--no-env-file") || trustedBunfigPath === undefined) {
		return false
	}
	return execArgv.some((arg) => {
		if (!arg.startsWith("--config=")) {
			return false
		}
		const rawPath = arg.slice("--config=".length)
		if (rawPath.length === 0) {
			return false
		}
		return resolvePhysicalPath(rawPath) === trustedBunfigPath
	})
}

// Bun loads `.env` and `bunfig.toml` preloads from the directory it starts in. The
// `checkfu` package script switches both off before Bun starts; refuse to run when
// started any other way, so a directory can never inject configuration or code.
if (!isStandalone && !launchedWithPinnedCliConfig(process.execArgv)) {
	process.stderr.write(
		"Error: Start the Checkfu CLI with `bun checkfu` from the checkout, or build the standalone binary with `bun run checkfu:build`. Starting src/main.ts directly would let the current directory's .env and bunfig.toml apply.\n",
	)
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

// `bun run` forwards SIGINT to the script it started, and a terminal also delivers the same
// Ctrl-C to that script directly. Under `bun checkfu` one key press therefore arrives as two
// signals a millisecond or two apart, or as one when the kernel merges them. Only the
// spacing tells that echo from a second press, so a second signal this soon is ignored.
const startedByBunRun = !isStandalone && process.env["npm_lifecycle_event"] === "checkfu"
const SIGINT_ECHO_WINDOW_MS = 100

const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
	let exitSignalCode: number | undefined
	let lastSigintAt = Number.NEGATIVE_INFINITY

	const onSigint = () => {
		const now = performance.now()
		if (startedByBunRun && now - lastSigintAt < SIGINT_ECHO_WINDOW_MS) {
			return
		}
		lastSigintAt = now
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
})

runMain(runCli().pipe(Effect.provide(MainLive)), {
	disableErrorReporting: true,
})
