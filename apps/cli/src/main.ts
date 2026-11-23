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

// `apps/cli/bin/checkfu.mjs` enforces `--no-env-file --config=<cli>/bunfig.toml`
// *before* Bun starts so untrusted working-directory `.env*` and `bunfig.toml`
// preloads can never execute. Refuse unsupported direct invocations consistently
// rather than allowing `bun apps/cli/src/main.ts` to run in clean directories.
if (!launchedWithPinnedCliConfig(process.execArgv)) {
	process.stderr.write(
		"Error: Launch the Checkfu CLI via `node apps/cli/bin/checkfu.mjs` (or the installed `checkfu` binary) so Bun starts with --no-env-file and the pinned CLI config.\n",
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
	let launcherOwnsSigint = typeof process.send === "function" && process.connected

	const releaseStdin = () => {
		process.stdin.pause()
		if (typeof process.stdin.unref === "function") {
			process.stdin.unref()
		}
	}

	const onSigint = () => {
		if (sigintController.handleSigint()) {
			return
		}
		exitSignalCode = 130
		fiber.interruptUnsafe(fiber.id)
	}

	const onOsSigint = () => {
		if (launcherOwnsSigint) {
			return
		}
		onSigint()
	}

	const onLauncherMessage = (message: unknown) => {
		if (
			typeof message === "object" &&
			message !== null &&
			"type" in message &&
			message.type === "checkfu:sigint"
		) {
			onSigint()
		}
	}

	const onLauncherDisconnect = () => {
		launcherOwnsSigint = false
	}

	const onSigterm = () => {
		exitSignalCode = 143
		fiber.interruptUnsafe(fiber.id)
	}

	const cleanup = () => {
		process.removeListener("SIGINT", onOsSigint)
		process.removeListener("SIGTERM", onSigterm)
		process.removeListener("message", onLauncherMessage)
		process.removeListener("disconnect", onLauncherDisconnect)
		if (launcherOwnsSigint && process.connected) {
			process.disconnect?.()
		}
		launcherOwnsSigint = false
		releaseStdin()
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

	process.on("SIGINT", onOsSigint)
	process.on("SIGTERM", onSigterm)
	if (launcherOwnsSigint) {
		process.on("message", onLauncherMessage)
		process.on("disconnect", onLauncherDisconnect)
		try {
			process.send?.({ type: "checkfu:sigint-ready" })
		} catch {
			launcherOwnsSigint = false
		}
	}
})

runMain(runCli().pipe(Effect.provide(MainLive)), {
	disableErrorReporting: true,
})
