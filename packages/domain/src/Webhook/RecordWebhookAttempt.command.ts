import * as Domain from "@alchemy.run/domain"
import { WebhookDeliveryId } from "@checkfu/sdk/Schemas"
import { AttemptResult, DeliveryLifecycleFields } from "./WebhookDeliveryLifecycle.ts"
import { NonNegativeInt } from "./WebhookTypes.ts"

export class WebhookAttemptRecorded extends Domain.Event(
	"webhook_delivery.attempt_recorded",
	DeliveryLifecycleFields,
) {}

export class RecordWebhookAttempt extends Domain.Command("RecordWebhookAttempt", {
	input: {
		delivery_id: WebhookDeliveryId,
		result: AttemptResult,
		at: NonNegativeInt,
		retry_delay_ms: NonNegativeInt,
	},
	events: [WebhookAttemptRecorded],
}) {}
