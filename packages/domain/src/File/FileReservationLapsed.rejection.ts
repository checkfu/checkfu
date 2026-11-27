import * as Domain from "@alchemy.run/domain"
import { FileId } from "./File.id.ts"

export class FileReservationLapsed extends Domain.Rejection(
	"FileReservationLapsed",
	{ file_id: FileId },
	{
		httpApiStatus: 503,
		description: "The upload took too long and its bytes were released; retry the request.",
	},
) {}
