import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"

export const RequestFingerprint = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
)

export class IdempotencyKeyClaimed extends Domain.Event("idempotency_key.claimed", {
	fingerprint: RequestFingerprint,
}) {}

export class ClaimIdempotencyKey extends Domain.Command("ClaimIdempotencyKey", {
	input: {
		session_id: SessionId,
		fingerprint: RequestFingerprint,
	},
	events: [IdempotencyKeyClaimed],
	rejects: [SessionNotFound, SessionTerminated],
}) {}
