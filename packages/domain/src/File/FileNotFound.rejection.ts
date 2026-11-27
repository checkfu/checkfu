import * as Domain from "@alchemy.run/domain"
import { FileId } from "./File.id.ts"

export class FileNotFound extends Domain.Rejection(
	"FileNotFound",
	{ file_id: FileId },
	{ httpApiStatus: 404, description: "File does not exist." },
) {}
