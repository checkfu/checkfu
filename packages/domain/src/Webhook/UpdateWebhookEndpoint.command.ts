import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { WebhookDeletedError } from "./WebhookDeleted.rejection.ts"
import { WebhookId } from "./Webhook.id.ts"
import { WebhookInvalidUrl } from "./WebhookInvalidUrl.rejection.ts"
import { WebhookNotFound } from "./WebhookNotFound.rejection.ts"
import { WebhookDescription, WebhookEventFilterList, WebhookUrl } from "./WebhookTypes.ts"

export class WebhookEndpointUpdated extends Domain.Event("webhook.updated", {
	url: WebhookUrl,
	description: WebhookDescription,
	event_types: WebhookEventFilterList,
	reactivated: Schema.Boolean,
}) {}

export class UpdateWebhookEndpoint extends Domain.Command("UpdateWebhookEndpoint", {
	input: {
		webhook_id: WebhookId,
		url: Schema.NullOr(WebhookUrl),
		description: Schema.NullOr(WebhookDescription),
		event_types: Schema.NullOr(WebhookEventFilterList),
		reactivate: Schema.Boolean,
	},
	events: [WebhookEndpointUpdated],
	rejects: [WebhookNotFound, WebhookDeletedError, WebhookInvalidUrl],
}) {}
