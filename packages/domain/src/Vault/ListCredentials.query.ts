import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ResourceListCursor } from "@checkfu/sdk/Schemas"
import { InvalidListingCursor } from "../Listing/InvalidListingCursor.rejection.ts"
import { LIST_PAGE_MAX } from "../Listing/ListResources.query.ts"
import { ListingEntry, ListingOrder, ListingStore } from "../Listing/ListingStore.ts"
import { CredentialListing } from "./CredentialListing.projection.ts"
import { VaultId } from "./Vault.id.ts"

export class ListCredentials extends Domain.Query(
	"ListCredentials",
	{
		input: {
			vault_id: VaultId,
			include_archived: Schema.Boolean,
			order: ListingOrder,
		},
		success: ListingEntry,
		paged: true,
		waitsFor: [CredentialListing],
		rejects: [InvalidListingCursor],
	},
	{
		description:
			"One vault's credentials in creation order, a page at a time, leaving out archived ones unless asked.",
	},
) {}

export const ListCredentialsLive = ListCredentials.toLayer(
	Effect.gen(function* () {
		const store = yield* ListingStore
		const isCursor = Schema.is(ResourceListCursor)
		return ({ vault_id, ...input }, page) =>
			page.after === undefined || isCursor(page.after)
				? store.page({ kind: "vault_credential", agent_id: vault_id, ...input }, page)
				: Effect.fail(new InvalidListingCursor({ cursor: page.after }))
	}),
	{ take: { default: 50, max: LIST_PAGE_MAX } },
)
