import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { CredentialId } from "./Credential.id.ts"
import { CredentialUrlClaimed } from "./CredentialUrlClaim.aggregate.ts"
import { VaultId } from "./Vault.id.ts"
import { VaultArchivedError } from "./VaultArchived.rejection.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"
import { CredentialAuth, CredentialDisplayName, McpServerUrl, PositiveInt } from "./VaultTypes.ts"

export class CredentialAttached extends Domain.Event("vault.credential_attached", {
	credential_id: CredentialId,
}) {}

export class CredentialCreated extends Domain.Event("vault_credential.created", {
	vault_id: VaultId,
	auth: CredentialAuth,
	display_name: Schema.NullOr(Schema.String),
	previous: Schema.String,
}) {}

export class CredentialAlreadyExists extends Domain.Rejection(
	"CredentialAlreadyExists",
	{ credential_id: CredentialId },
	{ httpApiStatus: 409, description: "A credential with this id already exists." },
) {}

export class CredentialLimitReached extends Domain.Rejection(
	"CredentialLimitReached",
	{ vault_id: VaultId, limit: PositiveInt },
	{ httpApiStatus: 409, description: "The vault already holds its maximum number of credentials." },
) {}

export class CredentialUrlConflict extends Domain.Rejection(
	"CredentialUrlConflict",
	{ vault_id: VaultId, credential_id: CredentialId, mcp_server_url: McpServerUrl },
	{
		httpApiStatus: 409,
		description: "The vault already holds an active credential for this MCP server URL.",
	},
) {}

export class CreateCredential extends Domain.Command("CreateCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
		auth: CredentialAuth,
		display_name: Schema.NullOr(CredentialDisplayName),
	},
	events: [CredentialAttached, CredentialCreated, CredentialUrlClaimed],
	rejects: [
		VaultNotFound,
		VaultArchivedError,
		CredentialAlreadyExists,
		CredentialLimitReached,
		CredentialUrlConflict,
	],
}) {}
