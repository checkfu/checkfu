import * as Domain from "@alchemy.run/domain"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { WebhookEndpointDeleted } from "./DeleteWebhookEndpoint.command.ts"
import { ExpirePreviousWebhookSecret } from "./ExpirePreviousWebhookSecret.command.ts"
import { WebhookSecretRotated } from "./RotateWebhookSecret.command.ts"
import { WebhookEndpoint } from "./WebhookEndpoint.aggregate.ts"

export const EXPIRE_PREVIOUS_SECRET = "expire-previous-secret"

export class ExpirePreviousWebhookSecrets extends Domain.Policy("ExpirePreviousWebhookSecrets", {
	from: WebhookEndpoint,
	on: [WebhookSecretRotated, WebhookEndpointDeleted],
}) {}

export const ExpirePreviousWebhookSecretsLive = ExpirePreviousWebhookSecrets.toLayer(
	Effect.gen(function* () {
		const webhooks = yield* WebhookEndpoint
		return Effect.fn(function* ({ source, event }) {
			if (event._tag === "webhook.deleted") {
				yield* webhooks
					.unschedule(source.id, EXPIRE_PREVIOUS_SECRET)
					.pipe(
						Effect.catchTag(
							["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"],
							() => Effect.void,
						),
					)
				return
			}
			yield* webhooks.schedule(
				new ExpirePreviousWebhookSecret({
					webhook_id: source.id,
					for_revision: event.secret_revision,
				}),
				{
					at: DateTime.makeUnsafe(event.previous_secret_expires_at),
					commandId: EXPIRE_PREVIOUS_SECRET,
				},
			)
		})
	}),
)
