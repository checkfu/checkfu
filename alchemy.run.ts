import { fileURLToPath } from "node:url"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { providers as domainProviders } from "@alchemy.run/domain/Cloudflare"
import { ApiWorker } from "./apps/api/src/Api.ts"
import ApiWorkerLive from "./apps/api/src/ApiWorker.ts"
import { COMPATIBILITY_DATE } from "./apps/api/src/Compatibility.ts"
import { PUBLISH_DOMAIN_ENV, customDomains, publishDomain } from "./apps/api/src/CustomDomain.ts"
import { ContentWorker } from "./apps/api/src/Content/Content.ts"
import ContentWorkerLive from "./apps/api/src/Content/ContentWorker.ts"
import { PiHarnessWorker } from "./apps/api/src/Pi/PiHarness.ts"
import { PRODUCTION_STAGE, protectInProduction } from "./apps/api/src/Protection.ts"
import PiHarnessWorkerLive from "./apps/api/src/Pi/PiHarnessWorker.ts"
import * as Alchemy from "alchemy"
import * as Output from "alchemy/Output"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Option from "effect/Option"
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

export const publishDomainOnlyWhenRouted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		if (!(yield* Alchemy.AlchemyContext).dev) {
			return yield* effect
		}
		const provider = yield* ConfigProvider.ConfigProvider
		return yield* Effect.provideService(
			effect,
			ConfigProvider.ConfigProvider,
			ConfigProvider.make((path) =>
				path.length === 1 && path[0] === PUBLISH_DOMAIN_ENV
					? Effect.undefined
					: provider.load(path),
			),
		)
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
			const content = yield* ContentWorker
			const publish = yield* publishDomain
			if (publish !== undefined) {
				yield* Cloudflare.DNS.Record("PublishWildcard", {
					zoneId: Output.map(content.routes, (routes) => routes[0]?.zoneId ?? ""),
					name: `*.${publish}`,
					type: "AAAA",
					content: "100::",
					proxied: true,
				})
			}
			const api = yield* ApiWorker
			const mcp = yield* Cloudflare.Worker("McpWorker", {
				...(yield* customDomains).mcp,
				main: import.meta.resolve("./apps/mcp/src/Worker.ts"),
				compatibility: { date: COMPATIBILITY_DATE },
				observability: { enabled: true, issues: { enabled: true } },
				env: { API: api },
				dev: { port: 1338 },
			})
			const dashboardKey = yield* Config.option(Config.Redacted("CHECKFU_API_KEY"))
			const app = yield* Cloudflare.Website.Vite("App", {
				rootDir: fileURLToPath(new URL("./apps/app", import.meta.url)),
				main: "worker.ts",
				compatibility: { date: COMPATIBILITY_DATE },
				observability: { enabled: true },
				env: {
					API: api,
					CHECKFU_PUBLIC_API_URL: api.url.as<string>(),
					...Option.match(dashboardKey, {
						onNone: () => ({}),
						onSome: (key) => ({ CHECKFU_API_KEY: key }),
					}),
				},
				assets: {
					notFoundHandling: "single-page-application",
					runWorkerFirst: ["/*", "!/assets/*"],
				},
				dev: { port: 1340 },
			})
			return {
				api: api.url.as<string>(),
				content: content.url.as<string>(),
				mcp: mcp.url.as<string>(),
				app: app.url.as<string>(),
			}
		}).pipe(
			Effect.provide([PiHarnessWorkerLive, ContentWorkerLive, ApiWorkerLive]),
			publishDomainOnlyWhenRouted,
			(stack) => Effect.andThen(customDomains, stack),
			protectInProduction,
		),
	)

export default checkfuStack(requireShippedBaseline)
