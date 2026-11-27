import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	CreateFile,
	FileAlreadyExists,
	FileCreated,
	FileOriginIncomplete,
} from "../src/File/CreateFile.command.ts"
import { DeleteFile, FileDeleted } from "../src/File/DeleteFile.command.ts"
import {
	ExpireFileReservation,
	FILE_RESERVATION_TTL,
	FileReservationExpired,
} from "../src/File/ExpireFileReservation.command.ts"
import { File } from "../src/File/File.aggregate.ts"
import { FileId } from "../src/File/File.id.ts"
import { FileBytes, FileBytesKept } from "../src/File/FileBytes.external.ts"
import { FileNotFound } from "../src/File/FileNotFound.rejection.ts"
import { FileReservationLapsed } from "../src/File/FileReservationLapsed.rejection.ts"
import { FileReserved, ReserveFile } from "../src/File/ReserveFile.command.ts"
import { Files, FilesHandlersLive } from "../src/Files.model.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import {
	RecordSessionOutputs,
	SessionOutputsSaved,
} from "../src/Outputs/RecordSessionOutputs.command.ts"
import {
	decodeSavedOutputs,
	decodeSkippedOutputs,
	encodeSavedOutputs,
	encodeSkippedOutputs,
} from "../src/Outputs/OutputsTypes.ts"
import { SessionOutputs } from "../src/Outputs/SessionOutputs.aggregate.ts"
import {
	SessionOutputsSkipped,
	SkipSessionOutputs,
} from "../src/Outputs/SkipSessionOutputs.command.ts"

const story = Story.make(Files, { layer: FilesHandlersLive, stub: [FileBytes] })

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
const t1 = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")

const described = {
	filename: "report.pdf",
	content_type: "application/pdf",
	size: 1024,
	sha256: "a".repeat(64),
	origin_session_id: "",
	origin_turn: 0,
	origin_path: "",
}

const produced = {
	...described,
	origin_session_id: "sesn_1",
	origin_turn: 2,
	origin_path: "reports/report.pdf",
}

describe("Files", () => {
	it.effect("is well defined", () =>
		Effect.scoped(Layer.build(Files.layer(FilesHandlersLive))).pipe(
			Effect.provide([Domain.InMemory, FileBytesKept]),
		),
	)

	it.effect("reserves, creates and deletes a file, and never changes what it holds", () => {
		const file = File.ref("file_001")
		const create = new CreateFile({ file_id: file.id, ...described, reservation: 1 })
		return story(
			Story.clock(t0),
			Story.state(file, { status: "", filename: "", sha256: "", open_reservation: 0 }),
			Story.when(new DeleteFile({ file_id: file.id })),
			Story.rejected(new FileNotFound({ file_id: file.id })),
			Story.when(new ReserveFile({ file_id: file.id })),
			Story.then(file, new FileReserved({ reservation: 1 })),
			Story.replied({ reservation: 1 }),
			Story.when(create),
			Story.then(file, new FileCreated(described)),
			Story.state(file, {
				status: "ready",
				...described,
				open_reservation: 0,
				created_at: DateTime.toEpochMillis(t0),
			}),
			Story.clock(t1),
			Story.when(new ReserveFile({ file_id: file.id })),
			Story.rejected(new FileAlreadyExists({ file_id: file.id })),
			Story.when(
				new CreateFile({
					file_id: file.id,
					...described,
					sha256: "b".repeat(64),
					reservation: 1,
				}),
			),
			Story.rejected(new FileAlreadyExists({ file_id: file.id })),
			Story.state(file, { status: "ready", ...described }),
			Story.when(new DeleteFile({ file_id: file.id })),
			Story.then(file, new FileDeleted()),
			Story.call(FileBytes.purge, { file_id: file.id }),
			Story.succeed(FileBytes.purge, undefined),
			Story.state(file, { status: "deleted", ...described }),
			Story.when(new DeleteFile({ file_id: file.id })),
			Story.rejected(new FileNotFound({ file_id: file.id })),
			Story.when(new ReserveFile({ file_id: file.id })),
			Story.rejected(new FileAlreadyExists({ file_id: file.id })),
		)
	})

	it.effect(
		"creates only with the open reservation, and releases the bytes of one that lapsed",
		() => {
			const file = File.ref("file_reserved")
			const create = (reservation: number) =>
				new CreateFile({ file_id: file.id, ...described, reservation })
			const reserve = new ReserveFile({ file_id: file.id })
			const lapsed = new FileReservationLapsed({ file_id: file.id })
			return story(
				Story.clock(t0),
				Story.when(create(0)),
				Story.rejected(lapsed),
				Story.when(reserve),
				Story.then(file, new FileReserved({ reservation: 1 })),
				Story.when(reserve),
				Story.then(file, new FileReserved({ reservation: 2 })),
				Story.when(create(1)),
				Story.rejected(lapsed),
				Story.when(new ExpireFileReservation({ file_id: file.id, reservation: 1 })),
				Story.then(file),
				Story.state(file, { status: "", reservations: 2, open_reservation: 2 }),
				Story.advance(FILE_RESERVATION_TTL),
				Story.then(file, new FileReservationExpired({ reservation: 2 })),
				Story.call(FileBytes.release, { file_id: file.id, reservation: 2 }),
				Story.succeed(FileBytes.release, undefined),
				Story.state(file, { status: "", reservations: 2, open_reservation: 0 }),
				Story.when(create(2)),
				Story.rejected(lapsed),
				Story.when(reserve),
				Story.then(file, new FileReserved({ reservation: 3 })),
				Story.when(create(3)),
				Story.then(file, new FileCreated(described)),
				Story.state(file, { status: "ready", reservations: 3, open_reservation: 0 }),
			)
		},
	)

	it.effect("records where a session's file came from, and refuses half an origin", () => {
		const file = File.ref("file_output")
		const create = (origin: Partial<typeof produced>) =>
			new CreateFile({ file_id: file.id, ...produced, ...origin, reservation: 1 })
		const incomplete = new FileOriginIncomplete({ file_id: file.id })
		return story(
			Story.clock(t0),
			Story.when(new ReserveFile({ file_id: file.id })),
			Story.then(file, new FileReserved({ reservation: 1 })),
			Story.when(create({ origin_turn: 0 })),
			Story.rejected(incomplete),
			Story.when(create({ origin_path: "" })),
			Story.rejected(incomplete),
			Story.when(create({ origin_session_id: "" })),
			Story.rejected(incomplete),
			Story.when(create({})),
			Story.then(file, new FileCreated(produced)),
			Story.state(file, { status: "ready", ...produced }),
		)
	})

	it.effect("records each turn's outputs once, in order, and keeps the files across a skip", () => {
		const session = SessionId.make("sesn_1")
		const outputs = SessionOutputs.ref(session)
		const report = {
			path: "report.pdf",
			file_id: FileId.make("file_a"),
			size: 1024,
			sha256: "a".repeat(64),
			content_type: "application/pdf",
		}
		const notes = {
			...report,
			path: "notes.md",
			file_id: FileId.make("file_b"),
			content_type: "text/markdown",
		}
		const one = encodeSavedOutputs([report]) ?? ""
		const two = encodeSavedOutputs([report, notes]) ?? ""
		const tooLarge = encodeSkippedOutputs([{ path: "video.mp4", reason: "Too large." }]) ?? ""
		const none = encodeSkippedOutputs([]) ?? ""
		const record = (turn: number, files: string, skipped: string) =>
			new RecordSessionOutputs({ session_id: session, turn, files, skipped })
		return story(
			Story.clock(t0),
			Story.state(outputs, { turn: 0, outcome: "", files: "", skipped: "" }),
			Story.when(record(1, one, tooLarge)),
			Story.then(outputs, new SessionOutputsSaved({ turn: 1, files: one, skipped: tooLarge })),
			Story.state(outputs, {
				turn: 1,
				outcome: "saved",
				reason: "",
				files: one,
				skipped: tooLarge,
				recorded_at: DateTime.toEpochMillis(t0),
			}),
			Story.when(record(1, two, none)),
			Story.then(outputs),
			Story.state(outputs, { turn: 1, files: one }),
			Story.clock(t1),
			Story.when(new SkipSessionOutputs({ session_id: session, turn: 2, reason: "Timed out." })),
			Story.then(outputs, new SessionOutputsSkipped({ turn: 2, reason: "Timed out." })),
			Story.state(outputs, {
				turn: 2,
				outcome: "skipped",
				reason: "Timed out.",
				files: one,
				skipped: "",
				recorded_at: DateTime.toEpochMillis(t1),
			}),
			Story.when(record(2, two, none)),
			Story.then(outputs),
			Story.when(new SkipSessionOutputs({ session_id: session, turn: 1, reason: "Late." })),
			Story.then(outputs),
			Story.when(record(3, two, none)),
			Story.then(outputs, new SessionOutputsSaved({ turn: 3, files: two, skipped: none })),
			Story.state(outputs, { turn: 3, outcome: "saved", reason: "", files: two, skipped: none }),
		)
	})

	it("reads back the outputs it wrote, and reads unreadable text as none", () => {
		const saved = [
			{
				path: "a/b.csv",
				file_id: FileId.make("file_a"),
				size: 3,
				sha256: "c".repeat(64),
				content_type: "text/csv",
			},
		]
		expect(decodeSavedOutputs(encodeSavedOutputs(saved) ?? "")).toEqual(saved)
		expect(decodeSavedOutputs("")).toEqual([])
		expect(decodeSavedOutputs("{}")).toEqual([])
		expect(decodeSkippedOutputs("not json")).toEqual([])
		expect(
			encodeSavedOutputs(Array.from({ length: 65 }, () => saved[0]).filter((x) => x !== undefined)),
		).toBeUndefined()
	})
})
