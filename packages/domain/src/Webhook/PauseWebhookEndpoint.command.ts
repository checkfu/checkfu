import * as Domain from "@alchemy.run/domain"
import { WebhookDeletedError } from "./WebhookDeleted.rejection.ts"
import { WebhookId } from "./Webhook.id.ts"
import { WebhookNotFound } from "./WebhookNotFound.rejection.ts"

export class WebhookEndpointPaused extends Domain.Event("webhook.paused") {}

export class PauseWebhookEndpoint extends Domain.Command("PauseWebhookEndpoint", {
	input: {
		webhook_id: WebhookId,
	},
	events: [WebhookEndpointPaused],
	rejects: [WebhookNotFound, WebhookDeletedError],
}) {}
