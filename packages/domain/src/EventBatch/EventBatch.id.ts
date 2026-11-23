import * as Schema from "effect/Schema"
import { MAX_IDENTIFIER_LENGTH } from "../Session/SessionTypes.ts"

export const EventBatchId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("EventBatchId"))
export type EventBatchId = typeof EventBatchId.Type
