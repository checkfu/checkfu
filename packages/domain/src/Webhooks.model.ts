import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import {
	ExpirePreviousWebhookSecrets,
	ExpirePreviousWebhookSecretsLive,
} from "./Webhook/ExpirePreviousWebhookSecrets.policy.ts"
import { WebhookEndpoint } from "./Webhook/WebhookEndpoint.aggregate.ts"
import { WebhookListing, WebhookListingLive } from "./Webhook/WebhookListing.projection.ts"

export class Webhooks extends Domain.Model("Webhooks", {
	aggregates: [WebhookEndpoint],
	policies: [ExpirePreviousWebhookSecrets],
	projections: [WebhookListing],
	sometimes: {
		AnEndpointIsCreated: (m) => m.WebhookEndpoint.some((w) => w.state.status === "active"),
		AnEndpointRotatesItsSecret: (m) =>
			m.WebhookEndpoint.some((w) =>
				[
					w.state.status === "active",
					w.state.secret_revision >= 2,
					w.state.previous_secret_revision >= 1,
				].every((ok) => ok),
			),
		AnEndpointExpiresItsPreviousSecret: (m) =>
			m.WebhookEndpoint.some((w) =>
				[
					w.state.status === "active",
					w.state.secret_revision >= 2,
					w.state.previous_secret_revision === 0,
				].every((ok) => ok),
			),
		AnEndpointIsPaused: (m) => m.WebhookEndpoint.some((w) => w.state.status === "paused"),
		AnEndpointIsDisabledByRedirect: (m) =>
			m.WebhookEndpoint.some((w) => w.state.status === "disabled_redirect"),
		AnEndpointIsDisabledBySustainedFailure: (m) =>
			m.WebhookEndpoint.some((w) => w.state.status === "disabled_sustained_failure"),
		AnEndpointIsDeleted: (m) => m.WebhookEndpoint.some((w) => w.state.status === "deleted"),
	},
}) {}

export class WebhooksDomainApi extends Domain.Api("WebhooksDomainApi", {
	model: Webhooks,
	commands: [
		"CreateWebhookEndpoint",
		"UpdateWebhookEndpoint",
		"PauseWebhookEndpoint",
		"ResumeWebhookEndpoint",
		"RotateWebhookSecret",
		"ExpirePreviousWebhookSecret",
		"RecordWebhookOutcome",
		"DeleteWebhookEndpoint",
		"ClaimWebhookIdempotencyKey",
	],
}) {}

export const WebhooksHandlersLive = Layer.mergeAll(
	ExpirePreviousWebhookSecretsLive,
	WebhookListingLive,
)
