import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { CredentialId } from "./Credential.id.ts"
import { CredentialArchivedError } from "./CredentialArchived.rejection.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { CustodyRevision } from "./VaultTypes.ts"

/** The credential's connection refreshed its access token. Neither token is part of the fact. */
export class CredentialRefreshed extends Domain.Event("vault_credential.refreshed", {
	expires_at: Schema.NullOr(Schema.DateTimeUtc),
	revision: CustodyRevision,
}) {}

/**
 * Reported by the credential's own connection, which knows no vault. A report
 * older than the newest revision the credential has seen records nothing.
 */
export class RecordCredentialRefresh extends Domain.Command("RecordCredentialRefresh", {
	input: {
		credential_id: CredentialId,
		expires_at: Schema.NullOr(Schema.DateTimeUtc),
		revision: CustodyRevision,
	},
	events: [CredentialRefreshed],
	rejects: [CredentialNotFound, CredentialArchivedError],
}) {}
