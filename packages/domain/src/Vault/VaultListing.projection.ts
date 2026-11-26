import * as Domain from "@alchemy.run/domain"
import type * as Projection from "@alchemy.run/domain/Projection"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ARCHIVED, DELETED, LISTED, ListingStore } from "../Listing/ListingStore.ts"
import type { ListingChange } from "../Listing/ListingStore.ts"
import { VaultArchived } from "./ArchiveVault.command.ts"
import { VaultCreated } from "./CreateVault.command.ts"
import { VaultDeleted } from "./DeleteVault.command.ts"
import { Vault } from "./Vault.aggregate.ts"

export class VaultListing extends Domain.Projection(
	"VaultListing",
	{
		from: [Vault],
		key: Schema.String,
		keyOf: { Vault: ({ source }) => source.id },
		on: [VaultCreated, VaultArchived, VaultDeleted],
	},
	{ description: "Every vault, in creation order, with its status." },
) {}

const STATUS = {
	"vault.created": LISTED,
	"vault.archived": ARCHIVED,
	"vault.deleted": DELETED,
} as const

const changeOf = ({
	key: id,
	event,
	envelope,
}: Projection.InputOf<typeof VaultListing>): ListingChange => ({
	kind: "vault",
	id,
	created_at: DateTime.toEpochMillis(envelope.at),
	agent_id: null,
	status: STATUS[event._tag],
})

export const VaultListingLive = VaultListing.toLayer(
	Effect.gen(function* () {
		const store = yield* ListingStore
		return (batch) => store.record(batch.map(changeOf))
	}),
	{ batch: { size: 100 } },
)
