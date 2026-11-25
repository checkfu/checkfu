import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ResourceListCursor } from "@checkfu/sdk/Schemas"
import { InvalidListingCursor } from "./InvalidListingCursor.rejection.ts"
import { Listing } from "./Listing.projection.ts"
import { ListingEntry, ListingKind, ListingOrder, ListingStore } from "./ListingStore.ts"

export const LIST_PAGE_MAX = 100

export class ListResources extends Domain.Query(
	"ListResources",
	{
		input: {
			kind: ListingKind,
			include_archived: Schema.Boolean,
			agent_id: Schema.NullOr(Schema.String),
			order: ListingOrder,
		},
		success: ListingEntry,
		paged: true,
		waitsFor: [Listing],
		rejects: [InvalidListingCursor],
	},
	{
		description:
			"Agents, environments, sessions, automations or artifacts in creation order, a page at a time, leaving out archived ones unless asked.",
	},
) {}

export const ListResourcesLive = ListResources.toLayer(
	Effect.gen(function* () {
		const store = yield* ListingStore
		const isCursor = Schema.is(ResourceListCursor)
		return (input, page) =>
			page.after === undefined || isCursor(page.after)
				? store.page(input, page)
				: Effect.fail(new InvalidListingCursor({ cursor: page.after }))
	}),
	{ take: { default: 50, max: LIST_PAGE_MAX } },
)
