import * as Domain from "@alchemy.run/domain"
import { CredentialId } from "./Credential.id.ts"
import { CredentialArchivedError } from "./CredentialArchived.rejection.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { CustodyRevision } from "./VaultTypes.ts"

/**
 * The authorization server refused to refresh the credential's token, so the
 * credential cannot be used until someone supplies new tokens.
 */
export class CredentialRefreshFailed extends Domain.Event("vault_credential.refresh_failed", {
	revision: CustodyRevision,
}) {}

/**
 * Reported by the credential's own connection, which knows no vault. A report
 * older than the newest revision the credential has seen records nothing.
 */
export class FailCredentialRefresh extends Domain.Command("FailCredentialRefresh", {
	input: {
		credential_id: CredentialId,
		revision: CustodyRevision,
	},
	events: [CredentialRefreshFailed],
	rejects: [CredentialNotFound, CredentialArchivedError],
}) {}
