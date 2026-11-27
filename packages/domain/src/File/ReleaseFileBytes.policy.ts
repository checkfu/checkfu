import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { FileDeleted } from "./DeleteFile.command.ts"
import { FileReservationExpired } from "./ExpireFileReservation.command.ts"
import { File } from "./File.aggregate.ts"
import { FileBytes } from "./FileBytes.external.ts"

export class ReleaseFileBytes extends Domain.Policy("ReleaseFileBytes", {
	from: File,
	on: [FileDeleted, FileReservationExpired],
}) {}

export const ReleaseFileBytesLive = ReleaseFileBytes.toLayer(
	Effect.gen(function* () {
		const bytes = yield* FileBytes
		return Effect.fn(function* ({ source, event }) {
			yield* event._tag === "file.deleted"
				? bytes.purge({ file_id: source.id })
				: bytes.release({ file_id: source.id, reservation: event.reservation })
		})
	}),
	{ retry: Schedule.max([Schedule.exponential("200 millis"), Schedule.recurs(6)]) },
)
