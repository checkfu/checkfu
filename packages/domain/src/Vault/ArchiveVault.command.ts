import * as Domain from "@alchemy.run/domain"
import { CredentialId } from "./Credential.id.ts"
import { VaultId } from "./Vault.id.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"

/** The vault let go of a credential because the vault itself was archived or deleted. */
export class CredentialReleased extends Domain.Event("vault.credential_released", {
	credential_id: CredentialId,
}) {}

export class VaultArchived extends Domain.Event("vault.archived") {}

export class ArchiveVault extends Domain.Command("ArchiveVault", {
	input: {
		vault_id: VaultId,
	},
	events: [CredentialReleased, VaultArchived],
	rejects: [VaultNotFound],
}) {}
