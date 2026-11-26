import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { VaultId } from "./Vault.id.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"

export class VaultArchived extends Domain.Event("vault.archived", {
	next: Schema.String,
}) {}

export class ArchiveVault extends Domain.Command("ArchiveVault", {
	input: {
		vault_id: VaultId,
	},
	events: [VaultArchived],
	rejects: [VaultNotFound],
}) {}
