import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type { CatalogConfig, CatalogRequest, CatalogTools } from "./ApiCatalogStore.ts"

// Durable Object RPC methods: the stub calls them, so none can be a plain Effect value.
/* oxlint-disable effecttsgo/lazy-effect */
export interface ApiCatalogShape {
	readonly alarm: () => Effect.Effect<void>
	readonly store: (document: string, config: CatalogConfig) => Effect.Effect<boolean>
	readonly keep: () => Effect.Effect<void>
	readonly tools: () => Effect.Effect<CatalogTools>
	readonly request: (name: string, args: Schema.JsonObject) => Effect.Effect<CatalogRequest>
}
/* oxlint-enable effecttsgo/lazy-effect */

/**
 * One object per API server of an agent version, named by the server's
 * catalog id: the only place the server's OpenAPI document is kept. Sessions
 * ask it for the API's tools and for the request a tool call comes to.
 */
export class ApiCatalog extends Cloudflare.DurableObject<ApiCatalog, ApiCatalogShape>()(
	"ApiCatalog",
) {}
