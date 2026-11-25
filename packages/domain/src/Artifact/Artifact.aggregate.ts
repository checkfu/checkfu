import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import {
	AddArtifactVersion,
	ArtifactVersionAdded,
	ArtifactVersionConflict,
} from "./AddArtifactVersion.command.ts"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"
import {
	ArtifactIdempotencyKeyClaimed,
	ClaimArtifactIdempotencyKey,
} from "./ClaimArtifactIdempotencyKey.command.ts"
import { NonNegativeInt } from "./ArtifactTypes.ts"
import { ArtifactAlreadyExists, ArtifactCreated, CreateArtifact } from "./CreateArtifact.command.ts"
import { ArtifactWriteFenced } from "./ArtifactWriteFenced.rejection.ts"
import { ArtifactDeleted, DeleteArtifact } from "./DeleteArtifact.command.ts"
import { ArtifactWritesFenced, FenceArtifactWrites } from "./FenceArtifactWrites.command.ts"
import {
	ArtifactPublished,
	ArtifactVersionNotFound,
	PublishArtifact,
} from "./PublishArtifact.command.ts"
import { ArtifactUnpublished, UnpublishArtifact } from "./UnpublishArtifact.command.ts"

export const ArtifactState = Schema.Struct({
	status: Schema.String,
	version: NonNegativeInt,
	name: Schema.String,
	manifest: Schema.String,
	fence: NonNegativeInt,
	created_at: NonNegativeInt,
	updated_at: NonNegativeInt,
	publication_token: Schema.String,
	pinned_version: NonNegativeInt,
	published_at: NonNegativeInt,
})
export type ArtifactState = typeof ArtifactState.Type

export const ARTIFACT_STATE_SCHEMA_VERSION = 1 as const

export const ArtifactStateSnapshot = versionedSnapshot({
	current: ARTIFACT_STATE_SCHEMA_VERSION,
	schema: ArtifactState,
})

export class Artifact extends Domain.Aggregate("Artifact", {
	id: ArtifactId,
	state: ArtifactStateSnapshot,
	initial: {
		status: "",
		version: 0,
		name: "",
		manifest: "",
		fence: 0,
		created_at: 0,
		updated_at: 0,
		publication_token: "",
		pinned_version: 0,
		published_at: 0,
	},
	commands: [
		CreateArtifact,
		AddArtifactVersion,
		DeleteArtifact,
		FenceArtifactWrites,
		PublishArtifact,
		UnpublishArtifact,
		ClaimArtifactIdempotencyKey,
	],
	keyOf: (cmd) => cmd.artifact_id,
	invariants: {
		StatusIsKnown: (s) =>
			[s.status === "", s.status === "active", s.status === "deleted"].some((ok) => ok),
		CreatedExactlyWhenVersioned: (s) =>
			[
				[s.status === "", s.version === 0, s.name === "", s.manifest === ""].every((ok) => ok),
				[s.status !== "", s.version >= 1, s.name !== "", s.manifest !== ""].every((ok) => ok),
			].some((ok) => ok),
		PublishedOnlyOnceCreated: (s) => [s.publication_token === "", s.status !== ""].some((ok) => ok),
		UnpublishedHoldsNoSettings: (s) =>
			[
				s.publication_token !== "",
				[s.pinned_version === 0, s.published_at === 0].every((ok) => ok),
			].some((ok) => ok),
		PinnedVersionWithinHead: (s) => s.pinned_version <= s.version,
	},
	transitions: {
		CreatedArtifactNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		DeletedStaysDeleted: ({ before, after }) =>
			[
				before.status !== "deleted",
				[
					after.status === "deleted",
					after.version === before.version,
					after.name === before.name,
					after.manifest === before.manifest,
				].every((ok) => ok),
			].some((ok) => ok),
		NameNeverChangesOnceCreated: ({ before, after }) =>
			[before.status === "", after.name === before.name].some((ok) => ok),
		VersionGrowsByOneOrNotAtAll: ({ before, after }) =>
			[
				[
					before.status === "",
					[
						[after.status === "", after.version === 0].every((ok) => ok),
						[after.status === "active", after.version === 1].every((ok) => ok),
					].some((ok) => ok),
				].every((ok) => ok),
				[
					before.status !== "",
					after.status !== "",
					[
						[after.version === before.version, after.manifest === before.manifest].every(
							(ok) => ok,
						),
						[
							before.status === "active",
							after.status === "active",
							after.version === before.version + 1,
						].every((ok) => ok),
					].some((ok) => ok),
				].every((ok) => ok),
			].some((ok) => ok),
		AddedVersionRecordsItsManifest: ({ before, after, command }) => {
			if (command._tag !== "AddArtifactVersion") {
				return true
			}
			return [
				after.version === before.version,
				[before.version === command.expected_version, after.manifest === command.manifest].every(
					(ok) => ok,
				),
			].some((ok) => ok)
		},
		FenceNeverDecreasesAndOnlyFencingMovesIt: ({ before, after, command }) =>
			[
				after.fence === before.fence,
				[command._tag === "FenceArtifactWrites", after.fence === before.fence + 1].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		DeleteLandsOnlyAtTheCurrentFence: ({ before, after, command }) => {
			if (command._tag !== "DeleteArtifact") {
				return true
			}
			return [after.status === before.status, command.fence === before.fence].some((ok) => ok)
		},
		ATokenIsOnlyOpenedOrDropped: ({ before, after }) =>
			[
				after.publication_token === before.publication_token,
				before.publication_token === "",
				after.publication_token === "",
			].some((ok) => ok),
		UnpublishDropsTheToken: ({ after, command }) =>
			[command._tag !== "UnpublishArtifact", after.publication_token === ""].some((ok) => ok),
		PublishKeepsTheTokenOrTakesTheFreshOne: ({ before, after, command }) => {
			if (command._tag !== "PublishArtifact") {
				return true
			}
			return [
				after.publication_token === before.publication_token,
				[before.publication_token === "", after.publication_token === command.token].every(
					(ok) => ok,
				),
			].some((ok) => ok)
		},
		PublishServesAVersionTheArtifactHas: ({ before, after, command }) => {
			if (command._tag !== "PublishArtifact") {
				return true
			}
			return [
				[
					after.publication_token === before.publication_token,
					after.pinned_version === before.pinned_version,
					after.published_at === before.published_at,
				].every((ok) => ok),
				[
					before.status === "active",
					after.publication_token !== "",
					command.pinned_version <= before.version,
					after.pinned_version === command.pinned_version,
				].every((ok) => ok),
			].some((ok) => ok)
		},
		ClaimingAKeyChangesNoState: ({ before, after, command }) =>
			[
				command._tag !== "ClaimArtifactIdempotencyKey",
				[
					after.status === before.status,
					after.version === before.version,
					after.name === before.name,
					after.manifest === before.manifest,
					after.fence === before.fence,
					after.created_at === before.created_at,
					after.updated_at === before.updated_at,
					after.publication_token === before.publication_token,
					after.pinned_version === before.pinned_version,
					after.published_at === before.published_at,
				].every((ok) => ok),
			].some((ok) => ok),
	},
	decide: {
		CreateArtifact: (state, cmd, ctx) => {
			if (cmd.fence !== state.fence) {
				return new ArtifactWriteFenced({ artifact_id: ctx.id })
			}
			if (state.status !== "") {
				return new ArtifactAlreadyExists({ artifact_id: ctx.id })
			}
			return [
				new ArtifactCreated({
					version: 1,
					name: cmd.name,
					manifest: cmd.manifest,
					file_count: cmd.file_count,
					total_bytes: cmd.total_bytes,
				}),
			]
		},
		AddArtifactVersion: (state, cmd, ctx) => {
			if (cmd.fence !== state.fence) {
				return new ArtifactWriteFenced({ artifact_id: ctx.id })
			}
			if (state.status !== "active") {
				return new ArtifactNotFound({ artifact_id: ctx.id })
			}
			if (cmd.expected_version !== state.version) {
				return new ArtifactVersionConflict({
					artifact_id: ctx.id,
					expected_version: cmd.expected_version,
					current_version: state.version,
				})
			}
			return [
				new ArtifactVersionAdded({
					version: state.version + 1,
					manifest: cmd.manifest,
					file_count: cmd.file_count,
					total_bytes: cmd.total_bytes,
				}),
			]
		},
		DeleteArtifact: (state, cmd, ctx) => {
			if (cmd.fence !== state.fence) {
				return new ArtifactWriteFenced({ artifact_id: ctx.id })
			}
			if (state.status !== "active") {
				return new ArtifactNotFound({ artifact_id: ctx.id })
			}
			return [new ArtifactDeleted()]
		},
		FenceArtifactWrites: (state) =>
			state.status === "deleted" ? [] : [new ArtifactWritesFenced({ fence: state.fence + 1 })],
		PublishArtifact: (state, cmd, ctx) => {
			if (state.status !== "active") {
				return new ArtifactNotFound({ artifact_id: ctx.id })
			}
			if (cmd.pinned_version > state.version) {
				return new ArtifactVersionNotFound({ artifact_id: ctx.id, version: cmd.pinned_version })
			}
			if (state.publication_token === "") {
				return [new ArtifactPublished({ token: cmd.token, pinned_version: cmd.pinned_version })]
			}
			return state.pinned_version === cmd.pinned_version
				? []
				: [
						new ArtifactPublished({
							token: state.publication_token,
							pinned_version: cmd.pinned_version,
						}),
					]
		},
		UnpublishArtifact: (state, _cmd, ctx) => {
			if (state.status !== "active") {
				return new ArtifactNotFound({ artifact_id: ctx.id })
			}
			return state.publication_token === "" ? [] : [new ArtifactUnpublished()]
		},
		ClaimArtifactIdempotencyKey: (state, cmd, ctx) =>
			state.status !== "active"
				? new ArtifactNotFound({ artifact_id: ctx.id })
				: [new ArtifactIdempotencyKeyClaimed({ fingerprint: cmd.fingerprint })],
	},
	reply: {
		CreateArtifact: (state) => ({ version: state.version }),
		AddArtifactVersion: (state) => ({ version: state.version }),
		FenceArtifactWrites: (state) => ({ fence: state.fence }),
	},
	evolve: {
		"artifact.created": (state, e, envelope) =>
			state.status === ""
				? {
						...state,
						status: "active",
						version: e.version,
						name: e.name,
						manifest: e.manifest,
						created_at: DateTime.toEpochMillis(envelope.at),
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"artifact.version_added": (state, e, envelope) =>
			state.status === "active"
				? {
						...state,
						version: e.version,
						manifest: e.manifest,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"artifact.deleted": (state) =>
			state.status === "active"
				? {
						...state,
						status: "deleted",
					}
				: state,
		"artifact.writes_fenced": (state, e) => ({ ...state, fence: e.fence }),
		"artifact.published": (state, e, envelope) =>
			state.status === "active"
				? {
						...state,
						publication_token: e.token,
						pinned_version: e.pinned_version,
						published_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"artifact.unpublished": (state) =>
			state.status === "active"
				? { ...state, publication_token: "", pinned_version: 0, published_at: 0 }
				: state,
		"artifact.idempotency_key_claimed": (state) => state,
	},
}) {}
