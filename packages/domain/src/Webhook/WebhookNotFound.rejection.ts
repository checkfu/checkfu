import * as Domain from "@alchemy.run/domain"
import { WebhookId } from "./Webhook.id.ts"

export class WebhookNotFound extends Domain.Rejection(
	"WebhookNotFound",
	{ webhook_id: WebhookId },
	{ httpApiStatus: 404, description: "Webhook endpoint does not exist." },
) {}
