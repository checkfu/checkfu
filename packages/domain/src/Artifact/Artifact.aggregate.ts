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
import { ArtifactReservationLapsed } from "./ArtifactReservationLapsed.rejection.ts"
import { ArtifactDeleted, DeleteArtifact } from "./DeleteArtifact.command.ts"
import {
	ArtifactReservationExpired,
	ExpireArtifactReservation,
} from "./ExpireArtifactReservation.command.ts"
import {
	ArtifactPublished,
	ArtifactVersionNotFound,
	PublishArtifact,
} from "./PublishArtifact.command.ts"
import { ArtifactOpened, OpenArtifact } from "./OpenArtifact.command.ts"
import { ArtifactReserved, ReserveArtifact } from "./ReserveArtifact.command.ts"
import { ArtifactUnpublished, UnpublishArtifact } from "./UnpublishArtifact.command.ts"

export const ArtifactState = Schema.Struct({
	status: Schema.String,
	version: NonNegativeInt,
	name: Schema.String,
	manifest: Schema.String,
	replaced_manifest: Schema.String,
	file_count: NonNegativeInt,
	total_bytes: NonNegativeInt,
	reservations: NonNegativeInt,
	open_reservation: NonNegativeInt,
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
		replaced_manifest: "",
		file_count: 0,
		total_bytes: 0,
		reservations: 0,
		open_reservation: 0,
		created_at: 0,
		updated_at: 0,
		publication_token: "",
		pinned_version: 0,
		published_at: 0,
	},
	commands: [
		ReserveArtifact,
		ExpireArtifactReservation,
		CreateArtifact,
		OpenArtifact,
		AddArtifactVersion,
		DeleteArtifact,
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
				[
					s.status !== "",
					s.name !== "",
					[
						[s.version === 0, s.manifest === ""].every((ok) => ok),
						[s.version >= 1, s.manifest !== ""].every((ok) => ok),
					].some((ok) => ok),
				].every((ok) => ok),
			].some((ok) => ok),
		PublishedOnlyOnceCreated: (s) => [s.publication_token === "", s.status !== ""].some((ok) => ok),
		UnpublishedHoldsNoSettings: (s) =>
			[
				s.publication_token !== "",
				[s.pinned_version === 0, s.published_at === 0].every((ok) => ok),
			].some((ok) => ok),
		PinnedVersionWithinHead: (s) => s.pinned_version <= s.version,
		AReservationIsOpenOnlyBeforeCreation: (s) =>
			[s.open_reservation === 0, s.status === ""].some((ok) => ok),
		OnlyTheLatestReservationIsOpen: (s) =>
			[s.open_reservation === 0, s.open_reservation === s.reservations].some((ok) => ok),
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
						[after.status === "active", after.version <= 1].every((ok) => ok),
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
		ReservationsAreNumberedInOrder: ({ before, after, command }) =>
			[
				after.reservations === before.reservations,
				[command._tag === "ReserveArtifact", after.reservations === before.reservations + 1].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		CreatingTakesTheOpenReservation: ({ before, after, command }) => {
			if (command._tag !== "CreateArtifact") {
				return true
			}
			return [
				after.status === before.status,
				[before.open_reservation !== 0, before.open_reservation === command.reservation].every(
					(ok) => ok,
				),
			].some((ok) => ok)
		},
		OpeningTakesTheOpenReservation: ({ before, after, command }) => {
			if (command._tag !== "OpenArtifact") {
				return true
			}
			return [
				after.status === before.status,
				[before.open_reservation !== 0, before.open_reservation === command.reservation].every(
					(ok) => ok,
				),
			].some((ok) => ok)
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
					before.version >= 1,
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
					after.reservations === before.reservations,
					after.open_reservation === before.open_reservation,
					after.created_at === before.created_at,
					after.updated_at === before.updated_at,
					after.publication_token === before.publication_token,
					after.pinned_version === before.pinned_version,
					after.published_at === before.published_at,
				].every((ok) => ok),
			].some((ok) => ok),
	},
	decide: {
		ReserveArtifact: (state, _cmd, ctx) =>
			state.status !== ""
				? new ArtifactAlreadyExists({ artifact_id: ctx.id })
				: [new ArtifactReserved({ reservation: state.reservations + 1 })],
		ExpireArtifactReservation: (state, cmd) =>
			[state.status === "", state.open_reservation === cmd.reservation].every((ok) => ok)
				? [new ArtifactReservationExpired({ reservation: cmd.reservation })]
				: [],
		CreateArtifact: (state, cmd, ctx) => {
			if (state.status !== "") {
				return new ArtifactAlreadyExists({ artifact_id: ctx.id })
			}
			if (state.open_reservation === 0 || state.open_reservation !== cmd.reservation) {
				return new ArtifactReservationLapsed({ artifact_id: ctx.id })
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
		OpenArtifact: (state, cmd, ctx) => {
			if (state.status !== "") {
				return new ArtifactAlreadyExists({ artifact_id: ctx.id })
			}
			if (state.open_reservation === 0 || state.open_reservation !== cmd.reservation) {
				return new ArtifactReservationLapsed({ artifact_id: ctx.id })
			}
			return [new ArtifactOpened({ name: cmd.name })]
		},
		AddArtifactVersion: (state, cmd, ctx) => {
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
		DeleteArtifact: (state, _cmd, ctx) => {
			if (state.status !== "active") {
				return new ArtifactNotFound({ artifact_id: ctx.id })
			}
			return [new ArtifactDeleted()]
		},
		PublishArtifact: (state, cmd, ctx) => {
			if (state.status !== "active") {
				return new ArtifactNotFound({ artifact_id: ctx.id })
			}
			if (state.version === 0 || cmd.pinned_version > state.version) {
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
		ReserveArtifact: (state) => ({ reservation: state.reservations }),
		CreateArtifact: (state) => ({ version: state.version }),
		OpenArtifact: (state) => ({ version: state.version }),
		AddArtifactVersion: (state) => ({ version: state.version }),
	},
	evolve: {
		"artifact.reserved": (state, e) =>
			state.status === ""
				? { ...state, reservations: e.reservation, open_reservation: e.reservation }
				: state,
		"artifact.reservation_expired": (state, e) =>
			state.open_reservation === e.reservation ? { ...state, open_reservation: 0 } : state,
		"artifact.created": (state, e, envelope) =>
			state.status === ""
				? {
						...state,
						status: "active",
						open_reservation: 0,
						version: e.version,
						name: e.name,
						manifest: e.manifest,
						file_count: e.file_count,
						total_bytes: e.total_bytes,
						created_at: DateTime.toEpochMillis(envelope.at),
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"artifact.opened": (state, e, envelope) =>
			state.status === ""
				? {
						...state,
						status: "active",
						open_reservation: 0,
						name: e.name,
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
						replaced_manifest: state.manifest,
						file_count: e.file_count,
						total_bytes: e.total_bytes,
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
