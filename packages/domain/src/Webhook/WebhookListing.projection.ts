import * as Domain from "@alchemy.run/domain"
import type * as Projection from "@alchemy.run/domain/Projection"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { DELETED, LISTED, ListingStore } from "../Listing/ListingStore.ts"
import type { ListingChange } from "../Listing/ListingStore.ts"
import { WebhookEndpointCreated } from "./CreateWebhookEndpoint.command.ts"
import { WebhookEndpointDeleted } from "./DeleteWebhookEndpoint.command.ts"
import { WebhookEndpoint } from "./WebhookEndpoint.aggregate.ts"

export class WebhookListing extends Domain.Projection(
	"WebhookListing",
	{
		from: [WebhookEndpoint],
		key: Schema.String,
		keyOf: {
			WebhookEndpoint: ({ source }) => source.id,
		},
		on: [WebhookEndpointCreated, WebhookEndpointDeleted],
	},
	{
		description: "Every webhook endpoint in creation order with its listing status.",
	},
) {}

const changeOf = ({
	key: id,
	event,
	envelope,
}: Projection.InputOf<typeof WebhookListing>): ListingChange => ({
	kind: "webhook",
	id,
	created_at: DateTime.toEpochMillis(envelope.at),
	agent_id: null,
	status: event._tag === "webhook.deleted" ? DELETED : LISTED,
})

export const WEBHOOK_LISTING_VERSION = 1

export const WebhookListingLive = WebhookListing.toLayer(
	Effect.gen(function* () {
		const store = yield* ListingStore
		return (batch) => store.record(batch.map(changeOf))
	}),
	{ batch: { size: 100 }, version: WEBHOOK_LISTING_VERSION },
)
