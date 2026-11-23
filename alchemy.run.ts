import * as Cloudflare from "@alchemy.run/cloudflare"
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare"
import ApiWorker from "@checkfu/api/ApiWorker"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export const CLOUDFLARE_STATE_OBSERVABILITY = {
	enabled: true,
	logs: { enabled: true, invocationLogs: false },
} as const

const state = Layer.unwrap(
	Effect.map(Alchemy.AlchemyContext, (ctx) =>
		ctx.dev
			? Alchemy.localState()
			: Cloudflare.state({
					observability: CLOUDFLARE_STATE_OBSERVABILITY,
				}),
	),
)

export const inProduction = <E, R>(check: Effect.Effect<void, E, R>) =>
	Effect.gen(function* () {
		const ctx = yield* Alchemy.AlchemyContext
		if (!ctx.dev && (yield* Alchemy.Stage) === "production") {
			yield* check
		}
	})

const requireShippedBaseline = Effect.flatMap(
	Effect.promise(() => import("./apps/api/test/persisted/Lock.ts")),
	(lock) => lock.requireShippedBaseline,
)

export const checkfuStack = (baseline: Effect.Effect<void>) =>
	Alchemy.Stack(
		"Checkfu",
		{
			providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
			state,
		},
		Effect.gen(function* () {
			yield* inProduction(baseline)
			const api = yield* ApiWorker
			return {
				api: api.url.as<string>(),
			}
		}),
	)

export default checkfuStack(requireShippedBaseline)
