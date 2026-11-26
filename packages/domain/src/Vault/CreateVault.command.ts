import * as Domain from "@alchemy.run/domain"
import { VaultId } from "./Vault.id.ts"
import { NonEmptyString, VaultDisplayName } from "./VaultTypes.ts"

export class VaultCreated extends Domain.Event("vault.created", {
	display_name: NonEmptyString,
}) {}

export class VaultAlreadyExists extends Domain.Rejection(
	"VaultAlreadyExists",
	{ vault_id: VaultId },
	{ httpApiStatus: 409, description: "A vault with this id already exists." },
) {}

export class CreateVault extends Domain.Command("CreateVault", {
	input: {
		vault_id: VaultId,
		display_name: VaultDisplayName,
	},
	events: [VaultCreated],
	rejects: [VaultAlreadyExists],
}) {}
