import * as Domain from "@alchemy.run/domain"
import {
	ArchiveCredential,
	CredentialArchived,
	CredentialDetached,
} from "./ArchiveCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import {
	CredentialUrlClaim,
	CredentialUrlFreed,
	credentialUrlClaimId,
} from "./CredentialUrlClaim.aggregate.ts"
import { Vault } from "./Vault.aggregate.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"

export class ArchiveCredentialDecision extends Domain.Decision(ArchiveCredential, {
	reads: { vault: Vault, credential: Credential, url: CredentialUrlClaim },
	keyOf: (cmd) => ({
		vault: cmd.vault_id,
		credential: cmd.credential_id,
		url: credentialUrlClaimId(cmd.vault_id, cmd.mcp_server_url),
	}),
	decide: ({ vault, credential, url }, cmd) => {
		if ([vault.state.status === "", vault.state.status === "deleted"].some((gone) => gone)) {
			return new VaultNotFound({ vault_id: vault.id })
		}
		if (
			[
				credential.state.status === "",
				credential.state.status === "deleted",
				credential.state.vault_id !== vault.id,
				credential.state.mcp_server_url !== cmd.mcp_server_url,
			].some((gone) => gone)
		) {
			return new CredentialNotFound({ credential_id: credential.id })
		}
		if (credential.state.status === "archived") {
			return []
		}
		if (vault.state.status !== "active") {
			return [credential.record(new CredentialArchived({ vault_id: vault.id }))]
		}
		if (url.state.holder !== credential.id) {
			return [
				vault.record(
					new CredentialDetached({
						credential_id: credential.id,
						custody: credential.state.custody === "storing" ? "storing" : "held",
					}),
				),
				credential.record(new CredentialArchived({ vault_id: vault.id })),
			]
		}
		return [
			vault.record(
				new CredentialDetached({
					credential_id: credential.id,
					custody: credential.state.custody === "storing" ? "storing" : "held",
				}),
			),
			credential.record(new CredentialArchived({ vault_id: vault.id })),
			url.record(new CredentialUrlFreed()),
		]
	},
	transitions: {
		AnArchivedCredentialLeavesItsVault: ({ before, after, command }) =>
			[
				after.credential.status === "archived",
				after.credential.vault_id === command.vault_id,
				[after.credential.custody !== "held", after.credential.custody !== "storing"].every(
					(ok) => ok,
				),
				[
					[before.credential.custody !== "held", before.credential.custody !== "storing"].every(
						(ok) => ok,
					),
					after.credential.custody === "erasing",
				].some((ok) => ok),
				[
					before.credential.status !== "active",
					before.vault.status !== "active",
					[before.credential.custody === "held", before.vault.held === 0].every((ok) => ok),
					[before.credential.custody === "storing", before.vault.storing === 0].every((ok) => ok),
					[
						before.credential.custody === "held",
						after.vault.held === before.vault.held - 1,
						after.vault.storing === before.vault.storing,
						after.vault.erasing === before.vault.erasing + 1,
					].every((ok) => ok),
					[
						before.credential.custody === "storing",
						after.vault.storing === before.vault.storing - 1,
						after.vault.held === before.vault.held,
						after.vault.erasing === before.vault.erasing + 1,
					].every((ok) => ok),
				].some((ok) => ok),
			].every((ok) => ok),
		AnArchivedCredentialFreesItsUrl: ({ before, after, command }) =>
			[
				[
					before.credential.status !== "active",
					before.vault.status !== "active",
					after.url.holder !== command.credential_id,
				].some((ok) => ok),
				[after.url.holder === before.url.holder, before.url.holder === command.credential_id].some(
					(ok) => ok,
				),
			].every((ok) => ok),
	},
}) {}
