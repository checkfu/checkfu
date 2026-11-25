import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactWriteId } from "./ArtifactTypes.ts"

export const ARTIFACT_RESERVATION_TTL = "15 minutes"

export class ArtifactReservationExpired extends Domain.Event("artifact.reservation_expired", {
	write_id: ArtifactWriteId,
}) {}

export class ExpireArtifactReservation extends Domain.Command("ExpireArtifactReservation", {
	input: {
		artifact_id: ArtifactId,
		write_id: ArtifactWriteId,
	},
	events: [ArtifactReservationExpired],
}) {}
