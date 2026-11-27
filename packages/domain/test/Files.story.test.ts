import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CreateFile, FileAlreadyExists, FileCreated } from "../src/File/CreateFile.command.ts"
import { DeleteFile, FileDeleted } from "../src/File/DeleteFile.command.ts"
import {
	ExpireFileReservation,
	FILE_RESERVATION_TTL,
	FileReservationExpired,
} from "../src/File/ExpireFileReservation.command.ts"
import { File } from "../src/File/File.aggregate.ts"
import { FileBytes, FileBytesKept } from "../src/File/FileBytes.external.ts"
import { FileNotFound } from "../src/File/FileNotFound.rejection.ts"
import { FileReservationLapsed } from "../src/File/FileReservationLapsed.rejection.ts"
import { FileReserved, ReserveFile } from "../src/File/ReserveFile.command.ts"
import { Files, FilesHandlersLive } from "../src/Files.model.ts"

const story = Story.make(Files, { layer: FilesHandlersLive, stub: [FileBytes] })

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
const t1 = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")

const described = {
	filename: "report.pdf",
	content_type: "application/pdf",
	size: 1024,
	sha256: "a".repeat(64),
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
})
