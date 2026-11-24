import {
	ApiSelection,
	ApiServerName,
	ApiSpecSummary,
	MAX_API_SERVERS,
	McpServerUrl,
} from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { McpServerSetId } from "./McpServerSet.aggregate.ts"
import { McpToolPermissions, listText } from "./McpServers.ts"

export {
	ApiSelection,
	ApiSpecSummary,
	MAX_API_SERVERS,
	MAX_API_SERVER_DESCRIPTORS_JSON_BYTES,
	MAX_API_SERVER_OPERATIONS,
	MAX_API_SPEC_JSON_BYTES,
} from "@checkfu/sdk/Schemas"

const apiServerFields = {
	name: ApiServerName,
	base_url: McpServerUrl,
	// Names the stored document. A later version that keeps the server keeps this, so it never needs the document again.
	catalog_id: Schema.String.check(Schema.isMinLength(1)),
	permissions: Schema.optionalKey(McpToolPermissions),
}

/** An HTTP API an agent version calls. Its OpenAPI document is held by the catalog `catalog_id` names. */
export const ApiServer = Schema.Struct({
	type: Schema.Literal("openapi"),
	...apiServerFields,
	include: Schema.optionalKey(ApiSelection),
	exclude: Schema.optionalKey(ApiSelection),
	spec: ApiSpecSummary,
})
export type ApiServer = typeof ApiServer.Type

/** An agent's API server, as one session uses it: with the credential it was bound to, or none. */
export const ApiServerBinding = Schema.Struct({
	...apiServerFields,
	credential_id: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
})
export type ApiServerBinding = typeof ApiServerBinding.Type

/**
 * API servers are kept the way MCP servers are: as text recorded once, under
 * the agent version or the session they belong to, before it exists.
 */
export const ApiServerList = listText(ApiServer, MAX_API_SERVERS)
export const ApiServerBindingList = listText(ApiServerBinding, MAX_API_SERVERS)

export const apiServerSetId = (ownerId: string): McpServerSetId =>
	McpServerSetId.make(`${ownerId}/api_servers`)
