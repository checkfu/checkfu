import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { ExpireFileReservation, FILE_RESERVATION_TTL } from "./ExpireFileReservation.command.ts"
import { File } from "./File.aggregate.ts"
import { FileReserved } from "./ReserveFile.command.ts"

export class ExpireFileReservations extends Domain.Policy("ExpireFileReservations", {
	from: File,
	on: [FileReserved],
}) {}

export const ExpireFileReservationsLive = ExpireFileReservations.toLayer(
	Effect.gen(function* () {
		const files = yield* File
		return Effect.fn(function* ({ source, event }) {
			yield* files.schedule(
				new ExpireFileReservation({ file_id: source.id, reservation: event.reservation }),
				{ after: FILE_RESERVATION_TTL, commandId: `expire-reservation:${event.reservation}` },
			)
		})
	}),
)
