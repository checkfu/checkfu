#!/usr/bin/env bun
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Runtime from "effect/Runtime"
import { runCli } from "./Cli.ts"
import { SigintCoordinator, makeSigintController } from "./Signals.ts"

const sigintController = makeSigintController()

const MainLive = Layer.mergeAll(
	BunServices.layer,
	BunHttpClient.layer,
	SecureRandom.layerWebCrypto,
	Layer.succeed(SigintCoordinator, sigintController),
)

const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
	let exitSignalCode: number | undefined

	const cleanup = () => {
		process.removeListener("SIGINT", onSigint)
		process.removeListener("SIGTERM", onSigterm)
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
		teardown(exit, (code) => {
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
