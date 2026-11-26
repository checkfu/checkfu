import * as Domain from "@alchemy.run/domain"
import { WebhookId } from "./Webhook.id.ts"
import { PositiveInt } from "./WebhookTypes.ts"

export class WebhookPreviousSecretExpired extends Domain.Event("webhook.previous_secret_expired", {
	expired_revision: PositiveInt,
}) {}

export class ExpirePreviousWebhookSecret extends Domain.Command("ExpirePreviousWebhookSecret", {
	input: {
		webhook_id: WebhookId,
		for_revision: PositiveInt,
	},
	events: [WebhookPreviousSecretExpired],
}) {}
