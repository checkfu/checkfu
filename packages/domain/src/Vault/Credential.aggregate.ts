import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { CredentialSecretErased } from "./ConfirmCredentialErased.command.ts"
import { CredentialSecretStored } from "./ConfirmCredentialStored.command.ts"
import { CredentialCreated } from "./CreateCredential.command.ts"
import { CredentialId } from "./Credential.id.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import { CredentialRotated } from "./RotateCredential.command.ts"
import { CredentialRenamed } from "./UpdateCredential.command.ts"

export const CredentialState = Schema.Struct({
	status: Schema.String,
	vault_id: Schema.String,
	mcp_server_url: Schema.String,
	previous: Schema.String,
	custody: Schema.String,
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
		mcp_server_url: "",
		previous: "",
		custody: "",
	},
	events: [
		CredentialCreated,
		CredentialRenamed,
		CredentialRotated,
		CredentialArchived,
		CredentialDeleted,
		CredentialSecretErased,
		CredentialSecretStored,
	],
	commands: [],
	invariants: {
		StatusIsKnown: (s) =>
			[
				s.status === "",
				s.status === "active",
				s.status === "archived",
				s.status === "deleted",
			].some((ok) => ok),
		CustodyIsKnown: (s) =>
			[
				s.custody === "",
				s.custody === "storing",
				s.custody === "held",
				s.custody === "erasing",
				s.custody === "erased",
			].some((ok) => ok),
		OwnedExactlyWhenCreated: (s) =>
			[
				[s.status === "", s.vault_id === "", s.mcp_server_url === "", s.previous === ""].every(
					(ok) => ok,
				),
				[s.status !== "", s.vault_id !== "", s.mcp_server_url !== ""].every((ok) => ok),
			].some((ok) => ok),
		ASecretIsHeldExactlyWhileActive: (s) =>
			[
				(s.status === "active") ===
					[s.custody === "held", s.custody === "storing"].some((live) => live),
				(s.status === "") === (s.custody === ""),
			].every((ok) => ok),
	},
	transitions: {
		CreatedCredentialNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		CredentialNeverChangesVault: ({ before, after }) =>
			[before.status === "", after.vault_id === before.vault_id].some((ok) => ok),
		CredentialNeverChangesTheOneBeforeIt: ({ before, after }) =>
			[before.status === "", after.previous === before.previous].some((ok) => ok),
		CredentialNeverChangesUrl: ({ before, after }) =>
			[before.status === "", after.mcp_server_url === before.mcp_server_url].some((ok) => ok),
		ArchivedNeverReactivates: ({ before, after }) =>
			[before.status !== "archived", after.status === "archived", after.status === "deleted"].some(
				(ok) => ok,
			),
		DeletedStaysDeleted: ({ before, after }) =>
			[before.status !== "deleted", after.status === "deleted"].some((ok) => ok),
		AnArchivedOrDeletedCredentialIsNeverHeldAgain: ({ before, after }) =>
			[
				[before.custody !== "erasing", before.custody !== "erased"].every((ok) => ok),
				[after.custody !== "held", after.custody !== "storing"].every((ok) => ok),
			].some((ok) => ok),
		AHeldSecretIsNeverStoringAgain: ({ before, after }) =>
			[before.custody !== "held", after.custody !== "storing"].some((ok) => ok),
		ErasedStaysErased: ({ before, after }) =>
			[before.custody !== "erased", after.custody === "erased"].some((ok) => ok),
		OnlyASecretBeingErasedBecomesErased: ({ before, after }) =>
			[before.custody === "erased", after.custody !== "erased", before.custody === "erasing"].some(
				(ok) => ok,
			),
	},
	evolve: {
		"vault_credential.created": (state, e) =>
			state.status === ""
				? {
						status: "active",
						vault_id: e.vault_id,
						mcp_server_url: e.auth.mcp_server_url,
						previous: e.previous,
						custody: "storing",
					}
				: state,
		"vault_credential.renamed": (state) => state,
		"vault_credential.rotated": (state) => state,
		"vault_credential.secret_stored": (state) =>
			[state.status === "active", state.custody === "storing"].every((ok) => ok)
				? { ...state, custody: "held" }
				: state,
		"vault_credential.archived": (state) =>
			state.status === "active" ? { ...state, status: "archived", custody: "erasing" } : state,
		"vault_credential.deleted": (state) =>
			[state.status === "active", state.status === "archived"].some((live) => live)
				? {
						...state,
						status: "deleted",
						custody: [state.custody === "held", state.custody === "storing"].some((live) => live)
							? "erasing"
							: state.custody,
					}
				: state,
		"vault_credential.secret_erased": (state) =>
			state.custody === "erasing" ? { ...state, custody: "erased" } : state,
	},
}) {}
