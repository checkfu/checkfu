import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { CreateFile, FileAlreadyExists, FileCreated } from "./CreateFile.command.ts"
import { DeleteFile, FileDeleted } from "./DeleteFile.command.ts"
import { ExpireFileReservation, FileReservationExpired } from "./ExpireFileReservation.command.ts"
import { FileId } from "./File.id.ts"
import { FileNotFound } from "./FileNotFound.rejection.ts"
import { FileReservationLapsed } from "./FileReservationLapsed.rejection.ts"
import { NonNegativeInt } from "./FileTypes.ts"
import { FileReserved, ReserveFile } from "./ReserveFile.command.ts"

export const FileState = Schema.Struct({
	status: Schema.Literals(["", "ready", "deleted"]),
	filename: Schema.String,
	content_type: Schema.String,
	size: NonNegativeInt,
	sha256: Schema.String,
	reservations: NonNegativeInt,
	open_reservation: NonNegativeInt,
	created_at: NonNegativeInt,
})
export type FileState = typeof FileState.Type

export const FILE_STATE_SCHEMA_VERSION = 1 as const

export const FileStateSnapshot = versionedSnapshot({
	current: FILE_STATE_SCHEMA_VERSION,
	schema: FileState,
})

export class File extends Domain.Aggregate("File", {
	id: FileId,
	state: FileStateSnapshot,
	initial: {
		status: "",
		filename: "",
		content_type: "",
		size: 0,
		sha256: "",
		reservations: 0,
		open_reservation: 0,
		created_at: 0,
	},
	commands: [ReserveFile, ExpireFileReservation, CreateFile, DeleteFile],
	keyOf: (cmd) => cmd.file_id,
	invariants: {
		StatusIsKnown: (s) =>
			[s.status === "", s.status === "ready", s.status === "deleted"].some((ok) => ok),
		DescribedExactlyWhenCreated: (s) =>
			[
				[
					s.status === "",
					s.filename === "",
					s.content_type === "",
					s.sha256 === "",
					s.size === 0,
				].every((ok) => ok),
				[s.status !== "", s.filename !== "", s.content_type !== "", s.sha256 !== ""].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		AReservationIsOpenOnlyBeforeCreation: (s) =>
			[s.open_reservation === 0, s.status === ""].some((ok) => ok),
		OnlyTheLatestReservationIsOpen: (s) =>
			[s.open_reservation === 0, s.open_reservation === s.reservations].some((ok) => ok),
	},
	transitions: {
		CreatedFileNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		DeletedStaysDeleted: ({ before, after }) =>
			[before.status !== "deleted", after.status === "deleted"].some((ok) => ok),
		ContentNeverChanges: ({ before, after }) =>
			[
				before.status === "",
				[
					after.filename === before.filename,
					after.content_type === before.content_type,
					after.size === before.size,
					after.sha256 === before.sha256,
				].every((ok) => ok),
			].some((ok) => ok),
		ReservationsAreNumberedInOrder: ({ before, after, command }) =>
			[
				after.reservations === before.reservations,
				[command._tag === "ReserveFile", after.reservations === before.reservations + 1].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		CreatingTakesTheOpenReservation: ({ before, after, command }) => {
			if (command._tag !== "CreateFile") {
				return true
			}
			return [
				after.status === before.status,
				[before.open_reservation !== 0, before.open_reservation === command.reservation].every(
					(ok) => ok,
				),
			].some((ok) => ok)
		},
	},
	decide: {
		ReserveFile: (state, _cmd, ctx) =>
			state.status !== ""
				? new FileAlreadyExists({ file_id: ctx.id })
				: [new FileReserved({ reservation: state.reservations + 1 })],
		ExpireFileReservation: (state, cmd) =>
			[state.status === "", state.open_reservation === cmd.reservation].every((ok) => ok)
				? [new FileReservationExpired({ reservation: cmd.reservation })]
				: [],
		CreateFile: (state, cmd, ctx) => {
			if (state.status !== "") {
				return new FileAlreadyExists({ file_id: ctx.id })
			}
			if (state.open_reservation === 0 || state.open_reservation !== cmd.reservation) {
				return new FileReservationLapsed({ file_id: ctx.id })
			}
			return [
				new FileCreated({
					filename: cmd.filename,
					content_type: cmd.content_type,
					size: cmd.size,
					sha256: cmd.sha256,
				}),
			]
		},
		DeleteFile: (state, _cmd, ctx) =>
			state.status !== "ready" ? new FileNotFound({ file_id: ctx.id }) : [new FileDeleted()],
	},
	reply: {
		ReserveFile: (state) => ({ reservation: state.reservations }),
	},
	evolve: {
		"file.reserved": (state, e) =>
			state.status === ""
				? { ...state, reservations: e.reservation, open_reservation: e.reservation }
				: state,
		"file.reservation_expired": (state, e) =>
			state.open_reservation === e.reservation ? { ...state, open_reservation: 0 } : state,
		"file.created": (state, e, envelope) =>
			state.status === ""
				? {
						...state,
						status: "ready" as const,
						open_reservation: 0,
						filename: e.filename,
						content_type: e.content_type,
						size: e.size,
						sha256: e.sha256,
						created_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"file.deleted": (state) =>
			state.status === "ready" ? { ...state, status: "deleted" as const } : state,
	},
}) {}
