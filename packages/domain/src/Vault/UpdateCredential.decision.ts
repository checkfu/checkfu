import * as Domain from "@alchemy.run/domain"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialArchivedError } from "./CredentialArchived.rejection.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { CredentialRenamed, UpdateCredential } from "./UpdateCredential.command.ts"
import { Vault } from "./Vault.aggregate.ts"
import { VaultArchivedError } from "./VaultArchived.rejection.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"

export class UpdateCredentialDecision extends Domain.Decision(UpdateCredential, {
	reads: { vault: Vault, credential: Credential },
	keyOf: (cmd) => ({ vault: cmd.vault_id, credential: cmd.credential_id }),
	decide: ({ vault, credential }, cmd) => {
		if ([vault.state.status === "", vault.state.status === "deleted"].some((gone) => gone)) {
			return new VaultNotFound({ vault_id: vault.id })
		}
		if (
			[
				credential.state.status === "",
				credential.state.status === "deleted",
				credential.state.vault_id !== vault.id,
			].some((gone) => gone)
		) {
			return new CredentialNotFound({ credential_id: credential.id })
		}
		if (credential.state.status !== "active") {
			return new CredentialArchivedError({ credential_id: credential.id })
		}
		if (vault.state.status !== "active") {
			return new VaultArchivedError({ vault_id: vault.id })
		}
		if (cmd.changes.display_name === undefined) {
			return []
		}
		return [credential.record(new CredentialRenamed({ display_name: cmd.changes.display_name }))]
	},
	transitions: {
		OnlyAnActiveCredentialInAnActiveVaultIsRenamed: ({ before, command, events }) =>
			[
				events.length === 0,
				[
					before.vault.status === "active",
					before.credential.status === "active",
					before.credential.vault_id === command.vault_id,
				].every((ok) => ok),
			].some((ok) => ok),
	},
}) {}
