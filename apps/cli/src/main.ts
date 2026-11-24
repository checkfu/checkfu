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
import { checkoutRoot, isStandalone } from "./Standalone.ts"
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

// Bun loads `bunfig.toml` preloads and `.env` from the directory it starts in. In the
// checkout that is the checkout's own bunfig, which switches `.env` loading off. Anywhere
// else both flags must have switched the directory's files off before Bun started.
const startedInCheckout = resolvePhysicalPath(process.cwd()) === resolvePhysicalPath(checkoutRoot)

if (!isStandalone && !startedInCheckout && !launchedWithPinnedCliConfig(process.execArgv)) {
	process.stderr.write(
		"Error: Run `bun checkfu` from the Checkfu checkout. To use the CLI from another directory, build the standalone binary with `bun run checkfu:build` and call it by its path.\n",
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
})

runMain(runCli().pipe(Effect.provide(MainLive)), {
	disableErrorReporting: true,
})
