import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"

export class WebhookInvalidUrl extends Domain.Rejection(
	"WebhookInvalidUrl",
	{ url: Schema.String },
	{
		httpApiStatus: 400,
		description:
			"Webhook destination must be a valid public HTTPS URL without credentials or fragments.",
	},
) {}
