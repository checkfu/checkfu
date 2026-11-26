import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { CredentialId } from "./Credential.id.ts"
import { CredentialArchivedError } from "./CredentialArchived.rejection.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { VaultId } from "./Vault.id.ts"
import { VaultArchivedError } from "./VaultArchived.rejection.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"
import { CredentialDisplayName } from "./VaultTypes.ts"

export class CredentialRenamed extends Domain.Event("vault_credential.renamed", {
	display_name: Schema.NullOr(Schema.String),
}) {}

export class UpdateCredential extends Domain.Command("UpdateCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
		changes: Schema.Struct({
			display_name: Schema.optionalKey(Schema.NullOr(CredentialDisplayName)),
		}),
	},
	events: [CredentialRenamed],
	rejects: [VaultNotFound, CredentialNotFound, CredentialArchivedError, VaultArchivedError],
}) {}
