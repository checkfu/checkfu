import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Cause from "effect/Cause"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Runtime from "effect/Runtime"
import { runCli } from "./Cli.ts"
import { CliFailure } from "./Errors.ts"
import { SigintCoordinator, makeSigintController } from "./Signals.ts"
import { escapeTerminalControlCharacters } from "./TerminalOutput.ts"

const resolvePhysicalPath = (path: string): string | undefined => {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

const trustedBunfigPath = resolvePhysicalPath(
	resolve(dirname(fileURLToPath(import.meta.url)), "../bunfig.toml"),
)

const launchedWithPinnedCliConfig = (execArgv: ReadonlyArray<string>): boolean => {
	if (!execArgv.includes("--no-env-file") || trustedBunfigPath === undefined) {
		return false
	}
	return execArgv.some((arg) => {
		if (!arg.startsWith("--config=")) return false
		const rawPath = arg.slice("--config=".length)
		if (rawPath.length === 0) return false
		return resolvePhysicalPath(rawPath) === trustedBunfigPath
	})
}

// `apps/cli/bin/checkfu` enforces `--no-env-file --config=<cli>/bunfig.toml`
// *before* Bun starts so untrusted working-directory `.env*` and `bunfig.toml`
// preloads can never execute. Refuse unsupported direct invocations consistently
// rather than allowing `bun apps/cli/src/main.ts` to run in clean directories.
if (!launchedWithPinnedCliConfig(process.execArgv)) {
	process.stderr.write(
		"Error: Launch the Checkfu CLI via apps/cli/bin/checkfu (or the installed `checkfu` binary) so Bun starts with --no-env-file and the pinned CLI config.\n",
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

const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
	let exitSignalCode: number | undefined

	const releaseStdin = () => {
		process.stdin.pause()
		if (typeof process.stdin.unref === "function") {
			process.stdin.unref()
		}
	}

	const cleanup = () => {
		process.removeListener("SIGINT", onSigint)
		process.removeListener("SIGTERM", onSigterm)
		releaseStdin()
	}

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
		cleanup()
		if (exit._tag === "Failure" && exitSignalCode === undefined) {
			const hasDefect = Cause.hasDies(exit.cause)
			const hasUnreportedFailure =
				Cause.hasFails(exit.cause) &&
				!exit.cause.reasons.some(
					(reason) => reason._tag === "Fail" && reason.error instanceof CliFailure,
				)
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
