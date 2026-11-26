import * as Domain from "@alchemy.run/domain"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import { CredentialReleased, RetireCredential } from "./RetireCredential.command.ts"
import { Vault } from "./Vault.aggregate.ts"

export class RetireCredentialDecision extends Domain.Decision(RetireCredential, {
	reads: { vault: Vault, credential: Credential },
	keyOf: (cmd) => ({ vault: cmd.vault_id, credential: cmd.credential_id }),
	decide: ({ vault, credential }) => {
		if (credential.state.vault_id !== vault.id) {
			return []
		}
		const ended =
			vault.state.status === "archived"
				? credential.state.status === "active"
					? [credential.record(new CredentialArchived({ vault_id: vault.id }))]
					: []
				: vault.state.status === "deleted"
					? [credential.state.status === "active", credential.state.status === "archived"].some(
							(live) => live,
						)
						? [credential.record(new CredentialDeleted({ vault_id: vault.id }))]
						: []
					: []
		return [
			[vault.state.status === "archived", vault.state.status === "deleted"].some((over) => over),
			vault.state.releasing === credential.id,
		].every((ok) => ok)
			? [
					...ended,
					vault.record(
						new CredentialReleased({
							credential_id: credential.id,
							next: credential.state.previous,
						}),
					),
				]
			: ended
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
		AnEndedVaultLeavesNoCredentialHeld: ({ before, after, command }) =>
			[
				before.credential.vault_id !== command.vault_id,
				[before.vault.status !== "archived", before.vault.status !== "deleted"].every((ok) => ok),
				[after.credential.custody !== "held", after.credential.custody !== "storing"].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		TheCredentialBeingReleasedHandsOnTheOneBeforeIt: ({ before, after, command }) =>
			[
				after.vault.releasing === before.vault.releasing,
				[
					before.vault.releasing === command.credential_id,
					before.credential.vault_id === command.vault_id,
					after.vault.releasing === before.credential.previous,
				].every((ok) => ok),
			].some((ok) => ok),
	},
}) {}
