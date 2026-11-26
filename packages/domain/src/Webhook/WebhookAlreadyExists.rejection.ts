import * as Domain from "@alchemy.run/domain"
import { WebhookId } from "./Webhook.id.ts"

export class WebhookAlreadyExists extends Domain.Rejection(
	"WebhookAlreadyExists",
	{ webhook_id: WebhookId },
	{ httpApiStatus: 409, description: "Webhook endpoint already exists." },
) {}
