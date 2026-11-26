import * as Domain from "@alchemy.run/domain"
import { WebhookDeletedError } from "./WebhookDeleted.rejection.ts"
import { WebhookId } from "./Webhook.id.ts"
import { WebhookNotFound } from "./WebhookNotFound.rejection.ts"
import { PositiveInt, WebhookSecretSalt } from "./WebhookTypes.ts"

export class WebhookSecretRotated extends Domain.Event("webhook.secret_rotated", {
	secret_revision: PositiveInt,
	secret_salt: WebhookSecretSalt,
	previous_secret_revision: PositiveInt,
	previous_secret_salt: WebhookSecretSalt,
	previous_secret_expires_at: PositiveInt,
}) {}

export class RotateWebhookSecret extends Domain.Command("RotateWebhookSecret", {
	input: {
		webhook_id: WebhookId,
		next_secret_salt: WebhookSecretSalt,
		grace_until: PositiveInt,
	},
	events: [WebhookSecretRotated],
	rejects: [WebhookNotFound, WebhookDeletedError],
}) {}
