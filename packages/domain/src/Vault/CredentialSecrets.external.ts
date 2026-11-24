import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { CredentialId } from "./Credential.id.ts"
import { CredentialSecret, McpServerUrl } from "./VaultTypes.ts"

export const CredentialSecretsUnavailable = Schema.TaggedStruct("CredentialSecretsUnavailable", {})
export type CredentialSecretsUnavailable = typeof CredentialSecretsUnavailable.Type

/**
 * Custody of credential secrets, outside the model. `store` and `replace` are
 * called by whoever receives the secret; the model only confirms and erases.
 */
export class CredentialSecrets extends Domain.ExternalSystem("CredentialSecrets", {
	/**
	 * Holds a new credential's secret until `keep` confirms the credential exists,
	 * together with the one server it may ever be sent to.
	 */
	store: {
		args: { credential_id: CredentialId, secret: CredentialSecret, mcp_server_url: McpServerUrl },
		success: { stored: Schema.Boolean },
		error: CredentialSecretsUnavailable,
	},
	/** Replaces a secret that is still held. A credential without one keeps none. */
	replace: {
		args: { credential_id: CredentialId, secret: CredentialSecret },
		success: { replaced: Schema.Boolean },
		error: CredentialSecretsUnavailable,
	},
	keep: {
		args: { credential_id: CredentialId },
	},
	erase: {
		args: { credential_id: CredentialId },
	},
}) {}
