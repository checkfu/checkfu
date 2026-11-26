import * as Domain from "@alchemy.run/domain"
import {
	ConfirmCredentialStored,
	CredentialSecretStored,
	CredentialStorageCounted,
} from "./ConfirmCredentialStored.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { Vault } from "./Vault.aggregate.ts"

export class ConfirmCredentialStoredDecision extends Domain.Decision(ConfirmCredentialStored, {
	reads: { vault: Vault, credential: Credential },
	keyOf: (cmd) => ({ vault: cmd.vault_id, credential: cmd.credential_id }),
	decide: ({ vault, credential }) => {
		if (
			[
				credential.state.custody !== "storing",
				credential.state.vault_id !== vault.id,
				vault.state.status !== "active",
			].some((settled) => settled)
		) {
			return []
		}
		return [
			credential.record(new CredentialSecretStored()),
			vault.record(new CredentialStorageCounted({ credential_id: credential.id })),
		]
	},
	transitions: {
		OnlyASecretBeingStoredIsConfirmedHeld: ({ before, after }) =>
			[
				after.credential.custody === before.credential.custody,
				[before.credential.custody === "storing", after.credential.custody === "held"].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		AConfirmedStorageIsCountedAtMostOnce: ({ before, after }) =>
			[
				[
					after.vault.held === before.vault.held,
					after.vault.storing === before.vault.storing,
				].every((ok) => ok),
				[
					before.credential.custody === "storing",
					after.credential.custody === "held",
					after.vault.held === before.vault.held + 1,
					after.vault.storing === before.vault.storing - 1,
				].every((ok) => ok),
			].some((ok) => ok),
	},
}) {}
