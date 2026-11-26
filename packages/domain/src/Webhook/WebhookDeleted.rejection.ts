import * as Domain from "@alchemy.run/domain"
import { WebhookId } from "./Webhook.id.ts"

export class WebhookDeletedError extends Domain.Rejection(
	"WebhookDeletedError",
	{ webhook_id: WebhookId },
	{ httpApiStatus: 409, description: "Webhook endpoint has been deleted." },
) {}
