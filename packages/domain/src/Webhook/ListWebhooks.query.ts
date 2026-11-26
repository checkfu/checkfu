import * as Domain from "@alchemy.run/domain"
import { ResourceListCursor } from "@checkfu/sdk/Schemas"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InvalidListingCursor } from "../Listing/InvalidListingCursor.rejection.ts"
import { LIST_PAGE_MAX } from "../Listing/ListResources.query.ts"
import { ListingEntry, ListingOrder, ListingStore } from "../Listing/ListingStore.ts"
import { WebhookListing } from "./WebhookListing.projection.ts"

export class ListWebhooks extends Domain.Query(
	"ListWebhooks",
	{
		input: {
			order: ListingOrder,
		},
		success: ListingEntry,
		paged: true,
		waitsFor: [WebhookListing],
		rejects: [InvalidListingCursor],
	},
	{
		description: "Registered outbound webhook endpoints in creation order, a page at a time.",
	},
) {}

export const ListWebhooksLive = ListWebhooks.toLayer(
	Effect.gen(function* () {
		const store = yield* ListingStore
		const isCursor = Schema.is(ResourceListCursor)
		return ({ order }, page) =>
			page.after === undefined || isCursor(page.after)
				? store.page({ kind: "webhook", include_archived: false, agent_id: null, order }, page)
				: Effect.fail(new InvalidListingCursor({ cursor: page.after }))
	}),
	{ take: { default: 50, max: LIST_PAGE_MAX } },
)
