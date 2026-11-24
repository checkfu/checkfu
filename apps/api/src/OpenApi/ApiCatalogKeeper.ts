import { ApiCatalogs } from "@checkfu/domain/Mcp/ApiCatalogs.external"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ApiCatalogExecutor } from "./ApiCatalogExecutor.ts"

// Both an agent version's API servers and a session's bindings name their documents.
const NamedCatalogs = Schema.fromJsonString(
	Schema.Array(Schema.Struct({ catalog_id: Schema.String.check(Schema.isMinLength(1)) })),
)
const catalogIdsOf = (setId: string, servers: string): ReadonlyArray<string> =>
	!setId.endsWith("/api_servers") || servers === ""
		? []
		: [...new Set(Schema.decodeSync(NamedCatalogs)(servers).map((server) => server.catalog_id))]

export const ApiCatalogsLive = ApiCatalogs.toLayer(
	Effect.map(ApiCatalogExecutor, (executor) => ({
		keep: ({ set_id, servers }) =>
			Effect.forEach(
				catalogIdsOf(set_id, servers),
				(catalogId) => Effect.orDie(executor.keep(catalogId)),
				{
					discard: true,
				},
			),
	})),
)
