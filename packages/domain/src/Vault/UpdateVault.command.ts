import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { VaultId } from "./Vault.id.ts"
import { VaultArchivedError } from "./VaultArchived.rejection.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"
import { NonEmptyString, VaultDisplayName } from "./VaultTypes.ts"

export class VaultRenamed extends Domain.Event("vault.renamed", {
	display_name: NonEmptyString,
}) {}

export class UpdateVault extends Domain.Command("UpdateVault", {
	input: {
		vault_id: VaultId,
		changes: Schema.Struct({
			display_name: Schema.optionalKey(VaultDisplayName),
		}),
	},
	events: [VaultRenamed],
	rejects: [VaultNotFound, VaultArchivedError],
}) {}
