import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { CredentialSecrets } from "../src/Vault/CredentialSecrets.external.ts"
import { Vaults, VaultsApi, VaultsHandlersLive } from "../src/Vaults.model.ts"

const story = Story.make(Vaults, {
	layer: VaultsHandlersLive,
	stub: [CredentialSecrets],
})

// A vault keeps its active credentials as a list, and the prover bounds every rule
// and decision that reads one, so these stand as checked rather than proved.
const STANDING = {
	"Vault.StatusIsKnown": "checked",
	"Vault.NamedExactlyWhenCreated": "checked",
	"Vault.OnlyAnActiveVaultHoldsCredentials": "checked",
	"Vault.HoldsAtMostTheCredentialLimit": "checked",
	"Vault.CredentialUrlsAreDistinct": "checked",
	"Vault.CreatedVaultNeverReturnsToUninitialized": "checked",
	"Vault.ArchivedNeverReactivates": "checked",
	"Vault.DeletedStaysDeleted": "checked",
	"Vault.OnlyRenamingChangesTheName": "checked",
	"Credential.StatusIsKnown": "checked",
	"Credential.OwnedExactlyWhenCreated": "checked",
	"Credential.CreatedCredentialNeverReturnsToUninitialized": "checked",
	"Credential.CredentialNeverChangesVault": "checked",
	"Credential.ArchivedNeverReactivates": "checked",
	"Credential.DeletedStaysDeleted": "checked",
	"Credential.CustodyRevisionNeverGoesBack": "checked",
	"McpServerSet.NothingRecordedMeansNoServers": "proved",
	"McpServerSet.RecordedServersNeverChange": "proved",
	"CreateCredential.OnlyAnActiveVaultTakesANewCredential": "checked",
	"ArchiveCredential.AnArchivedCredentialLeavesItsVault": "checked",
	"DeleteCredential.ADeletedCredentialLeavesItsVault": "checked",
	"RetireCredential.OnlyAnEndedVaultRetiresItsCredential": "checked",
	"Vaults.VaultViewMatchesVault": "checked",
	"Vaults.CredentialViewMatchesCredential": "checked",
	"Vaults.EveryActiveCredentialIsHeldByItsVault": "checked",
	"Vaults.AHeldCredentialIsActiveInItsVault": "checked",
	"Vaults.AVaultHoldsACredential": "reached",
	"Vaults.ACredentialIsArchived": "reached",
	"Vaults.ACredentialIsDeleted": "reached",
	"Vaults.AVaultIsArchived": "reached",
	"Vaults.AVaultIsDeleted": "reached",
} as const

describe("Vaults Z3 formal verification", () => {
	it.live(
		"checks every Vault and Credential rule, the views and the custody policy",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Vaults, {
					apis: [VaultsApi],
					story,
					instances: 1,
					depth: 3,
					walks: { count: 50 },
					lock: "./Vaults.verify.lock.json",
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.aside).toEqual([])
				expect(report.explored.truncated).toBe(false)
				expect(report.explored.complete).toBe(3)
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		240_000,
	)
})
