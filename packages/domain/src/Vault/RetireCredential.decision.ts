import * as Domain from "@alchemy.run/domain"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import { RetireCredential } from "./RetireCredential.command.ts"
import { Vault } from "./Vault.aggregate.ts"

/** The vault's own state says how its credential ends, so nobody else can. */
export class RetireCredentialDecision extends Domain.Decision(RetireCredential, {
	reads: { vault: Vault, credential: Credential },
	keyOf: (cmd) => ({ vault: cmd.vault_id, credential: cmd.credential_id }),
	decide: ({ vault, credential }) => {
		if (credential.state.vault_id !== vault.id) {
			return []
		}
		if (vault.state.status === "archived") {
			return credential.state.status === "active"
				? [credential.record(new CredentialArchived())]
				: []
		}
		if (vault.state.status === "deleted") {
			return [credential.state.status === "active", credential.state.status === "archived"].some(
				(live) => live,
			)
				? [credential.record(new CredentialDeleted())]
				: []
		}
		return []
	},
	transitions: {
		OnlyAnEndedVaultRetiresItsCredential: ({ before, after }) =>
			[
				after.credential.status === before.credential.status,
				[
					before.credential.vault_id !== "",
					[before.vault.status === "archived", before.vault.status === "deleted"].some(
						(ended) => ended,
					),
				].every((ok) => ok),
			].some((ok) => ok),
	},
}) {}
