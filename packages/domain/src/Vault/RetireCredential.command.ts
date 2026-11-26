import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { CredentialId } from "./Credential.id.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import { VaultId } from "./Vault.id.ts"

export class CredentialReleased extends Domain.Event("vault.credential_released", {
	credential_id: CredentialId,
	next: Schema.String,
}) {}

export class RetireCredential extends Domain.Command("RetireCredential", {
	input: {
		vault_id: VaultId,
		credential_id: CredentialId,
	},
	events: [CredentialArchived, CredentialDeleted, CredentialReleased],
	rejects: [],
}) {}
