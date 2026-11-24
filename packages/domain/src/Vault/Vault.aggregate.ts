import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { CredentialDetached } from "./ArchiveCredential.command.ts"
import { ArchiveVault, CredentialReleased, VaultArchived } from "./ArchiveVault.command.ts"
import { CredentialAttached } from "./CreateCredential.command.ts"
import { CreateVault, VaultAlreadyExists, VaultCreated } from "./CreateVault.command.ts"
import { CredentialId } from "./Credential.id.ts"
import { DeleteVault, VaultDeleted } from "./DeleteVault.command.ts"
import { UpdateVault, VaultRenamed } from "./UpdateVault.command.ts"
import { VaultId } from "./Vault.id.ts"
import { VaultArchivedError } from "./VaultArchived.rejection.ts"
import { VaultNotFound } from "./VaultNotFound.rejection.ts"
import { MAX_VAULT_CREDENTIALS } from "./VaultTypes.ts"

export const VaultCredentialEntry = Schema.Struct({
	credential_id: CredentialId,
	mcp_server_url: Schema.String,
})
export type VaultCredentialEntry = typeof VaultCredentialEntry.Type

export const VaultState = Schema.Struct({
	status: Schema.String,
	display_name: Schema.String,
	credentials: Schema.Array(VaultCredentialEntry),
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
		credentials: [],
	},
	commands: [CreateVault, UpdateVault, ArchiveVault, DeleteVault],
	events: [CredentialAttached, CredentialDetached],
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
			[s.status === "active", s.credentials.length === 0].some((ok) => ok),
		HoldsAtMostTheCredentialLimit: (s) => s.credentials.length <= MAX_VAULT_CREDENTIALS,
		CredentialUrlsAreDistinct: (s) =>
			s.credentials.every((a, i) =>
				s.credentials.every((b, j) =>
					[i === j, a.mcp_server_url !== b.mcp_server_url].some((ok) => ok),
				),
			),
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
			return [
				...state.credentials.map(
					(held) => new CredentialReleased({ credential_id: held.credential_id }),
				),
				new VaultArchived(),
			]
		},
		DeleteVault: (state, _cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new VaultNotFound({ vault_id: ctx.id })
			}
			return [
				...state.credentials.map(
					(held) => new CredentialReleased({ credential_id: held.credential_id }),
				),
				new VaultDeleted(),
			]
		},
	},
	evolve: {
		"vault.created": (state, e) =>
			state.status === ""
				? { status: "active", display_name: e.display_name, credentials: [] }
				: state,
		"vault.renamed": (state, e) =>
			state.status === "active" ? { ...state, display_name: e.display_name } : state,
		"vault.credential_attached": (state, e) =>
			state.status === "active"
				? {
						...state,
						credentials: [
							...state.credentials,
							{ credential_id: e.credential_id, mcp_server_url: e.auth.mcp_server_url },
						],
					}
				: state,
		"vault.credential_detached": (state, e) => ({
			...state,
			credentials: state.credentials.filter((held) => held.credential_id !== e.credential_id),
		}),
		"vault.credential_released": (state, e) => ({
			...state,
			credentials: state.credentials.filter((held) => held.credential_id !== e.credential_id),
		}),
		"vault.archived": (state) =>
			state.status === "active" ? { ...state, status: "archived", credentials: [] } : state,
		"vault.deleted": (state) =>
			[state.status === "active", state.status === "archived"].some((live) => live)
				? { ...state, status: "deleted", credentials: [] }
				: state,
	},
}) {}
