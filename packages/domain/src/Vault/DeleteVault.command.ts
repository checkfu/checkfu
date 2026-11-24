import * as Domain from "@alchemy.run/domain"
import { CredentialReleased } from "./ArchiveVault.command.ts"
import { VaultId } from "./Vault.id.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"

export class VaultDeleted extends Domain.Event("vault.deleted") {}

export class DeleteVault extends Domain.Command("DeleteVault", {
	input: {
		vault_id: VaultId,
	},
	events: [CredentialReleased, VaultDeleted],
	rejects: [VaultNotFound],
}) {}
