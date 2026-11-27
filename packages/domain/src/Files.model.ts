import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import {
	ExpireFileReservations,
	ExpireFileReservationsLive,
} from "./File/ExpireFileReservations.policy.ts"
import { File } from "./File/File.aggregate.ts"
import { ReleaseFileBytes, ReleaseFileBytesLive } from "./File/ReleaseFileBytes.policy.ts"

export class Files extends Domain.Model("Files", {
	aggregates: [File],
	policies: [ExpireFileReservations, ReleaseFileBytes],
	eventually: {
		NoFileReservationStaysOpen: (m) => m.File.every((f) => f.state.open_reservation === 0),
	},
	sometimes: {
		AFileIsCreated: (m) => m.File.some((f) => f.state.status === "ready"),
		AFileIsDeleted: (m) => m.File.some((f) => f.state.status === "deleted"),
	},
}) {}

export const FilesHandlersLive = Layer.mergeAll(ExpireFileReservationsLive, ReleaseFileBytesLive)

export class FilesApi extends Domain.Api("FilesApi", {
	model: Files,
	commands: ["ReserveFile", "ExpireFileReservation", "CreateFile", "DeleteFile"],
}) {}
