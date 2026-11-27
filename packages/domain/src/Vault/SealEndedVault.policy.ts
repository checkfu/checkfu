import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { VaultArchived } from "./ArchiveVault.command.ts"
import { VaultDeleted } from "./DeleteVault.command.ts"
import { CredentialReleased } from "./RetireCredential.command.ts"
import { RetryVaultSeal, VaultSealRetryDue } from "./RetryVaultSeal.command.ts"
import { makeSealVaultSecrets } from "./SealVaultSecrets.ts"
import { Vault } from "./Vault.aggregate.ts"

export class SealEndedVault extends Domain.Policy("SealEndedVault", {
	from: Vault,
	on: [VaultArchived, VaultDeleted, CredentialReleased, VaultSealRetryDue],
}) {}

export const SealEndedVaultLive = SealEndedVault.toLayer(
	Effect.gen(function* () {
		const vaults = yield* Vault
		const seal = yield* makeSealVaultSecrets
		return Effect.fn(function* ({ source, event }) {
			if (event._tag !== "vault.seal_retry_due" && event.next !== "") {
				return
			}
			const vault_id = source.id
			yield* seal(vault_id).pipe(
				Effect.catchTag("CredentialSecretsUnavailable", () =>
					vaults.schedule(new RetryVaultSeal({ vault_id }), {
						after: "5 seconds",
						commandId: "retry-seal",
					}),
				),
			)
		})
	}),
)
