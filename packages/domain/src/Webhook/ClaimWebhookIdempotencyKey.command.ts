import * as Domain from "@alchemy.run/domain"
import { RequestFingerprint } from "../Session/ClaimIdempotencyKey.command.ts"
import { WebhookDeletedError } from "./WebhookDeleted.rejection.ts"
import { WebhookId } from "./Webhook.id.ts"
import { WebhookNotFound } from "./WebhookNotFound.rejection.ts"

export class WebhookIdempotencyKeyClaimed extends Domain.Event("webhook.idempotency_key_claimed", {
	fingerprint: RequestFingerprint,
}) {}

export class ClaimWebhookIdempotencyKey extends Domain.Command("ClaimWebhookIdempotencyKey", {
	input: {
		webhook_id: WebhookId,
		fingerprint: RequestFingerprint,
	},
	events: [WebhookIdempotencyKeyClaimed],
	rejects: [WebhookNotFound, WebhookDeletedError],
}) {}
