import * as Effect from "effect/Effect"
import { ConfirmVaultSealed } from "./ConfirmVaultSealed.command.ts"
import { CredentialSecrets } from "./CredentialSecrets.external.ts"
import { Vault } from "./Vault.aggregate.ts"
import type { VaultId } from "./Vault.id.ts"

export const makeSealVaultSecrets = Effect.gen(function* () {
	const secrets = yield* CredentialSecrets
	const vaults = yield* Vault

	return (vault_id: VaultId) =>
		secrets
			.seal({ vault_id })
			.pipe(Effect.andThen(vaults.send(new ConfirmVaultSealed({ vault_id }))))
})
