import * as Schema from "effect/Schema"
import { MAX_IDENTIFIER_LENGTH } from "../Session/SessionTypes.ts"

export const IdempotencyClaimId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("IdempotencyClaimId"))
export type IdempotencyClaimId = typeof IdempotencyClaimId.Type
