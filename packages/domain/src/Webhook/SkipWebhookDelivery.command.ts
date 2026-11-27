import * as Domain from "@alchemy.run/domain"
import { WebhookDeliveryId } from "@checkfu/sdk/Schemas"
import { DeliveryLifecycleFields } from "./WebhookDeliveryLifecycle.ts"
import { NonNegativeInt } from "./WebhookTypes.ts"

export class WebhookDeliverySkipped extends Domain.Event(
	"webhook_delivery.skipped",
	DeliveryLifecycleFields,
) {}

export class SkipWebhookDelivery extends Domain.Command("SkipWebhookDelivery", {
	input: { delivery_id: WebhookDeliveryId, at: NonNegativeInt },
	events: [WebhookDeliverySkipped],
}) {}
