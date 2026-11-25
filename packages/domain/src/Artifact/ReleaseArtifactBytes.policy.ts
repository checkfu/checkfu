import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { Artifact } from "./Artifact.aggregate.ts"
import { ArtifactBytes } from "./ArtifactBytes.external.ts"
import { ArtifactDeleted } from "./DeleteArtifact.command.ts"
import { ArtifactReservationExpired } from "./ExpireArtifactReservation.command.ts"

export class ReleaseArtifactBytes extends Domain.Policy("ReleaseArtifactBytes", {
	from: Artifact,
	on: [ArtifactDeleted, ArtifactReservationExpired],
}) {}

export const ReleaseArtifactBytesLive = ReleaseArtifactBytes.toLayer(
	Effect.gen(function* () {
		const bytes = yield* ArtifactBytes
		return Effect.fn(function* ({ source, event }) {
			yield* event._tag === "artifact.deleted"
				? bytes.purge({ artifact_id: source.id })
				: bytes.release({ artifact_id: source.id, reservation: event.reservation })
		})
	}),
	{ retry: Schedule.max([Schedule.exponential("200 millis"), Schedule.recurs(6)]) },
)
