import * as Domain from "@alchemy.run/domain"
import { WebhookId } from "./Webhook.id.ts"
import { WebhookNotFound } from "./WebhookNotFound.rejection.ts"

export class WebhookEndpointDeleted extends Domain.Event("webhook.deleted") {}

export class DeleteWebhookEndpoint extends Domain.Command("DeleteWebhookEndpoint", {
	input: {
		webhook_id: WebhookId,
	},
	events: [WebhookEndpointDeleted],
	rejects: [WebhookNotFound],
}) {}
