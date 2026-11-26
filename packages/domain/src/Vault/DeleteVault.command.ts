import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { VaultId } from "./Vault.id.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"

export class VaultDeleted extends Domain.Event("vault.deleted", {
	next: Schema.String,
}) {}

export class DeleteVault extends Domain.Command("DeleteVault", {
	input: {
		vault_id: VaultId,
	},
	events: [VaultDeleted],
	rejects: [VaultNotFound],
}) {}
