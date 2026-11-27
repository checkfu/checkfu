import * as Domain from "@alchemy.run/domain"
import { CredentialId } from "./Credential.id.ts"
import { VaultId } from "./Vault.id.ts"

export class CredentialErasureRetryDue extends Domain.Event("vault_credential.erasure_retry_due", {
	vault_id: VaultId,
}) {}

export class RetryCredentialErasure extends Domain.Command("RetryCredentialErasure", {
	input: { credential_id: CredentialId },
	events: [CredentialErasureRetryDue],
}) {}
