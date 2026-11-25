import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"

export class ArtifactReservationLapsed extends Domain.Rejection(
	"ArtifactReservationLapsed",
	{ artifact_id: ArtifactId },
	{
		httpApiStatus: 503,
		description: "The create took too long and its files were released; retry the request.",
	},
) {}
