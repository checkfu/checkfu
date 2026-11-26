import * as Domain from "@alchemy.run/domain"
import { WebhookId } from "./Webhook.id.ts"
import { PositiveInt } from "./WebhookTypes.ts"

export class WebhookSecretRotationInProgress extends Domain.Rejection(
	"WebhookSecretRotationInProgress",
	{
		webhook_id: WebhookId,
		previous_secret_expires_at: PositiveInt,
	},
	{
		httpApiStatus: 409,
		description:
			"A previous signing secret is still within its 24-hour rotation grace period. Wait until it expires before rotating again.",
	},
) {}
