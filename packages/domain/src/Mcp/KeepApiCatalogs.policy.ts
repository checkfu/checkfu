import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { ApiCatalogs } from "./ApiCatalogs.external.ts"
import { McpServerSet, McpServersRecorded } from "./McpServerSet.aggregate.ts"

/**
 * Confirms the documents a recorded server set names, so a document stays held
 * once a version or session depends on it, whatever happened to the request
 * that recorded the set.
 */
export class KeepApiCatalogs extends Domain.Policy("KeepApiCatalogs", {
	from: McpServerSet,
	on: [McpServersRecorded],
}) {}

export const KeepApiCatalogsLive = KeepApiCatalogs.toLayer(
	Effect.gen(function* () {
		const catalogs = yield* ApiCatalogs
		// A store that cannot be reached fails the delivery, which is then delivered again.
		return ({ source, event }) => catalogs.keep({ set_id: source.id, servers: event.servers })
	}),
)
