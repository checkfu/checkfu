import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { NonEmptyString } from "./VaultTypes.ts"

export const CredentialUrlClaimId = NonEmptyString.pipe(Schema.brand("CredentialUrlClaimId"))
export type CredentialUrlClaimId = typeof CredentialUrlClaimId.Type

export const credentialUrlClaimId = (vaultId: string, mcpServerUrl: string): CredentialUrlClaimId =>
	CredentialUrlClaimId.make(`${vaultId}/${mcpServerUrl}`)

export class CredentialUrlClaimed extends Domain.Event("vault_credential_url.claimed", {
	credential_id: NonEmptyString,
}) {}

export class CredentialUrlFreed extends Domain.Event("vault_credential_url.freed") {}

export const CredentialUrlClaimState = Schema.Struct({ holder: Schema.String })

export class CredentialUrlClaim extends Domain.Aggregate("CredentialUrlClaim", {
	id: CredentialUrlClaimId,
	state: versionedSnapshot({ current: 1, schema: CredentialUrlClaimState }),
	initial: { holder: "" },
	commands: [],
	events: [CredentialUrlClaimed, CredentialUrlFreed],
	transitions: {
		AHeldUrlIsNeverTakenOver: ({ before, after }) =>
			[before.holder === "", after.holder === before.holder, after.holder === ""].some((ok) => ok),
	},
	decide: {},
	evolve: {
		"vault_credential_url.claimed": (state, e) =>
			state.holder === "" ? { holder: e.credential_id } : state,
		"vault_credential_url.freed": () => ({ holder: "" }),
	},
}) {}
