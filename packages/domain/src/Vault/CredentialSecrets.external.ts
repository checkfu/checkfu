import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { CredentialId } from "./Credential.id.ts"
import { VaultId } from "./Vault.id.ts"
import { CredentialSecret, McpServerUrl } from "./VaultTypes.ts"

export const CredentialSecretsUnavailable = Schema.TaggedStruct("CredentialSecretsUnavailable", {})
export type CredentialSecretsUnavailable = typeof CredentialSecretsUnavailable.Type

export class CredentialSecrets extends Domain.ExternalSystem("CredentialSecrets", {
	put: {
		args: {
			vault_id: VaultId,
			credential_id: CredentialId,
			secret: CredentialSecret,
			mcp_server_url: McpServerUrl,
			mode: Schema.Literals(["create", "replace"]),
		},
		success: { refused: Schema.NullOr(Schema.Literal("erased")) },
		error: CredentialSecretsUnavailable,
	},
	erase: {
		args: { vault_id: VaultId, credential_id: CredentialId },
		error: CredentialSecretsUnavailable,
	},
	seal: {
		args: { vault_id: VaultId },
		error: CredentialSecretsUnavailable,
	},
}) {}
