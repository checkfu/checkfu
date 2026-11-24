import type * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { ApiCatalog } from "../OpenApi/ApiCatalog.ts"
import { ApiCatalogLive } from "../OpenApi/ApiCatalog.do.ts"
import { Connection } from "./Connection.ts"
import { ConnectionLive } from "./Connection.do.ts"
import { ConnectionWorker } from "./ConnectionHost.ts"

export const CONNECTION_WORKER_PROPS = {
	main: import.meta.url,
	compatibility: { date: "2026-11-17" },
	workersDev: false,
	observability: {
		enabled: true,
		traces: { enabled: false },
		issues: { enabled: true },
	},
	dev: { port: 1341 },
} satisfies Cloudflare.WorkerProps

export default ConnectionWorker.make(
	CONNECTION_WORKER_PROPS,
	Effect.gen(function* () {
		yield* Connection
		yield* ApiCatalog
		return ConnectionWorker.of({})
	}).pipe(Effect.provide([ConnectionLive, ApiCatalogLive])),
)
