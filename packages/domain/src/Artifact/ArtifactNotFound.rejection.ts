import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"

export class ArtifactNotFound extends Domain.Rejection(
	"ArtifactNotFound",
	{ artifact_id: ArtifactId },
	{ httpApiStatus: 404, description: "Artifact does not exist." },
) {}
