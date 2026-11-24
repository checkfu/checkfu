import * as Domain from "@alchemy.run/domain"
import { CredentialId } from "./Credential.id.ts"
import { CredentialArchivedError } from "./CredentialArchived.rejection.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { VaultId } from "./Vault.id.ts"

/** The credential's secret was replaced. The secret is not part of the fact. */
export class CredentialRotated extends Domain.Event("vault_credential.rotated") {}

export class RotateCredential extends Domain.Command("RotateCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
	},
	events: [CredentialRotated],
	rejects: [CredentialNotFound, CredentialArchivedError],
}) {}
