import * as Domain from "@alchemy.run/domain"
import { VaultId } from "./Vault.id.ts"

export class VaultSealRetryDue extends Domain.Event("vault.seal_retry_due") {}

export class RetryVaultSeal extends Domain.Command("RetryVaultSeal", {
	input: { vault_id: VaultId },
	events: [VaultSealRetryDue],
}) {}
