import * as Schema from "effect/Schema"

export const AgentVersionId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("AgentVersionId"),
)
export type AgentVersionId = typeof AgentVersionId.Type
