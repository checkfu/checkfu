import * as Domain from "@alchemy.run/domain"
import { CredentialDetached } from "./ArchiveCredential.command.ts"
import { CredentialId } from "./Credential.id.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { CredentialUrlFreed } from "./CredentialUrlClaim.aggregate.ts"
import { VaultId } from "./Vault.id.ts"
import { McpServerUrl } from "./VaultTypes.ts"

export class CredentialDeleted extends Domain.Event("vault_credential.deleted", {
	vault_id: VaultId,
}) {}

export class DeleteCredential extends Domain.Command("DeleteCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
		mcp_server_url: McpServerUrl,
	},
	events: [CredentialDetached, CredentialDeleted, CredentialUrlFreed],
	rejects: [CredentialNotFound],
}) {}
