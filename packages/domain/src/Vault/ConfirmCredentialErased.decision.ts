import * as Domain from "@alchemy.run/domain"
import {
	ConfirmCredentialErased,
	CredentialErasureCounted,
	CredentialSecretErased,
} from "./ConfirmCredentialErased.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { Vault } from "./Vault.aggregate.ts"

export class ConfirmCredentialErasedDecision extends Domain.Decision(ConfirmCredentialErased, {
	reads: { vault: Vault, credential: Credential },
	keyOf: (cmd) => ({ vault: cmd.vault_id, credential: cmd.credential_id }),
	decide: ({ vault, credential }) => {
		if (
			[credential.state.custody !== "erasing", credential.state.vault_id !== vault.id].some(
				(settled) => settled,
			)
		) {
			return []
		}
		return [
			credential.record(new CredentialSecretErased()),
			vault.record(new CredentialErasureCounted({ credential_id: credential.id })),
		]
	},
	transitions: {
		OnlyASecretBeingErasedIsConfirmedErased: ({ before, after }) =>
			[
				after.credential.custody === before.credential.custody,
				[before.credential.custody === "erasing", after.credential.custody === "erased"].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		AConfirmedErasureIsCountedAtMostOnce: ({ before, after }) =>
			[
				after.vault.erasing === before.vault.erasing,
				[
					before.credential.custody === "erasing",
					after.credential.custody === "erased",
					after.vault.erasing === before.vault.erasing - 1,
				].every((ok) => ok),
			].some((ok) => ok),
	},
}) {}
