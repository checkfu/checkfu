import * as Domain from "@alchemy.run/domain"
import { CredentialId } from "./Credential.id.ts"
import { VaultId } from "./Vault.id.ts"

export class CredentialSecretStored extends Domain.Event("vault_credential.secret_stored") {}

export class CredentialStorageCounted extends Domain.Event("vault.credential_storage_counted", {
	credential_id: CredentialId,
}) {}

export class ConfirmCredentialStored extends Domain.Command("ConfirmCredentialStored", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
	},
	events: [CredentialSecretStored, CredentialStorageCounted],
	rejects: [],
}) {}
