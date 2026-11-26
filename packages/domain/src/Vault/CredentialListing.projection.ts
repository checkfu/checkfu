import * as Domain from "@alchemy.run/domain"
import type * as Projection from "@alchemy.run/domain/Projection"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ARCHIVED, DELETED, LISTED, ListingStore } from "../Listing/ListingStore.ts"
import type { ListingChange } from "../Listing/ListingStore.ts"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { CredentialCreated } from "./CreateCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"

export class CredentialListing extends Domain.Projection(
	"CredentialListing",
	{
		from: [Credential],
		key: Schema.String,
		keyOf: { Credential: ({ source }) => source.id },
		on: [CredentialCreated, CredentialArchived, CredentialDeleted],
	},
	{ description: "Every credential under its vault, in creation order, with its status." },
) {}

const STATUS = {
	"vault_credential.created": LISTED,
	"vault_credential.archived": ARCHIVED,
	"vault_credential.deleted": DELETED,
} as const

const changeOf = ({
	key: id,
	event,
	envelope,
}: Projection.InputOf<typeof CredentialListing>): ListingChange => ({
	kind: "vault_credential",
	id,
	created_at: DateTime.toEpochMillis(envelope.at),
	agent_id: event.vault_id,
	status: STATUS[event._tag],
})

export const CredentialListingLive = CredentialListing.toLayer(
	Effect.gen(function* () {
		const store = yield* ListingStore
		return (batch) => store.record(batch.map(changeOf))
	}),
	{ batch: { size: 100 } },
)
