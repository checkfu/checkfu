import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ResourceListCursor } from "@checkfu/sdk/Schemas"
import { InvalidListingCursor } from "../Listing/InvalidListingCursor.rejection.ts"
import { LIST_PAGE_MAX } from "../Listing/ListResources.query.ts"
import { ListingEntry, ListingOrder, ListingStore } from "../Listing/ListingStore.ts"
import { VaultListing } from "./VaultListing.projection.ts"

export class ListVaults extends Domain.Query(
	"ListVaults",
	{
		input: {
			include_archived: Schema.Boolean,
			order: ListingOrder,
		},
		success: ListingEntry,
		paged: true,
		waitsFor: [VaultListing],
		rejects: [InvalidListingCursor],
	},
	{
		description:
			"Vaults in creation order, a page at a time, leaving out archived ones unless asked.",
	},
) {}

export const ListVaultsLive = ListVaults.toLayer(
	Effect.gen(function* () {
		const store = yield* ListingStore
		const isCursor = Schema.is(ResourceListCursor)
		return (input, page) =>
			page.after === undefined || isCursor(page.after)
				? store.page({ kind: "vault", agent_id: null, ...input }, page)
				: Effect.fail(new InvalidListingCursor({ cursor: page.after }))
	}),
	{ take: { default: 50, max: LIST_PAGE_MAX } },
)
