import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { EventBatchId } from "./EventBatch.id.ts"

export const BatchFingerprint = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export class EventBatchClaimed extends Domain.Event("event_batch.claimed", {
	fingerprint: BatchFingerprint,
}) {}

export class IdempotencyKeyConflict extends Domain.Rejection(
	"IdempotencyKeyConflict",
	{ batch_id: EventBatchId },
	{
		httpApiStatus: 409,
		description: "Idempotency-Key was already used for a different request.",
	},
) {}

export class ClaimEventBatch extends Domain.Command("ClaimEventBatch", {
	input: {
		batch_id: EventBatchId,
		fingerprint: BatchFingerprint,
	},
	events: [EventBatchClaimed],
	rejects: [IdempotencyKeyConflict],
}) {}
