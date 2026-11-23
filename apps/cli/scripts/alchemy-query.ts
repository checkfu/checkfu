import { argv, stdout } from "node:process"
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { CloudflareResolvedCredentials } from "@alchemy.run/cloudflare/Auth/AuthConfig"
import * as Alchemist from "alchemy/Alchemist"
import { configServices } from "alchemy/Alchemist/Operations"
import { SuppressMissingProviderConfig } from "alchemy/Auth/Profile"
import { AuthProvidersLive } from "alchemy/Auth/Registry"
import { resolveProviderConfig } from "alchemy/Auth/Resolve"
import * as State from "alchemy/State"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

// Answers the two things `checkfu deploy` and `checkfu destroy` need to know from
// Alchemy, by calling the functions Alchemy itself uses, under the same env file and
// profile the deploy gets:
//
//   account             which Cloudflare account these credentials act on
//   output <state-path> the outputs a deployed stage recorded
//
// The answer is one line, `@checkfu <json>`, so nothing else Alchemy prints can be
// mistaken for it. Neither question creates or changes anything: `account` never opens
// the state store, and `output` is only asked after a deploy has created it.

export const ANSWER_PREFIX = "@checkfu "

const [question = "", profile = "default", envFile = "", statePath = ""] = argv.slice(2)
const target = { profile, ...(envFile === "" ? {} : { envFile }) }

const account = Effect.gen(function* () {
	const provider = yield* resolveProviderConfig<{ method: string }, CloudflareResolvedCredentials>(
		"Cloudflare",
	)
	const credentials = yield* provider.resolve
	return { status: "connected" as const, account_id: credentials.accountId }
}).pipe(
	Effect.catchTag("MissingProviderConfig", (error) =>
		Effect.succeed({ status: "not-configured" as const, message: error.message }),
	),
	Effect.provideService(SuppressMissingProviderConfig, true),
	Effect.provide(Cloudflare.CloudflareApiLive().pipe(Layer.provideMerge(AuthProvidersLive))),
)

const output = Effect.gen(function* () {
	const store = yield* Alchemist.State.store({ type: "configured", ...target })
	const entries = yield* State.readState({ path: statePath }).pipe(
		Effect.provideService(State.State, Effect.succeed(store)),
	)
	// A stage that was never deployed has no output: Alchemy answers with an empty value.
	const value = entries[0]?.value ?? null
	return value === null ? { status: "missing" as const } : { status: "found" as const, value }
})

const answer = Effect.gen(function* () {
	const config = yield* configServices(target)
	if (question === "account") {
		return yield* Effect.provide(account, config)
	}
	return yield* Effect.provide(output, config)
}).pipe(
	Effect.scoped,
	Effect.provide(Alchemist.layer()),
	Effect.catchCause((cause) =>
		Effect.succeed({
			status: "error" as const,
			message: Cause.pretty(cause).split("\n", 1)[0] ?? "unknown error",
		}),
	),
)

stdout.write(`\n${ANSWER_PREFIX}${JSON.stringify(await Effect.runPromise(answer))}\n`)
