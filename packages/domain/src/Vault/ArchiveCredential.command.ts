import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { CredentialId } from "./Credential.id.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { CredentialUrlFreed } from "./CredentialUrlClaim.aggregate.ts"
import { VaultId } from "./Vault.id.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"
import { McpServerUrl } from "./VaultTypes.ts"

export class CredentialDetached extends Domain.Event("vault.credential_detached", {
	credential_id: CredentialId,
	custody: Schema.Literals(["held", "storing"]),
}) {}

export class CredentialArchived extends Domain.Event("vault_credential.archived", {
	vault_id: VaultId,
}) {}

export class ArchiveCredential extends Domain.Command("ArchiveCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
		mcp_server_url: McpServerUrl,
	},
	events: [CredentialDetached, CredentialArchived, CredentialUrlFreed],
	rejects: [VaultNotFound, CredentialNotFound],
}) {}
