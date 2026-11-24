import * as Domain from "@alchemy.run/domain"
import {
	ArchiveCredential,
	CredentialArchived,
	CredentialDetached,
} from "./ArchiveCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { Vault } from "./Vault.aggregate.ts"

/** Archiving frees the credential's slot and URL in its vault in the same step. */
export class ArchiveCredentialDecision extends Domain.Decision(ArchiveCredential, {
	reads: { vault: Vault, credential: Credential },
	keyOf: (cmd) => ({ vault: cmd.vault_id, credential: cmd.credential_id }),
	decide: ({ vault, credential }) => {
		if (
			[
				credential.state.status === "",
				credential.state.status === "deleted",
				credential.state.vault_id !== vault.id,
			].some((gone) => gone)
		) {
			return new CredentialNotFound({ credential_id: credential.id })
		}
		if (credential.state.status === "archived") {
			return []
		}
		return [
			vault.record(new CredentialDetached({ credential_id: credential.id })),
			credential.record(new CredentialArchived()),
		]
	},
	transitions: {
		AnArchivedCredentialLeavesItsVault: ({ after, command }) =>
			[
				after.credential.status === "archived",
				after.credential.vault_id === command.vault_id,
				after.vault.credentials.every((held) => held.credential_id !== command.credential_id),
			].every((ok) => ok),
	},
}) {}
