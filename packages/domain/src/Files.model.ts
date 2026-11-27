import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import {
	ExpireFileReservations,
	ExpireFileReservationsLive,
} from "./File/ExpireFileReservations.policy.ts"
import { File } from "./File/File.aggregate.ts"
import { ReleaseFileBytes, ReleaseFileBytesLive } from "./File/ReleaseFileBytes.policy.ts"
import { SessionOutputs } from "./Outputs/SessionOutputs.aggregate.ts"

export class Files extends Domain.Model("Files", {
	aggregates: [File, SessionOutputs],
	policies: [ExpireFileReservations, ReleaseFileBytes],
	eventually: {
		NoFileReservationStaysOpen: (m) => m.File.every((f) => f.state.open_reservation === 0),
	},
	sometimes: {
		AFileIsCreated: (m) => m.File.some((f) => f.state.status === "ready"),
		AFileIsDeleted: (m) => m.File.some((f) => f.state.status === "deleted"),
		ASessionProducesAFile: (m) => m.File.some((f) => f.state.origin_turn >= 1),
		OutputsAreSaved: (m) => m.SessionOutputs.some((o) => o.state.outcome === "saved"),
		OutputsAreSkippedAfterASave: (m) =>
			m.SessionOutputs.some((o) => o.state.outcome === "skipped" && o.state.files !== ""),
	},
}) {}

export const FilesHandlersLive = Layer.mergeAll(ExpireFileReservationsLive, ReleaseFileBytesLive)

export class FilesApi extends Domain.Api("FilesApi", {
	model: Files,
	commands: [
		"ReserveFile",
		"ExpireFileReservation",
		"CreateFile",
		"DeleteFile",
		"RecordSessionOutputs",
		"SkipSessionOutputs",
	],
}) {}
