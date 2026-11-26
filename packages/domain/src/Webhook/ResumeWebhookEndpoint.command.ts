import * as Domain from "@alchemy.run/domain"
import { WebhookDeletedError } from "./WebhookDeleted.rejection.ts"
import { WebhookId } from "./Webhook.id.ts"
import { WebhookNotFound } from "./WebhookNotFound.rejection.ts"

export class WebhookEndpointResumed extends Domain.Event("webhook.resumed") {}

export class ResumeWebhookEndpoint extends Domain.Command("ResumeWebhookEndpoint", {
	input: {
		webhook_id: WebhookId,
	},
	events: [WebhookEndpointResumed],
	rejects: [WebhookNotFound, WebhookDeletedError],
}) {}
