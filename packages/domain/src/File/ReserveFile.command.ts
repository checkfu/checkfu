import * as Domain from "@alchemy.run/domain"
import { FileAlreadyExists } from "./CreateFile.command.ts"
import { FileId } from "./File.id.ts"
import { PositiveInt } from "./FileTypes.ts"

export class FileReserved extends Domain.Event("file.reserved", {
	reservation: PositiveInt,
}) {}

export class ReserveFile extends Domain.Command("ReserveFile", {
	input: {
		file_id: FileId,
	},
	events: [FileReserved],
	rejects: [FileAlreadyExists],
	reply: {
		reservation: PositiveInt,
	},
}) {}
