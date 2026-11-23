import * as Schema from "effect/Schema"
import { MAX_IDENTIFIER_LENGTH } from "./SessionTypes.ts"

export const SessionId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type
