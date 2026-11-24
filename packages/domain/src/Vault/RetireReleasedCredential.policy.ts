import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { CredentialReleased } from "./ArchiveVault.command.ts"
import { RetireCredential } from "./RetireCredential.command.ts"
import { RetireCredentialDecision } from "./RetireCredential.decision.ts"
import { Vault } from "./Vault.aggregate.ts"

export class RetireReleasedCredential extends Domain.Policy("RetireReleasedCredential", {
	from: Vault,
	on: [CredentialReleased],
}) {}

export const RetireReleasedCredentialLive = RetireReleasedCredential.toLayer(
	Effect.gen(function* () {
		const retire = yield* RetireCredentialDecision
		return ({ source, event }) =>
			retire.send(new RetireCredential({ vault_id: source.id, credential_id: event.credential_id }))
	}),
)
