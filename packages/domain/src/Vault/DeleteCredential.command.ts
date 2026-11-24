import * as Domain from "@alchemy.run/domain"
import { CredentialDetached } from "./ArchiveCredential.command.ts"
import { CredentialId } from "./Credential.id.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { VaultId } from "./Vault.id.ts"

export class CredentialDeleted extends Domain.Event("vault_credential.deleted") {}

export class DeleteCredential extends Domain.Command("DeleteCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
	},
	events: [CredentialDetached, CredentialDeleted],
	rejects: [CredentialNotFound],
}) {}
