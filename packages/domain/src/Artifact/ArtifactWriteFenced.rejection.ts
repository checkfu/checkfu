import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"

export class ArtifactWriteFenced extends Domain.Rejection(
	"ArtifactWriteFenced",
	{ artifact_id: ArtifactId },
	{
		httpApiStatus: 409,
		description: "The write was fenced off before its command was handled; retry the request.",
	},
) {}
