import * as Domain from "@alchemy.run/domain"
import { VaultId } from "./Vault.id.ts"

export class VaultArchivedError extends Domain.Rejection(
	"VaultArchivedError",
	{ vault_id: VaultId },
	{ httpApiStatus: 409, description: "Vault is archived and cannot be modified." },
) {}
