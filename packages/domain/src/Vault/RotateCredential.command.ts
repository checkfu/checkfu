import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { CredentialId } from "./Credential.id.ts"
import { CredentialArchivedError } from "./CredentialArchived.rejection.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { VaultId } from "./Vault.id.ts"
import { CustodyRevision } from "./VaultTypes.ts"

/**
 * The credential's secret was replaced. The secret is not part of the fact;
 * when the new one is an OAuth access token, its expiry is.
 */
export class CredentialRotated extends Domain.Event("vault_credential.rotated", {
	expires_at: Schema.NullOr(Schema.DateTimeUtc),
	revision: CustodyRevision,
}) {}

export class RotateCredential extends Domain.Command("RotateCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
		// Null for a secret that has no expiry of its own, or whose expiry is not known.
		expires_at: Schema.NullOr(Schema.DateTimeUtc),
		// The secret's revision in its connection's custody once replaced.
		revision: CustodyRevision,
	},
	events: [CredentialRotated],
	rejects: [CredentialNotFound, CredentialArchivedError],
}) {}
