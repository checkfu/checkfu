import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { CredentialSecrets } from "../src/Vault/CredentialSecrets.external.ts"
import { Vaults, VaultsApi, VaultsHandlersLive } from "../src/Vaults.model.ts"
import { WebhookEventsNoop } from "../src/Webhook/WebhookEvents.external.ts"

const story = Story.make(Vaults, {
	layer: VaultsHandlersLive.pipe(Layer.provide([ListingStore.memory, WebhookEventsNoop])),
	stub: [CredentialSecrets],
})

const STANDING = {
	"Vault.StatusIsKnown": "proved",
	"Vault.NamedExactlyWhenCreated": "proved",
	"Vault.OnlyAnActiveVaultHoldsCredentials": "proved",
	"Vault.HoldsAtMostTheCredentialLimit": "proved",
	"Vault.NeverCountsFewerThanNoSecretsErasing": "proved",
	"Vault.CreatedVaultNeverReturnsToUninitialized": "proved",
	"Vault.ArchivedNeverReactivates": "proved",
	"Vault.DeletedStaysDeleted": "proved",
	"Vault.OnlyRenamingChangesTheName": "proved",
	"Vault.OnlyAnEndedVaultReleasesCredentials": "proved",
	"Vault.OnlyAnEndedVaultIsSealed": "proved",
	"Vault.ASealedVaultStaysSealed": "proved",
	"Vault.AnEndedVaultKeepsWhatItAttachedLast": "proved",
	"Vault.AnEndingVaultStillOwesEverySecretItHeld": "proved",
	"Credential.StatusIsKnown": "proved",
	"Credential.CustodyIsKnown": "proved",
	"Credential.OwnedExactlyWhenCreated": "proved",
	"Credential.ASecretIsHeldExactlyWhileActive": "proved",
	"Credential.CreatedCredentialNeverReturnsToUninitialized": "proved",
	"Credential.CredentialNeverChangesVault": "proved",
	"Credential.CredentialNeverChangesTheOneBeforeIt": "proved",
	"Credential.CredentialNeverChangesUrl": "proved",
	"Credential.ArchivedNeverReactivates": "proved",
	"Credential.DeletedStaysDeleted": "proved",
	"Credential.AnArchivedOrDeletedCredentialIsNeverHeldAgain": "proved",
	"Credential.ErasedStaysErased": "proved",
	"Credential.OnlyASecretBeingErasedBecomesErased": "proved",
	"Credential.AHeldSecretIsNeverStoringAgain": "proved",
	"CredentialUrlClaim.AHeldUrlIsNeverTakenOver": "proved",
	"CreateCredential.OnlyAnActiveVaultTakesANewCredential": "proved",
	"CreateCredential.ANewCredentialNamesTheOneAttachedBeforeIt": "proved",
	"CreateCredential.OnlyAFreeUrlTakesANewCredential": "proved",
	"ArchiveCredential.AnArchivedCredentialLeavesItsVault": "proved",
	"ArchiveCredential.AnArchivedCredentialFreesItsUrl": "proved",
	"DeleteCredential.ADeletedCredentialLeavesItsVault": "proved",
	"DeleteCredential.ADeletedCredentialFreesItsUrl": "proved",
	"RetireCredential.OnlyAnEndedVaultRetiresItsCredential": "proved",
	"RetireCredential.AnEndedVaultLeavesNoCredentialHeld": "proved",
	"RetireCredential.TheCredentialBeingReleasedHandsOnTheOneBeforeIt": "proved",
	"ConfirmCredentialErased.OnlyASecretBeingErasedIsConfirmedErased": "proved",
	"ConfirmCredentialErased.AConfirmedErasureIsCountedAtMostOnce": "proved",
	"ConfirmCredentialStored.OnlyASecretBeingStoredIsConfirmedHeld": "proved",
	"ConfirmCredentialStored.AConfirmedStorageIsCountedAtMostOnce": "proved",
	"UpdateCredential.OnlyAnActiveCredentialInAnActiveVaultIsRenamed": "proved",
	"RotateCredential.OnlyAnActiveCredentialInAnActiveVaultIsRotated": "proved",
	"Vaults.ACredentialAVaultNamesIsItsOwn": "proved",
	"Vaults.TheCredentialBeforeAnotherIsInTheSameVault": "proved",
	"Vaults.AClaimedUrlIsHeldByACredentialThatExists": "proved",
	"Vaults.VaultViewMatchesVault": "checked",
	"Vaults.CredentialViewMatchesCredential": "checked",
	"Vaults.EveryActiveCredentialIsHeldByItsVault": "checked",
	"Vaults.AVaultCountsItsActiveCredentials": "checked",
	"Vaults.AVaultCountsEveryUnconfirmedErasure": "checked",
	"Vaults.AnErasureRemainsPending": "reached",
	"Vaults.ASealRetryRuns": "reached",
	"Vaults.AVaultIsSealed": "reached",
	"Vaults.AVaultHoldsACredential": "reached",
	"Vaults.ACredentialIsArchived": "reached",
	"Vaults.ACredentialIsDeleted": "reached",
	"Vaults.AVaultIsArchived": "reached",
	"Vaults.AVaultIsDeleted": "reached",
	"Vaults.ASecretIsErased": "reached",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Vaults Z3 formal verification", () => {
	it.live(
		"proves every Vault, Credential and URL claim rule, and checks the views and the custody policies",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Vaults, {
					apis: [VaultsApi],
					story,
					instances: 1,
					depth: 3,
					walks: { count: 50 },
					allow: { skipped: ["PublishVaultWebhookEvents"] },
					lock: "./Vaults.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				yield* Effect.logInfo(Verify.render(report))
				expect(report.explored.followed).toEqual([
					"RetireReleasedCredentials",
					"SealEndedVault",
					"SettleCredentialSecret",
				])
				expect(report.explored.idle).toEqual([])
				expect(report.explored.sagas).toEqual([])
				expect(report.explored.unstarted).toEqual([])
				expect(report.explored.skipped.map((skipped) => skipped.policy)).toEqual([
					"PublishVaultWebhookEvents",
				])
				expect(report.explored.aside).toEqual([
					{
						kind: "projection",
						name: "VaultListing",
						reason: "is not declared in a file the model's file imports",
					},
					{
						kind: "projection",
						name: "CredentialListing",
						reason: "is not declared in a file the model's file imports",
					},
					{ kind: "query", name: "ListVaults", reason: "what a query answers is not checked" },
					{ kind: "query", name: "ListCredentials", reason: "what a query answers is not checked" },
				])
				expect(report.explored.failures).toEqual([])
				expect(report.explored.unsettled).toBe(0)
				expect(report.explored.truncated).toBe(false)
				expect(report.explored.complete).toBe(3)
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		240_000,
	)
})
