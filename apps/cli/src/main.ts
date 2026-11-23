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

// `apps/cli/bin/checkfu.mjs` enforces `--no-env-file --config=<cli>/bunfig.toml`
// *before* Bun starts so untrusted working-directory `.env*` and `bunfig.toml`
// preloads can never execute (in untrusted checkouts, invoke an independently
// installed launcher via absolute paths for both Node and `checkfu.mjs`).
// Refuse unsupported direct invocations consistently rather than allowing
// `bun apps/cli/src/main.ts` to run in clean directories.
if (!isStandalone && !launchedWithPinnedCliConfig(process.execArgv)) {
	process.stderr.write(
		"Error: Launch the Checkfu CLI via a trusted Node binary and trusted Checkfu installation (for example `/path/to/node /path/to/checkfu/apps/cli/bin/checkfu.mjs`) or the installed `checkfu` binary on a trusted PATH so Bun starts with --no-env-file and the pinned CLI config.\n",
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
	const launchedViaIpc = typeof process.send === "function"
	let launcherOwnsSigint = launchedViaIpc && process.connected
	let finished = false

	const interruptOnLauncherLoss = () => {
		launcherOwnsSigint = false
		if (finished) {
			return
		}
		// The launcher disappeared unexpectedly (e.g., SIGKILL from a supervisor).
		// Interrupt the running command so long-lived streams stop reconnecting
		// and inherited stdio pipes close promptly.
		if (exitSignalCode === undefined) {
			exitSignalCode = 130
		}
		fiber.interruptUnsafe(fiber.id)
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
		interruptOnLauncherLoss()
	}

	const onSigterm = () => {
		exitSignalCode = 143
		fiber.interruptUnsafe(fiber.id)
	}

	const cleanup = () => {
		finished = true
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

	process.on("SIGINT", onOsSigint)
	process.on("SIGTERM", onSigterm)
	if (launchedViaIpc) {
		if (!process.connected) {
			interruptOnLauncherLoss()
			return
		}
		process.on("message", onLauncherMessage)
		process.on("disconnect", onLauncherDisconnect)
		try {
			const sent = process.send?.({ type: "checkfu:sigint-ready" })
			if (sent === false) {
				interruptOnLauncherLoss()
			}
		} catch {
			interruptOnLauncherLoss()
		}
	}
})

runMain(runCli().pipe(Effect.provide(MainLive)), {
	disableErrorReporting: true,
})
