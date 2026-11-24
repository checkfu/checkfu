import * as Cloudflare from "@alchemy.run/cloudflare"
import { providers as domainProviders } from "@alchemy.run/domain/Cloudflare"
import ApiWorker from "@checkfu/api/ApiWorker"
import { MCP_DOMAIN_ENV, customDomain } from "@checkfu/api/CustomDomain"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export const CLOUDFLARE_STATE_OBSERVABILITY = {
	enabled: true,
	logs: { enabled: true, invocationLogs: false },
} as const

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
			providers: Layer.mergeAll(Cloudflare.providers(), domainProviders()),
			state: Layer.unwrap(
				Effect.gen(function* () {
					yield* inProduction(baseline)
					const ctx = yield* Alchemy.AlchemyContext
					return ctx.dev
						? Alchemy.localState()
						: Cloudflare.state({ observability: CLOUDFLARE_STATE_OBSERVABILITY })
				}),
			),
		},
		Effect.gen(function* () {
			const api = yield* ApiWorker
			const mcp = yield* Cloudflare.Worker("McpWorker", {
				...(yield* customDomain(MCP_DOMAIN_ENV)),
				main: import.meta.resolve("@checkfu/mcp/Worker"),
				compatibility: { date: "2026-11-17" },
				observability: { enabled: true },
				env: { API: api },
				dev: { port: 1338 },
			})
			return {
				api: api.url.as<string>(),
				mcp: mcp.url.as<string>(),
			}
		}),
	)

export default checkfuStack(requireShippedBaseline)
