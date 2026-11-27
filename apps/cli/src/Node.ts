import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import { startCli } from "./Runner.ts"

startCli(
	Layer.mergeAll(
		NodeServices.layer,
		FetchHttpClient.layer.pipe(
			Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
		),
		SecureRandom.layerWebCrypto,
	),
)
