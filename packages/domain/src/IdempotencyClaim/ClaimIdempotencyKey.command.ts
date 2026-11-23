import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { IdempotencyClaimId } from "./IdempotencyClaim.id.ts"

export const RequestFingerprint = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
)

export class IdempotencyKeyClaimed extends Domain.Event("idempotency_key.claimed", {
	fingerprint: RequestFingerprint,
}) {}

export class IdempotencyKeyConflict extends Domain.Rejection(
	"IdempotencyKeyConflict",
	{ claim_id: IdempotencyClaimId },
	{
		httpApiStatus: 409,
		description: "Idempotency-Key was already used for a different request.",
	},
) {}

export class ClaimIdempotencyKey extends Domain.Command("ClaimIdempotencyKey", {
	input: {
		claim_id: IdempotencyClaimId,
		fingerprint: RequestFingerprint,
	},
	events: [IdempotencyKeyClaimed],
	rejects: [IdempotencyKeyConflict],
}) {}
