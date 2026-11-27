import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { FileId } from "./File.id.ts"
import { PositiveInt } from "./FileTypes.ts"

export class FileBytes extends Domain.ExternalSystem("FileBytes", {
	purge: { args: { file_id: FileId } },
	release: { args: { file_id: FileId, reservation: PositiveInt } },
}) {}

export const FileBytesKept = FileBytes.toLayer(
	Effect.succeed({ purge: () => Effect.void, release: () => Effect.void }),
)
