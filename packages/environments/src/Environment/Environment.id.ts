import * as Schema from "effect/Schema"

export const EnvironmentId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("EnvironmentId"),
)
export type EnvironmentId = typeof EnvironmentId.Type
