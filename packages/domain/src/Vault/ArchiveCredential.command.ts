import * as Domain from "@alchemy.run/domain"
import { CredentialId } from "./Credential.id.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { VaultId } from "./Vault.id.ts"

export class CredentialDetached extends Domain.Event("vault.credential_detached", {
	credential_id: CredentialId,
}) {}

export class CredentialArchived extends Domain.Event("vault_credential.archived") {}

export class ArchiveCredential extends Domain.Command("ArchiveCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
	},
	events: [CredentialDetached, CredentialArchived],
	rejects: [CredentialNotFound],
}) {}
