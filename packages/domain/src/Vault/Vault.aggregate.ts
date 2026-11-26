import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { CredentialDetached } from "./ArchiveCredential.command.ts"
import { ArchiveVault, VaultArchived } from "./ArchiveVault.command.ts"
import { CredentialErasureCounted } from "./ConfirmCredentialErased.command.ts"
import { CredentialStorageCounted } from "./ConfirmCredentialStored.command.ts"
import { CredentialAttached } from "./CreateCredential.command.ts"
import { CreateVault, VaultAlreadyExists, VaultCreated } from "./CreateVault.command.ts"
import { DeleteVault, VaultDeleted } from "./DeleteVault.command.ts"
import { CredentialReleased } from "./RetireCredential.command.ts"
import { UpdateVault, VaultRenamed } from "./UpdateVault.command.ts"
import { VaultId } from "./Vault.id.ts"
import { VaultArchivedError } from "./VaultArchived.rejection.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"
import { MAX_VAULT_CREDENTIALS } from "./VaultTypes.ts"

export const VaultState = Schema.Struct({
	status: Schema.String,
	display_name: Schema.String,
	storing: Schema.Int,
	held: Schema.Int,
	erasing: Schema.Int,
	last_attached: Schema.String,
	releasing: Schema.String,
})
export type VaultState = typeof VaultState.Type

export const VAULT_STATE_SCHEMA_VERSION = 1 as const

export const VaultStateSnapshot = versionedSnapshot({
	current: VAULT_STATE_SCHEMA_VERSION,
	schema: VaultState,
})

export class Vault extends Domain.Aggregate("Vault", {
	id: VaultId,
	state: VaultStateSnapshot,
	initial: {
		status: "",
		display_name: "",
		storing: 0,
		held: 0,
		erasing: 0,
		last_attached: "",
		releasing: "",
	},
	commands: [CreateVault, UpdateVault, ArchiveVault, DeleteVault],
	events: [
		CredentialAttached,
		CredentialDetached,
		CredentialStorageCounted,
		CredentialErasureCounted,
		CredentialReleased,
	],
	keyOf: (cmd) => cmd.vault_id,
	invariants: {
		StatusIsKnown: (s) =>
			[
				s.status === "",
				s.status === "active",
				s.status === "archived",
				s.status === "deleted",
			].some((ok) => ok),
		NamedExactlyWhenCreated: (s) =>
			[
				[s.status === "", s.display_name === ""].every((ok) => ok),
				[s.status !== "", s.display_name !== ""].every((ok) => ok),
			].some((ok) => ok),
		OnlyAnActiveVaultHoldsCredentials: (s) =>
			[s.status === "active", [s.held === 0, s.storing === 0].every((none) => none)].some(
				(ok) => ok,
			),
		HoldsAtMostTheCredentialLimit: (s) =>
			[s.held >= 0, s.storing >= 0, s.held + s.storing <= MAX_VAULT_CREDENTIALS].every((ok) => ok),
		NeverCountsFewerThanNoSecretsErasing: (s) => s.erasing >= 0,
		OnlyAnEndedVaultReleasesCredentials: (s) =>
			[s.status === "archived", s.status === "deleted", s.releasing === ""].some((ok) => ok),
	},
	transitions: {
		CreatedVaultNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		ArchivedNeverReactivates: ({ before, after }) =>
			[before.status !== "archived", after.status === "archived", after.status === "deleted"].some(
				(ok) => ok,
			),
		DeletedStaysDeleted: ({ before, after }) =>
			[before.status !== "deleted", after.status === "deleted"].some((ok) => ok),
		OnlyRenamingChangesTheName: ({ before, after, command }) =>
			[
				before.status === "",
				command._tag === "UpdateVault",
				after.display_name === before.display_name,
			].some((ok) => ok),
		AnEndedVaultKeepsWhatItAttachedLast: ({ before, after }) =>
			[
				[before.status === "", before.status === "active"].some((open) => open),
				after.last_attached === before.last_attached,
			].some((ok) => ok),
		AnEndingVaultStillOwesEverySecretItHeld: ({ before, after }) =>
			[
				before.status !== "active",
				after.status === "active",
				[
					after.erasing === before.erasing + before.held + before.storing,
					after.releasing === before.last_attached,
				].every((ok) => ok),
			].some((ok) => ok),
	},
	decide: {
		CreateVault: (state, cmd, ctx) => {
			if (state.status !== "") {
				return new VaultAlreadyExists({ vault_id: ctx.id })
			}
			return [new VaultCreated({ display_name: cmd.display_name })]
		},
		UpdateVault: (state, cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new VaultNotFound({ vault_id: ctx.id })
			}
			if (state.status !== "active") {
				return new VaultArchivedError({ vault_id: ctx.id })
			}
			if (cmd.changes.display_name === undefined) {
				return []
			}
			return [new VaultRenamed({ display_name: cmd.changes.display_name })]
		},
		ArchiveVault: (state, _cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new VaultNotFound({ vault_id: ctx.id })
			}
			if (state.status === "archived") {
				return []
			}
			return [new VaultArchived({ next: state.last_attached })]
		},
		DeleteVault: (state, _cmd, ctx) => {
			if (state.status === "") {
				return new VaultNotFound({ vault_id: ctx.id })
			}
			if (state.status === "deleted") {
				return []
			}
			return [new VaultDeleted({ next: state.last_attached })]
		},
	},
	evolve: {
		"vault.created": (state, e) =>
			state.status === ""
				? {
						status: "active",
						display_name: e.display_name,
						storing: 0,
						held: 0,
						erasing: 0,
						last_attached: "",
						releasing: "",
					}
				: state,
		"vault.renamed": (state, e) =>
			state.status === "active" ? { ...state, display_name: e.display_name } : state,
		"vault.credential_attached": (state, e) =>
			state.status === "active"
				? {
						...state,
						storing: state.storing + 1,
						last_attached: e.credential_id,
					}
				: state,
		"vault.credential_storage_counted": (state) =>
			[state.status === "active", state.storing > 0].every((ok) => ok)
				? { ...state, storing: state.storing - 1, held: state.held + 1 }
				: state,
		"vault.credential_detached": (state, e) =>
			e.custody === "storing"
				? [state.status === "active", state.storing > 0].every((ok) => ok)
					? { ...state, storing: state.storing - 1, erasing: state.erasing + 1 }
					: state
				: [state.status === "active", state.held > 0].every((ok) => ok)
					? { ...state, held: state.held - 1, erasing: state.erasing + 1 }
					: state,
		"vault.credential_erasure_counted": (state) =>
			state.erasing > 0 ? { ...state, erasing: state.erasing - 1 } : state,
		"vault.credential_released": (state, e) =>
			[
				[state.status === "archived", state.status === "deleted"].some((ended) => ended),
				state.releasing === e.credential_id,
			].every((ok) => ok)
				? { ...state, releasing: e.next }
				: state,
		"vault.archived": (state) =>
			state.status === "active"
				? {
						...state,
						status: "archived",
						storing: 0,
						held: 0,
						erasing: state.erasing + state.held + state.storing,
						releasing: state.last_attached,
					}
				: state,
		"vault.deleted": (state) =>
			[state.status === "active", state.status === "archived"].some((live) => live)
				? {
						...state,
						status: "deleted",
						storing: 0,
						held: 0,
						erasing: state.erasing + state.held + state.storing,
						releasing: state.last_attached,
					}
				: state,
	},
}) {}
