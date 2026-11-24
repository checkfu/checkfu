import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import { McpServerSet } from "./Mcp/McpServerSet.aggregate.ts"
import { ArchiveCredentialDecision } from "./Vault/ArchiveCredential.decision.ts"
import { CreateCredentialDecision } from "./Vault/CreateCredential.decision.ts"
import { Credential } from "./Vault/Credential.aggregate.ts"
import { CredentialView } from "./Vault/CredentialView.view.ts"
import { DeleteCredentialDecision } from "./Vault/DeleteCredential.decision.ts"
import { RetireCredentialDecision } from "./Vault/RetireCredential.decision.ts"
import {
	RetireReleasedCredential,
	RetireReleasedCredentialLive,
} from "./Vault/RetireReleasedCredential.policy.ts"
import {
	SettleCredentialSecret,
	SettleCredentialSecretLive,
} from "./Vault/SettleCredentialSecret.policy.ts"
import { Vault } from "./Vault/Vault.aggregate.ts"
import { VaultView } from "./Vault/VaultView.view.ts"

export class Vaults extends Domain.Model("Vaults", {
	aggregates: [Vault, Credential, McpServerSet],
	decisions: [
		CreateCredentialDecision,
		ArchiveCredentialDecision,
		DeleteCredentialDecision,
		RetireCredentialDecision,
	],
	views: [VaultView, CredentialView],
	policies: [RetireReleasedCredential, SettleCredentialSecret],
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
							vault.state.credentials.some((held) => held.credential_id === credential.id),
						].every((ok) => ok),
					),
				].some((ok) => ok),
			),
	},
	relations: {
		AHeldCredentialIsActiveInItsVault: Domain.Relation({
			over: { vault: Vault, credential: Credential },
			holds: ({ vault, credential }) =>
				[
					vault.state.credentials.every((held) => held.credential_id !== credential.id),
					[credential.state.status === "active", credential.state.vault_id === vault.id].every(
						(ok) => ok,
					),
				].some((ok) => ok),
		}),
	},
	sometimes: {
		AVaultHoldsACredential: (m) => m.Vault.some((vault) => vault.state.credentials.length >= 1),
		ACredentialIsArchived: (m) =>
			m.Credential.some((credential) => credential.state.status === "archived"),
		ACredentialIsDeleted: (m) =>
			m.Credential.some((credential) => credential.state.status === "deleted"),
		AVaultIsArchived: (m) => m.Vault.some((vault) => vault.state.status === "archived"),
		AVaultIsDeleted: (m) => m.Vault.some((vault) => vault.state.status === "deleted"),
	},
}) {}

export const VaultsHandlersLive = Layer.mergeAll(
	RetireReleasedCredentialLive,
	SettleCredentialSecretLive,
)

export class VaultsApi extends Domain.Api("VaultsApi", {
	model: Vaults,
	commands: [
		"CreateVault",
		"UpdateVault",
		"ArchiveVault",
		"DeleteVault",
		"CreateCredential",
		"UpdateCredential",
		"RotateCredential",
		"ArchiveCredential",
		"DeleteCredential",
		"RecordMcpServers",
	],
	views: ["VaultView", "CredentialView"],
}) {}
