import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { Artifact } from "./Artifact.aggregate.ts"
import {
	ARTIFACT_RESERVATION_TTL,
	ExpireArtifactReservation,
} from "./ExpireArtifactReservation.command.ts"
import { ArtifactReserved } from "./ReserveArtifact.command.ts"

export class ExpireArtifactReservations extends Domain.Policy("ExpireArtifactReservations", {
	from: Artifact,
	on: [ArtifactReserved],
}) {}

export const ExpireArtifactReservationsLive = ExpireArtifactReservations.toLayer(
	Effect.gen(function* () {
		const artifacts = yield* Artifact
		return Effect.fn(function* ({ source, event }) {
			yield* artifacts.schedule(
				new ExpireArtifactReservation({ artifact_id: source.id, write_id: event.write_id }),
				{ after: ARTIFACT_RESERVATION_TTL, commandId: `expire-reservation:${event.write_id}` },
			)
		})
	}),
)
