import * as Domain from "@alchemy.run/domain"
import { CredentialDetached } from "./ArchiveCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { CredentialDeleted, DeleteCredential } from "./DeleteCredential.command.ts"
import { Vault } from "./Vault.aggregate.ts"

export class DeleteCredentialDecision extends Domain.Decision(DeleteCredential, {
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
		return [
			vault.record(new CredentialDetached({ credential_id: credential.id })),
			credential.record(new CredentialDeleted()),
		]
	},
	transitions: {
		ADeletedCredentialLeavesItsVault: ({ after, command }) =>
			[
				after.credential.status === "deleted",
				after.vault.credentials.every((held) => held.credential_id !== command.credential_id),
			].every((ok) => ok),
	},
}) {}
