import * as Domain from "@alchemy.run/domain"
import { CredentialDetached } from "./ArchiveCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import {
	CredentialUrlClaim,
	CredentialUrlFreed,
	credentialUrlClaimId,
} from "./CredentialUrlClaim.aggregate.ts"
import { CredentialDeleted, DeleteCredential } from "./DeleteCredential.command.ts"
import { Vault } from "./Vault.aggregate.ts"

export class DeleteCredentialDecision extends Domain.Decision(DeleteCredential, {
	reads: { vault: Vault, credential: Credential, url: CredentialUrlClaim },
	keyOf: (cmd) => ({
		vault: cmd.vault_id,
		credential: cmd.credential_id,
		url: credentialUrlClaimId(cmd.vault_id, cmd.mcp_server_url),
	}),
	decide: ({ vault, credential, url }, cmd) => {
		if (
			[
				credential.state.status === "",
				credential.state.vault_id !== vault.id,
				credential.state.mcp_server_url !== cmd.mcp_server_url,
			].some((gone) => gone)
		) {
			return new CredentialNotFound({ credential_id: credential.id })
		}
		if (credential.state.status === "deleted") {
			return []
		}
		if (
			[credential.state.status === "archived", vault.state.status !== "active"].some((ok) => ok)
		) {
			return [credential.record(new CredentialDeleted({ vault_id: vault.id }))]
		}
		if (url.state.holder !== credential.id) {
			return [
				vault.record(
					new CredentialDetached({
						credential_id: credential.id,
						custody: credential.state.custody === "storing" ? "storing" : "held",
					}),
				),
				credential.record(new CredentialDeleted({ vault_id: vault.id })),
			]
		}
		return [
			vault.record(
				new CredentialDetached({
					credential_id: credential.id,
					custody: credential.state.custody === "storing" ? "storing" : "held",
				}),
			),
			credential.record(new CredentialDeleted({ vault_id: vault.id })),
			url.record(new CredentialUrlFreed()),
		]
	},
	transitions: {
		ADeletedCredentialLeavesItsVault: ({ before, after }) =>
			[
				after.credential.status === "deleted",
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
		ADeletedCredentialFreesItsUrl: ({ before, after, command }) =>
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
