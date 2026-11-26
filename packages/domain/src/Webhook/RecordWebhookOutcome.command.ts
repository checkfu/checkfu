import * as Domain from "@alchemy.run/domain"
import { WebhookId } from "./Webhook.id.ts"
import { PositiveInt, WebhookDisableReason, WebhookOutcomeKind } from "./WebhookTypes.ts"

export class WebhookHealthCleared extends Domain.Event("webhook.health_cleared") {}

export class WebhookHealthReanchored extends Domain.Event("webhook.health_reanchored", {
	window_started_at: PositiveInt,
	last_failure_at: PositiveInt,
}) {}

export class WebhookHealthDegraded extends Domain.Event("webhook.health_degraded", {
	window_started_at: PositiveInt,
	last_failure_at: PositiveInt,
}) {}

export class WebhookDisabledByHealth extends Domain.Event("webhook.disabled_by_health", {
	reason: WebhookDisableReason,
	window_started_at: PositiveInt,
	last_failure_at: PositiveInt,
}) {}

export class RecordWebhookOutcome extends Domain.Command("RecordWebhookOutcome", {
	input: {
		webhook_id: WebhookId,
		definition_revision: PositiveInt,
		outcome: WebhookOutcomeKind,
		observed_at: PositiveInt,
	},
	events: [
		WebhookHealthCleared,
		WebhookHealthReanchored,
		WebhookHealthDegraded,
		WebhookDisabledByHealth,
	],
}) {}
