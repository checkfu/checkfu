import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Layer from "effect/Layer"
import { startCli } from "./Runner.ts"
import { startupRefusal } from "./Standalone.ts"

const refusal = startupRefusal(process.execArgv, process.cwd())
if (refusal !== undefined) {
	process.stderr.write(`Error: ${refusal}\n`)
	process.exit(1)
}

startCli(
	Layer.mergeAll(
		BunServices.layer,
		BunHttpClient.layerOptions({ redirect: "manual" }),
		SecureRandom.layerWebCrypto,
	),
)
