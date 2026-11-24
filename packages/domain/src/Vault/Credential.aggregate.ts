import * as Domain from "@alchemy.run/domain"
import { snapshotVersion, versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { CredentialCreated } from "./CreateCredential.command.ts"
import { CredentialId } from "./Credential.id.ts"
import { CredentialArchivedError } from "./CredentialArchived.rejection.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import { CredentialRefreshFailed, FailCredentialRefresh } from "./FailCredentialRefresh.command.ts"
import { CredentialRefreshed, RecordCredentialRefresh } from "./RecordCredentialRefresh.command.ts"
import { CredentialRotated, RotateCredential } from "./RotateCredential.command.ts"
import { CredentialRenamed, UpdateCredential } from "./UpdateCredential.command.ts"

const CredentialStateV1 = Schema.Struct({
	status: Schema.String,
	vault_id: Schema.String,
})

export const CredentialState = Schema.Struct({
	status: Schema.String,
	vault_id: Schema.String,
	// The newest custody revision a rotation or refresh report has told: an older report says nothing.
	revision: Schema.Int,
})
export type CredentialState = typeof CredentialState.Type

export const CREDENTIAL_STATE_SCHEMA_VERSION = 2 as const

export const CredentialStateSnapshot = versionedSnapshot({
	current: CREDENTIAL_STATE_SCHEMA_VERSION,
	schema: CredentialState,
	previous: [
		snapshotVersion({
			version: 1,
			schema: CredentialStateV1,
			migrate: (state) => ({ ...state, revision: 0 }),
		}),
	],
})

export class Credential extends Domain.Aggregate("Credential", {
	id: CredentialId,
	state: CredentialStateSnapshot,
	initial: {
		status: "",
		vault_id: "",
		revision: 0,
	},
	commands: [UpdateCredential, RotateCredential, RecordCredentialRefresh, FailCredentialRefresh],
	events: [CredentialCreated, CredentialArchived, CredentialDeleted],
	keyOf: (cmd) => cmd.credential_id,
	invariants: {
		StatusIsKnown: (s) =>
			[
				s.status === "",
				s.status === "active",
				s.status === "archived",
				s.status === "deleted",
			].some((ok) => ok),
		OwnedExactlyWhenCreated: (s) =>
			[
				[s.status === "", s.vault_id === ""].every((ok) => ok),
				[s.status !== "", s.vault_id !== ""].every((ok) => ok),
			].some((ok) => ok),
	},
	transitions: {
		CreatedCredentialNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		CredentialNeverChangesVault: ({ before, after }) =>
			[before.status === "", after.vault_id === before.vault_id].some((ok) => ok),
		ArchivedNeverReactivates: ({ before, after }) =>
			[before.status !== "archived", after.status === "archived", after.status === "deleted"].some(
				(ok) => ok,
			),
		DeletedStaysDeleted: ({ before, after }) =>
			[before.status !== "deleted", after.status === "deleted"].some((ok) => ok),
		CustodyRevisionNeverGoesBack: ({ before, after }) => after.revision >= before.revision,
	},
	decide: {
		UpdateCredential: (state, cmd, ctx) => {
			if (
				[state.status === "", state.status === "deleted", state.vault_id !== cmd.vault_id].some(
					(gone) => gone,
				)
			) {
				return new CredentialNotFound({ credential_id: ctx.id })
			}
			if (state.status !== "active") {
				return new CredentialArchivedError({ credential_id: ctx.id })
			}
			if (cmd.changes.display_name === undefined) {
				return []
			}
			return [new CredentialRenamed({ display_name: cmd.changes.display_name })]
		},
		RotateCredential: (state, cmd, ctx) => {
			if (
				[state.status === "", state.status === "deleted", state.vault_id !== cmd.vault_id].some(
					(gone) => gone,
				)
			) {
				return new CredentialNotFound({ credential_id: ctx.id })
			}
			if (state.status !== "active") {
				return new CredentialArchivedError({ credential_id: ctx.id })
			}
			return [new CredentialRotated({ expires_at: cmd.expires_at, revision: cmd.revision })]
		},
		RecordCredentialRefresh: (state, cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new CredentialNotFound({ credential_id: ctx.id })
			}
			if (state.status !== "active") {
				return new CredentialArchivedError({ credential_id: ctx.id })
			}
			// Said of tokens a later rotation or refresh already replaced.
			if (cmd.revision <= state.revision) {
				return []
			}
			return [new CredentialRefreshed({ expires_at: cmd.expires_at, revision: cmd.revision })]
		},
		FailCredentialRefresh: (state, cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new CredentialNotFound({ credential_id: ctx.id })
			}
			if (state.status !== "active") {
				return new CredentialArchivedError({ credential_id: ctx.id })
			}
			// Said of tokens a later rotation or refresh already replaced.
			if (cmd.revision <= state.revision) {
				return []
			}
			return [new CredentialRefreshFailed({ revision: cmd.revision })]
		},
	},
	evolve: {
		"vault_credential.created": (state, e) =>
			state.status === ""
				? { status: "active", vault_id: e.vault_id, revision: state.revision }
				: state,
		"vault_credential.renamed": (state) => state,
		"vault_credential.rotated": (state, e) =>
			e.revision > state.revision ? { ...state, revision: e.revision } : state,
		"vault_credential.refreshed": (state, e) =>
			e.revision > state.revision ? { ...state, revision: e.revision } : state,
		"vault_credential.refresh_failed": (state, e) =>
			e.revision > state.revision ? { ...state, revision: e.revision } : state,
		"vault_credential.archived": (state) =>
			state.status === "active" ? { ...state, status: "archived" } : state,
		"vault_credential.deleted": (state) =>
			[state.status === "active", state.status === "archived"].some((live) => live)
				? { ...state, status: "deleted" }
				: state,
	},
}) {}
