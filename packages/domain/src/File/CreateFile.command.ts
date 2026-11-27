import * as Domain from "@alchemy.run/domain"
import { FileId } from "./File.id.ts"
import { FileReservationLapsed } from "./FileReservationLapsed.rejection.ts"
import {
	FileContentType,
	FileName,
	FileSha256,
	NonNegativeInt,
	OriginPath,
	OriginSessionId,
} from "./FileTypes.ts"

const Described = {
	filename: FileName,
	content_type: FileContentType,
	size: NonNegativeInt,
	sha256: FileSha256,
	origin_session_id: OriginSessionId,
	origin_turn: NonNegativeInt,
	origin_path: OriginPath,
}

export class FileCreated extends Domain.Event("file.created", Described) {}

export class FileAlreadyExists extends Domain.Rejection(
	"FileAlreadyExists",
	{ file_id: FileId },
	{ httpApiStatus: 409, description: "A file with this id already exists." },
) {}

export class FileOriginIncomplete extends Domain.Rejection(
	"FileOriginIncomplete",
	{ file_id: FileId },
	{
		httpApiStatus: 400,
		description: "A file a session produced names its session, turn and path together.",
	},
) {}

export class CreateFile extends Domain.Command("CreateFile", {
	input: {
		file_id: FileId,
		...Described,
		reservation: NonNegativeInt,
	},
	events: [FileCreated],
	rejects: [FileReservationLapsed, FileAlreadyExists, FileOriginIncomplete],
}) {}
