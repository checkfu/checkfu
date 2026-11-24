import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { CredentialCreated } from "./CreateCredential.command.ts"
import { CredentialId } from "./Credential.id.ts"
import { CredentialArchivedError } from "./CredentialArchived.rejection.ts"
import { CredentialNotFound } from "./CredentialNotFound.rejection.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import { CredentialRotated, RotateCredential } from "./RotateCredential.command.ts"
import { CredentialRenamed, UpdateCredential } from "./UpdateCredential.command.ts"

export const CredentialState = Schema.Struct({
	status: Schema.String,
	vault_id: Schema.String,
})
export type CredentialState = typeof CredentialState.Type

export const CREDENTIAL_STATE_SCHEMA_VERSION = 1 as const

export const CredentialStateSnapshot = versionedSnapshot({
	current: CREDENTIAL_STATE_SCHEMA_VERSION,
	schema: CredentialState,
})

export class Credential extends Domain.Aggregate("Credential", {
	id: CredentialId,
	state: CredentialStateSnapshot,
	initial: {
		status: "",
		vault_id: "",
	},
	commands: [UpdateCredential, RotateCredential],
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
			return [new CredentialRotated()]
		},
	},
	evolve: {
		"vault_credential.created": (state, e) =>
			state.status === "" ? { status: "active", vault_id: e.vault_id } : state,
		"vault_credential.renamed": (state) => state,
		"vault_credential.rotated": (state) => state,
		"vault_credential.archived": (state) =>
			state.status === "active" ? { ...state, status: "archived" } : state,
		"vault_credential.deleted": (state) =>
			[state.status === "active", state.status === "archived"].some((live) => live)
				? { ...state, status: "deleted" }
				: state,
	},
}) {}
