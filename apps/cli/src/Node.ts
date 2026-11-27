import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { startCli } from "./Runner.ts"
import { runCli } from "./Cli.ts"
import {
	CheckoutResolver,
	githubDistribution,
	installDependencies,
	makeManagedResolver,
	managedEnvironment,
} from "./Deployment/Managed.ts"

const report = process.platform === "linux" ? process.report?.getReport() : undefined
const musl =
	report !== undefined &&
	typeof report !== "string" &&
	!Schema.decodeUnknownSync(
		Schema.Struct({
			header: Schema.Struct({ glibcVersionRuntime: Schema.optionalKey(Schema.String) }),
		}),
	)(report).header.glibcVersionRuntime
const target = `${process.platform}-${process.arch}${musl ? "-musl" : ""}`

startCli(
	Layer.mergeAll(
		NodeServices.layer,
		FetchHttpClient.layer.pipe(
			Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
		),
		SecureRandom.layerWebCrypto,
	),
	runCli().pipe(
		Effect.provideService(
			CheckoutResolver,
			makeManagedResolver({
				distribution: githubDistribution,
				target,
				env: managedEnvironment(process.env),
				install: installDependencies,
				announce: (message) => process.stderr.write(`${message}\n`),
			}),
		),
	),
)
