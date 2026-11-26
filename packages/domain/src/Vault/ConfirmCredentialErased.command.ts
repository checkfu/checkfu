import * as Domain from "@alchemy.run/domain"
import { CredentialId } from "./Credential.id.ts"
import { VaultId } from "./Vault.id.ts"

export class CredentialSecretErased extends Domain.Event("vault_credential.secret_erased") {}

export class CredentialErasureCounted extends Domain.Event("vault.credential_erasure_counted", {
	credential_id: CredentialId,
}) {}

export class ConfirmCredentialErased extends Domain.Command("ConfirmCredentialErased", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
	},
	events: [CredentialSecretErased, CredentialErasureCounted],
	rejects: [],
}) {}
