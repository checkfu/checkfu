import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	DATA_CALLS_PER_MINUTE_PER_ARTIFACT,
	DATA_CALLS_PER_MINUTE_PER_CALLER,
	DATA_THROTTLE_PERIOD_SECONDS,
	DataThrottle,
	artifactKey,
	callerKey,
} from "./DataThrottle.ts"

export const DataThrottleLive = Layer.effect(
	DataThrottle,
	Effect.gen(function* () {
		const perCaller = yield* Cloudflare.RateLimit("DATA_CALLER_LIMIT", {
			namespaceId: 7301,
			simple: { limit: DATA_CALLS_PER_MINUTE_PER_CALLER, period: DATA_THROTTLE_PERIOD_SECONDS },
		})
		const perArtifact = yield* Cloudflare.RateLimit("DATA_ARTIFACT_LIMIT", {
			namespaceId: 7302,
			simple: { limit: DATA_CALLS_PER_MINUTE_PER_ARTIFACT, period: DATA_THROTTLE_PERIOD_SECONDS },
		})
		const runtime = yield* Cloudflare.Worker
		const within = (limiter: typeof perCaller, key: string) =>
			limiter.limit({ key }).pipe(
				Effect.map(({ success }) => success),
				Effect.catchTag("RateLimitError", (error) =>
					Effect.as(Effect.logError("Data rate limit could not be read", error), true),
				),
				Effect.provideService(RuntimeContext, runtime),
			)
		return {
			admit: (artifactId, caller, kind) =>
				Effect.flatMap(within(perCaller, callerKey(artifactId, caller)), (admitted) =>
					admitted ? within(perArtifact, artifactKey(artifactId, kind)) : Effect.succeed(false),
				),
		}
	}),
).pipe(Layer.provide(Cloudflare.Workers.RateLimitBinding))
