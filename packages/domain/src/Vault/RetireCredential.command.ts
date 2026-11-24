import * as Domain from "@alchemy.run/domain"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { CredentialId } from "./Credential.id.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import { VaultId } from "./Vault.id.ts"

/**
 * Ends a credential whose vault was archived or deleted. Never rejected: a
 * credential the vault still holds, one that is already gone, or one that
 * belongs to another vault records nothing.
 */
export class RetireCredential extends Domain.Command("RetireCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
	},
	events: [CredentialArchived, CredentialDeleted],
	rejects: [],
}) {}
