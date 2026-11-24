import * as Domain from "@alchemy.run/domain"
import { McpServerSetId } from "./McpServerSet.aggregate.ts"
import { McpServersText } from "./McpServers.ts"

/**
 * The stores that hold API servers' documents, outside the model. A document
 * is held unconfirmed until a recorded server set names it, and erases itself
 * if none ever does.
 */
export class ApiCatalogs extends Domain.ExternalSystem("ApiCatalogs", {
	/** Confirms every document the recorded set names. A set that names none confirms nothing. */
	keep: {
		args: { set_id: McpServerSetId, servers: McpServersText },
	},
}) {}
