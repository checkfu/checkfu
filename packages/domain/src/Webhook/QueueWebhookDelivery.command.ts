import * as Domain from "@alchemy.run/domain"
import { WebhookDeliveryId } from "@checkfu/sdk/Schemas"
import { DeliveryLifecycleFields, WebhookAttemptLimit } from "./WebhookDeliveryLifecycle.ts"
import { NonNegativeInt } from "./WebhookTypes.ts"

export class WebhookDeliveryQueued extends Domain.Event(
	"webhook_delivery.queued",
	DeliveryLifecycleFields,
) {}

export class QueueWebhookDelivery extends Domain.Command("QueueWebhookDelivery", {
	input: { delivery_id: WebhookDeliveryId, max_attempts: WebhookAttemptLimit, at: NonNegativeInt },
	events: [WebhookDeliveryQueued],
}) {}
