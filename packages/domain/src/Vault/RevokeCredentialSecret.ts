import * as Effect from "effect/Effect"
import { ConfirmCredentialErased } from "./ConfirmCredentialErased.command.ts"
import { ConfirmCredentialErasedDecision } from "./ConfirmCredentialErased.decision.ts"
import type { CredentialId } from "./Credential.id.ts"
import { CredentialSecrets } from "./CredentialSecrets.external.ts"
import type { VaultId } from "./Vault.id.ts"

export const makeRevokeCredentialSecret = Effect.gen(function* () {
	const secrets = yield* CredentialSecrets
	const confirm = yield* ConfirmCredentialErasedDecision
	return (vault_id: VaultId, credential_id: CredentialId) =>
		secrets
			.erase({ vault_id, credential_id })
			.pipe(Effect.andThen(confirm.send(new ConfirmCredentialErased({ vault_id, credential_id }))))
})
