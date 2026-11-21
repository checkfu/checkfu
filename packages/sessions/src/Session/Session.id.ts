import * as Schema from "effect/Schema"

export const SessionId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type
