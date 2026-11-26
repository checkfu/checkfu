import * as Domain from "@alchemy.run/domain"
import { WebhookAlreadyExists } from "./WebhookAlreadyExists.rejection.ts"
import { WebhookId } from "./Webhook.id.ts"
import { WebhookInvalidUrl } from "./WebhookInvalidUrl.rejection.ts"
import {
	WebhookDescription,
	WebhookEventFilterList,
	WebhookSecretSalt,
	WebhookUrl,
} from "./WebhookTypes.ts"

export class WebhookEndpointCreated extends Domain.Event("webhook.created", {
	url: WebhookUrl,
	description: WebhookDescription,
	event_types: WebhookEventFilterList,
	secret_salt: WebhookSecretSalt,
}) {}

export class CreateWebhookEndpoint extends Domain.Command("CreateWebhookEndpoint", {
	input: {
		webhook_id: WebhookId,
		url: WebhookUrl,
		description: WebhookDescription,
		event_types: WebhookEventFilterList,
		secret_salt: WebhookSecretSalt,
	},
	events: [WebhookEndpointCreated],
	rejects: [WebhookAlreadyExists, WebhookInvalidUrl],
}) {}
