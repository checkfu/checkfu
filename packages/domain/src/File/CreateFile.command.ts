import * as Domain from "@alchemy.run/domain"
import { FileId } from "./File.id.ts"
import { FileReservationLapsed } from "./FileReservationLapsed.rejection.ts"
import { FileContentType, FileName, FileSha256, NonNegativeInt } from "./FileTypes.ts"

export class FileCreated extends Domain.Event("file.created", {
	filename: FileName,
	content_type: FileContentType,
	size: NonNegativeInt,
	sha256: FileSha256,
}) {}

export class FileAlreadyExists extends Domain.Rejection(
	"FileAlreadyExists",
	{ file_id: FileId },
	{ httpApiStatus: 409, description: "A file with this id already exists." },
) {}

export class CreateFile extends Domain.Command("CreateFile", {
	input: {
		file_id: FileId,
		filename: FileName,
		content_type: FileContentType,
		size: NonNegativeInt,
		sha256: FileSha256,
		reservation: NonNegativeInt,
	},
	events: [FileCreated],
	rejects: [FileReservationLapsed, FileAlreadyExists],
}) {}
