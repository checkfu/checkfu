import * as Domain from "@alchemy.run/domain"
import {
	CreateCredential,
	CredentialAlreadyExists,
	CredentialAttached,
	CredentialCreated,
	CredentialLimitReached,
	CredentialUrlConflict,
} from "./CreateCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { Vault } from "./Vault.aggregate.ts"
import { VaultArchivedError } from "./VaultArchived.rejection.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"
import { MAX_VAULT_CREDENTIALS } from "./VaultTypes.ts"

/**
 * A vault's limit and its one-credential-per-URL rule are the vault's to keep,
 * and whether an id is free is the credential's, so one decision reads both
 * and records on both or on neither.
 */
export class CreateCredentialDecision extends Domain.Decision(CreateCredential, {
	reads: { vault: Vault, credential: Credential },
	keyOf: (cmd) => ({ vault: cmd.vault_id, credential: cmd.credential_id }),
	decide: ({ vault, credential }, cmd) => {
		if ([vault.state.status === "", vault.state.status === "deleted"].some((gone) => gone)) {
			return new VaultNotFound({ vault_id: vault.id })
		}
		if (vault.state.status !== "active") {
			return new VaultArchivedError({ vault_id: vault.id })
		}
		if (credential.state.status !== "") {
			return new CredentialAlreadyExists({ credential_id: credential.id })
		}
		if (vault.state.credentials.length >= MAX_VAULT_CREDENTIALS) {
			return new CredentialLimitReached({ vault_id: vault.id, limit: MAX_VAULT_CREDENTIALS })
		}
		const holder = vault.state.credentials.find(
			(held) => held.mcp_server_url === cmd.auth.mcp_server_url,
		)
		if (holder !== undefined) {
			return new CredentialUrlConflict({
				vault_id: vault.id,
				credential_id: holder.credential_id,
				mcp_server_url: cmd.auth.mcp_server_url,
			})
		}
		return [
			vault.record(new CredentialAttached({ credential_id: credential.id, auth: cmd.auth })),
			credential.record(
				new CredentialCreated({
					vault_id: vault.id,
					auth: cmd.auth,
					display_name: cmd.display_name,
				}),
			),
		]
	},
	transitions: {
		OnlyAnActiveVaultTakesANewCredential: ({ before, after, command }) =>
			[
				before.vault.status === "active",
				before.credential.status === "",
				before.vault.credentials.length < MAX_VAULT_CREDENTIALS,
				after.vault.credentials.length === before.vault.credentials.length + 1,
				after.credential.status === "active",
				after.credential.vault_id === command.vault_id,
			].every((ok) => ok),
	},
}) {}
