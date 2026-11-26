import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import { ArchiveCredentialDecision } from "./Vault/ArchiveCredential.decision.ts"
import { ConfirmCredentialErasedDecision } from "./Vault/ConfirmCredentialErased.decision.ts"
import { ConfirmCredentialStoredDecision } from "./Vault/ConfirmCredentialStored.decision.ts"
import { CreateCredentialDecision } from "./Vault/CreateCredential.decision.ts"
import { Credential } from "./Vault/Credential.aggregate.ts"
import { CredentialListing, CredentialListingLive } from "./Vault/CredentialListing.projection.ts"
import { CredentialUrlClaim } from "./Vault/CredentialUrlClaim.aggregate.ts"
import { CredentialView } from "./Vault/CredentialView.view.ts"
import { DeleteCredentialDecision } from "./Vault/DeleteCredential.decision.ts"
import { ListCredentials, ListCredentialsLive } from "./Vault/ListCredentials.query.ts"
import { ListVaults, ListVaultsLive } from "./Vault/ListVaults.query.ts"
import { RetireCredentialDecision } from "./Vault/RetireCredential.decision.ts"
import { RotateCredentialDecision } from "./Vault/RotateCredential.decision.ts"
import {
	RetireReleasedCredentials,
	RetireReleasedCredentialsLive,
} from "./Vault/RetireReleasedCredentials.policy.ts"
import {
	SettleCredentialSecret,
	SettleCredentialSecretLive,
} from "./Vault/SettleCredentialSecret.policy.ts"
import { UpdateCredentialDecision } from "./Vault/UpdateCredential.decision.ts"
import { Vault } from "./Vault/Vault.aggregate.ts"
import { VaultListing, VaultListingLive } from "./Vault/VaultListing.projection.ts"
import { VaultView } from "./Vault/VaultView.view.ts"

export class Vaults extends Domain.Model("Vaults", {
	aggregates: [Vault, Credential, CredentialUrlClaim],
	decisions: [
		CreateCredentialDecision,
		ArchiveCredentialDecision,
		DeleteCredentialDecision,
		RetireCredentialDecision,
		ConfirmCredentialErasedDecision,
		ConfirmCredentialStoredDecision,
		UpdateCredentialDecision,
		RotateCredentialDecision,
	],
	views: [VaultView, CredentialView],
	projections: [VaultListing, CredentialListing],
	queries: [ListVaults, ListCredentials],
	policies: [RetireReleasedCredentials, SettleCredentialSecret],
	invariants: {
		VaultViewMatchesVault: (m) =>
			[
				m.Vault.every((vault) => {
					const view = m.VaultView.find((v) => v.id === vault.id)
					if ([vault.state.status === "", vault.state.status === "deleted"].some((gone) => gone)) {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === vault.id,
						view.state.display_name === vault.state.display_name,
						view.state.custody.storing === vault.state.storing,
						view.state.custody.held === vault.state.held,
						view.state.custody.erasing === vault.state.erasing,
						!!view.state.archived_at === (vault.state.status === "archived"),
					].every((ok) => ok)
				}),
				m.VaultView.every((view) =>
					m.Vault.some((vault) =>
						[
							vault.id === view.id,
							vault.state.status !== "",
							vault.state.status !== "deleted",
						].every((ok) => ok),
					),
				),
			].every((ok) => ok),
		CredentialViewMatchesCredential: (m) =>
			[
				m.Credential.every((credential) => {
					const view = m.CredentialView.find((v) => v.id === credential.id)
					if (
						[credential.state.status === "", credential.state.status === "deleted"].some(
							(gone) => gone,
						)
					) {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === credential.id,
						view.state.vault_id === credential.state.vault_id,
						view.state.auth.mcp_server_url === credential.state.mcp_server_url,
						view.state.custody === credential.state.custody,
						!!view.state.archived_at === (credential.state.status === "archived"),
					].every((ok) => ok)
				}),
				m.CredentialView.every((view) =>
					m.Credential.some((credential) =>
						[
							credential.id === view.id,
							credential.state.status !== "",
							credential.state.status !== "deleted",
						].every((ok) => ok),
					),
				),
			].every((ok) => ok),
		EveryActiveCredentialIsHeldByItsVault: (m) =>
			m.Credential.every((credential) =>
				[
					credential.state.status !== "active",
					m.Vault.some((vault) =>
						[
							vault.id === credential.state.vault_id,
							vault.state.status === "active",
							vault.state.held + vault.state.storing >= 1,
						].every((ok) => ok),
					),
				].some((ok) => ok),
			),
		AVaultCountsItsActiveCredentials: (m) =>
			m.Vault.every((vault) =>
				[
					vault.state.held ===
						m.Credential.filter((credential) =>
							[
								credential.state.vault_id === vault.id,
								credential.state.status === "active",
								credential.state.custody === "held",
							].every((ok) => ok),
						).length,
					vault.state.storing ===
						m.Credential.filter((credential) =>
							[
								credential.state.vault_id === vault.id,
								credential.state.status === "active",
								credential.state.custody === "storing",
							].every((ok) => ok),
						).length,
				].every((ok) => ok),
			),
	},
	relations: {
		ACredentialAVaultNamesIsItsOwn: Domain.Relation({
			over: { vault: Vault, credential: Credential },
			holds: ({ vault, credential }) =>
				[
					[
						vault.state.last_attached === "",
						vault.state.last_attached !== credential.id,
						[credential.state.status !== "", credential.state.vault_id === vault.id].every(
							(ok) => ok,
						),
					].some((ok) => ok),
					[
						vault.state.releasing === "",
						vault.state.releasing !== credential.id,
						[credential.state.status !== "", credential.state.vault_id === vault.id].every(
							(ok) => ok,
						),
					].some((ok) => ok),
				].every((ok) => ok),
		}),
		TheCredentialBeforeAnotherIsInTheSameVault: Domain.Relation({
			over: { later: Credential, earlier: Credential },
			holds: ({ later, earlier }) =>
				[
					later.state.previous === "",
					later.state.previous !== earlier.id,
					[earlier.state.status !== "", earlier.state.vault_id === later.state.vault_id].every(
						(ok) => ok,
					),
				].some((ok) => ok),
		}),
		AClaimedUrlIsHeldByACredentialThatExists: Domain.Relation({
			over: { url: CredentialUrlClaim, credential: Credential },
			holds: ({ url, credential }) =>
				[
					url.state.holder === "",
					url.state.holder !== credential.id,
					credential.state.status !== "",
				].some((ok) => ok),
		}),
	},
	eventually: {
		AnArchivedOrDeletedCredentialIsErased: (m) =>
			m.Credential.every((credential) =>
				[
					credential.state.status === "",
					credential.state.status === "active",
					credential.state.custody === "erased",
				].some((ok) => ok),
			),
		NoVaultIsLeftOwingASecret: (m) => m.Vault.every((vault) => vault.state.erasing === 0),
	},
	sometimes: {
		AVaultHoldsACredential: (m) => m.Vault.some((vault) => vault.state.held >= 1),
		ACredentialIsArchived: (m) =>
			m.Credential.some((credential) => credential.state.status === "archived"),
		ACredentialIsDeleted: (m) =>
			m.Credential.some((credential) => credential.state.status === "deleted"),
		AVaultIsArchived: (m) => m.Vault.some((vault) => vault.state.status === "archived"),
		AVaultIsDeleted: (m) => m.Vault.some((vault) => vault.state.status === "deleted"),
		ASecretIsErased: (m) =>
			m.Credential.some((credential) => credential.state.custody === "erased"),
	},
}) {}

export const VaultsHandlersLive = Layer.mergeAll(
	RetireReleasedCredentialsLive,
	SettleCredentialSecretLive,
	VaultListingLive,
	ListVaultsLive,
	CredentialListingLive,
	ListCredentialsLive,
)

export class VaultsApi extends Domain.Api("VaultsApi", {
	model: Vaults,
	commands: [
		"CreateVault",
		"UpdateVault",
		"ArchiveVault",
		"DeleteVault",
		"CreateCredential",
		"ConfirmCredentialStored",
		"UpdateCredential",
		"RotateCredential",
		"ArchiveCredential",
		"DeleteCredential",
	],
	views: ["VaultView", "CredentialView"],
}) {}
