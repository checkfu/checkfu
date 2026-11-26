import * as Domain from "@alchemy.run/domain"
import type * as Policy from "@alchemy.run/domain/Policy"
import type { WebhookEventType } from "@checkfu/sdk/Schemas"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { WebhookEvents } from "../Webhook/WebhookEvents.external.ts"
import type { WebhookResourceType } from "../Webhook/WebhookEvents.external.ts"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { VaultArchived } from "./ArchiveVault.command.ts"
import { CredentialCreated } from "./CreateCredential.command.ts"
import { VaultCreated } from "./CreateVault.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import { VaultDeleted } from "./DeleteVault.command.ts"
import { Vault } from "./Vault.aggregate.ts"

export class PublishVaultWebhookEvents extends Domain.Policy(
	"PublishVaultWebhookEvents",
	{
		from: [Vault, Credential],
		on: [
			VaultCreated,
			VaultArchived,
			VaultDeleted,
			CredentialCreated,
			CredentialArchived,
			CredentialDeleted,
		],
	},
	{
		description:
			"Forwards committed vault and vault credential lifecycle events to registered outbound webhook listeners.",
	},
) {}

interface VaultWebhookNotification {
	readonly event_type: WebhookEventType
	readonly resource_type: WebhookResourceType
	readonly resource_id: string
	readonly vault_id?: string
}

const notificationOf = ({
	source,
	event,
}: Policy.TriggerOf<typeof PublishVaultWebhookEvents>): VaultWebhookNotification => {
	switch (event._tag) {
		case "vault.created":
		case "vault.archived":
		case "vault.deleted":
			return { event_type: event._tag, resource_type: "vault", resource_id: source.id }
		case "vault_credential.created":
		case "vault_credential.archived":
		case "vault_credential.deleted":
			return {
				event_type: event._tag,
				resource_type: "vault_credential",
				resource_id: source.id,
				vault_id: event.vault_id,
			}
	}
}

export const PublishVaultWebhookEventsLive = PublishVaultWebhookEvents.toLayer(
	Effect.gen(function* () {
		const events = yield* WebhookEvents
		return Effect.fn(function* (trigger) {
			const notification = notificationOf(trigger)
			yield* events.publish({
				event_id: `evt_${notification.resource_type}_${trigger.source.id}_${trigger.envelope.seq}`,
				...notification,
				occurred_at: DateTime.toEpochMillis(trigger.envelope.at),
			})
		})
	}),
	{ retry: Schedule.max([Schedule.exponential("200 millis"), Schedule.recurs(6)]) },
)
