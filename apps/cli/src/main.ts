import { existsSync } from "node:fs"
import { join } from "node:path"
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

const hasImplicitCwdDotenv = (): boolean => {
	const cwd = process.cwd()
	const nodeEnv = process.env["NODE_ENV"]
	const candidates = [
		".env",
		".env.local",
		".env.development",
		".env.development.local",
		".env.production",
		".env.production.local",
		".env.test",
		".env.test.local",
		...(nodeEnv !== undefined && nodeEnv.length > 0
			? [`.env.${nodeEnv}`, `.env.${nodeEnv}.local`]
			: []),
	]
	return candidates.some((name) => existsSync(join(cwd, name)))
}

const hasExplicitBunConfig = (execArgv: ReadonlyArray<string>): boolean =>
	execArgv.some((arg) => arg.startsWith("--config=") && arg.length > "--config=".length)

const hasImplicitCwdBunfig = (): boolean => existsSync(join(process.cwd(), "bunfig.toml"))

if (!process.execArgv.includes("--no-env-file") && hasImplicitCwdDotenv()) {
	process.stderr.write(
		"Error: Refusing to run with implicit Bun .env autoloading while .env file(s) exist in the working directory. Run with: bun --no-env-file --config=apps/cli/bunfig.toml apps/cli/src/main.ts ...\n",
	)
	process.exit(1)
}

if (!hasExplicitBunConfig(process.execArgv) && hasImplicitCwdBunfig()) {
	process.stderr.write(
		"Error: Refusing to run with implicit working-directory bunfig.toml loading. Run with: bun --no-env-file --config=apps/cli/bunfig.toml apps/cli/src/main.ts ...\n",
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
