import * as Domain from "@alchemy.run/domain"
import { FileId } from "./File.id.ts"
import { PositiveInt } from "./FileTypes.ts"

export const FILE_RESERVATION_TTL = "15 minutes"

export class FileReservationExpired extends Domain.Event("file.reservation_expired", {
	reservation: PositiveInt,
}) {}

export class ExpireFileReservation extends Domain.Command("ExpireFileReservation", {
	input: {
		file_id: FileId,
		reservation: PositiveInt,
	},
	events: [FileReservationExpired],
}) {}
