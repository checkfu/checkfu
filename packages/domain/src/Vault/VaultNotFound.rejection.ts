import * as Domain from "@alchemy.run/domain"
import { VaultId } from "./Vault.id.ts"

export class VaultNotFound extends Domain.Rejection(
	"VaultNotFound",
	{ vault_id: VaultId },
	{ httpApiStatus: 404, description: "Vault does not exist." },
) {}
