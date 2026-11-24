import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
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
	},
	{
		description:
			"Agents, environments or sessions in creation order, a page at a time, leaving out archived ones unless asked.",
	},
) {}

export const ListResourcesLive = ListResources.toLayer(
	Effect.gen(function* () {
		const store = yield* ListingStore
		return (input, page) => store.page(input, page)
	}),
	{ take: { default: 50, max: LIST_PAGE_MAX } },
)
