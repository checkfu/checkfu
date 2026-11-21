import * as Schema from "effect/Schema"

export const AgentId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("AgentId"))
export type AgentId = typeof AgentId.Type
