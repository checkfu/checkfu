import * as Domain from "@alchemy.run/domain"
import { FileId } from "./File.id.ts"
import { FileNotFound } from "./FileNotFound.rejection.ts"

export class FileDeleted extends Domain.Event("file.deleted") {}

export class DeleteFile extends Domain.Command("DeleteFile", {
	input: {
		file_id: FileId,
	},
	events: [FileDeleted],
	rejects: [FileNotFound],
}) {}
