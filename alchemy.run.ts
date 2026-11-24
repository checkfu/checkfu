import * as Cloudflare from "@alchemy.run/cloudflare"
import { providers as domainProviders } from "@alchemy.run/domain/Cloudflare"
import ApiWorker from "./apps/api/src/ApiWorker.ts"
import { COMPATIBILITY_DATE } from "./apps/api/src/Compatibility.ts"
import { customDomains } from "./apps/api/src/CustomDomain.ts"
import { PiHarnessWorker } from "./apps/api/src/Pi/PiHarness.ts"
import { PRODUCTION_STAGE, protectInProduction } from "./apps/api/src/Protection.ts"
import PiHarnessWorkerLive from "./apps/api/src/Pi/PiHarnessWorker.ts"
import * as Alchemy from "alchemy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export const CLOUDFLARE_STATE_OBSERVABILITY = {
	enabled: true,
	logs: { enabled: true, invocationLogs: false },
} as const

export const inProduction = <E, R>(check: Effect.Effect<void, E, R>) =>
	Effect.gen(function* () {
		const ctx = yield* Alchemy.AlchemyContext
		if (!ctx.dev && (yield* Alchemy.Stage) === PRODUCTION_STAGE) {
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
			yield* PiHarnessWorker
			const api = yield* ApiWorker
			const mcp = yield* Cloudflare.Worker("McpWorker", {
				...(yield* customDomains).mcp,
				main: import.meta.resolve("./apps/mcp/src/Worker.ts"),
				compatibility: { date: COMPATIBILITY_DATE },
				observability: { enabled: true, issues: { enabled: true } },
				env: { API: api },
				dev: { port: 1338 },
			})
			const app = yield* Cloudflare.Website.Vite("App", {
				rootDir: "apps/app",
				main: "worker.ts",
				compatibility: { date: COMPATIBILITY_DATE },
				observability: { enabled: true },
				env: { API: api, CHECKFU_API_KEY: Config.Redacted("CHECKFU_API_KEY") },
				assets: {
					notFoundHandling: "single-page-application",
					runWorkerFirst: ["/*", "!/assets/*"],
				},
				dev: { port: 1340 },
			})
			return {
				api: api.url.as<string>(),
				mcp: mcp.url.as<string>(),
				app: app.url.as<string>(),
			}
		}).pipe(Effect.provide(PiHarnessWorkerLive), protectInProduction),
	)

export default checkfuStack(requireShippedBaseline)
