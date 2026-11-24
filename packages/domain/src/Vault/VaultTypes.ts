export {
	CredentialAuth,
	CredentialDisplayName,
	CredentialSecret,
	CredentialSecretMaterial,
	CredentialSecretReplacement,
	MAX_CREDENTIAL_DISPLAY_NAME_LENGTH,
	MAX_CREDENTIAL_SECRET_LENGTH,
	MAX_MCP_SERVER_URL_LENGTH,
	MAX_VAULT_CREDENTIALS,
	MAX_VAULT_DISPLAY_NAME_LENGTH,
	McpServerUrl,
	NonEmptyString,
	PositiveInt,
	StaticBearerAuth,
	VaultDisplayName,
} from "@checkfu/sdk/Schemas"

import { NonNegativeInt } from "@checkfu/sdk/Schemas"

/**
 * A credential secret's revision in its connection's custody. Every store,
 * replacement and refresh moves it on, so it orders what is said about the
 * secret even when the sayings arrive out of order.
 */
export const CustodyRevision = NonNegativeInt
