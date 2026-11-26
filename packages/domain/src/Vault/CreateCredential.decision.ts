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
import { CredentialId } from "./Credential.id.ts"
import {
	CredentialUrlClaim,
	CredentialUrlClaimed,
	credentialUrlClaimId,
} from "./CredentialUrlClaim.aggregate.ts"
import { Vault } from "./Vault.aggregate.ts"
import { VaultArchivedError } from "./VaultArchived.rejection.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"
import { MAX_VAULT_CREDENTIALS } from "./VaultTypes.ts"

export class CreateCredentialDecision extends Domain.Decision(CreateCredential, {
	reads: { vault: Vault, credential: Credential, url: CredentialUrlClaim },
	keyOf: (cmd) => ({
		vault: cmd.vault_id,
		credential: cmd.credential_id,
		url: credentialUrlClaimId(cmd.vault_id, cmd.auth.mcp_server_url),
	}),
	decide: ({ vault, credential, url }, cmd) => {
		if ([vault.state.status === "", vault.state.status === "deleted"].some((gone) => gone)) {
			return new VaultNotFound({ vault_id: vault.id })
		}
		if (vault.state.status !== "active") {
			return new VaultArchivedError({ vault_id: vault.id })
		}
		if (credential.state.status !== "") {
			return new CredentialAlreadyExists({ credential_id: credential.id })
		}
		if (vault.state.held + vault.state.storing >= MAX_VAULT_CREDENTIALS) {
			return new CredentialLimitReached({ vault_id: vault.id, limit: MAX_VAULT_CREDENTIALS })
		}
		if (url.state.holder !== "") {
			return new CredentialUrlConflict({
				vault_id: vault.id,
				credential_id: CredentialId.make(url.state.holder),
				mcp_server_url: cmd.auth.mcp_server_url,
			})
		}
		return [
			vault.record(new CredentialAttached({ credential_id: credential.id })),
			credential.record(
				new CredentialCreated({
					vault_id: vault.id,
					auth: cmd.auth,
					display_name: cmd.display_name,
					previous: vault.state.last_attached,
				}),
			),
			url.record(new CredentialUrlClaimed({ credential_id: credential.id })),
		]
	},
	transitions: {
		OnlyAnActiveVaultTakesANewCredential: ({ before, after, command }) =>
			[
				before.vault.status === "active",
				before.credential.status === "",
				before.vault.held + before.vault.storing < MAX_VAULT_CREDENTIALS,
				after.vault.storing === before.vault.storing + 1,
				after.vault.held === before.vault.held,
				after.credential.status === "active",
				after.credential.custody === "storing",
				after.credential.vault_id === command.vault_id,
				after.credential.mcp_server_url === command.auth.mcp_server_url,
			].every((ok) => ok),
		ANewCredentialNamesTheOneAttachedBeforeIt: ({ before, after, command }) =>
			[
				after.credential.previous === before.vault.last_attached,
				after.vault.last_attached === command.credential_id,
			].every((ok) => ok),
		OnlyAFreeUrlTakesANewCredential: ({ before, after, command }) =>
			[before.url.holder === "", after.url.holder === command.credential_id].every((ok) => ok),
	},
}) {}
