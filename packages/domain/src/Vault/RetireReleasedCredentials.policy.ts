import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { VaultArchived } from "./ArchiveVault.command.ts"
import { CredentialId } from "./Credential.id.ts"
import { CredentialSecrets } from "./CredentialSecrets.external.ts"
import { VaultDeleted } from "./DeleteVault.command.ts"
import { CredentialReleased, RetireCredential } from "./RetireCredential.command.ts"
import { RetireCredentialDecision } from "./RetireCredential.decision.ts"
import { Vault } from "./Vault.aggregate.ts"

export class RetireReleasedCredentials extends Domain.Policy("RetireReleasedCredentials", {
	from: Vault,
	on: [VaultArchived, VaultDeleted, CredentialReleased],
}) {}

export const RetireReleasedCredentialsLive = RetireReleasedCredentials.toLayer(
	Effect.gen(function* () {
		const retire = yield* RetireCredentialDecision
		const secrets = yield* CredentialSecrets
		return ({ source, event }) =>
			Effect.gen(function* () {
				if (event._tag !== "vault.credential_released") {
					yield* secrets.seal({ vault_id: source.id })
				}
				if (event.next !== "") {
					yield* retire.send(
						new RetireCredential({
							vault_id: source.id,
							credential_id: CredentialId.make(event.next),
						}),
					)
				}
			})
	}),
)
