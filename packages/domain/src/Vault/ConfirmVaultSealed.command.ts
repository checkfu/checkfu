import * as Domain from "@alchemy.run/domain"
import { VaultId } from "./Vault.id.ts"

export class VaultSecretsSealed extends Domain.Event("vault.secrets_sealed") {}

export class ConfirmVaultSealed extends Domain.Command("ConfirmVaultSealed", {
	input: { vault_id: VaultId },
	events: [VaultSecretsSealed],
}) {}
