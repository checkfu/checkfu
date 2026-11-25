import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"
import { NonNegativeInt, PositiveInt, PublicationToken } from "./ArtifactTypes.ts"

// A pinned_version of 0 follows the artifact's latest version.
export class ArtifactPublished extends Domain.Event("artifact.published", {
	token: PublicationToken,
	pinned_version: NonNegativeInt,
}) {}

export class ArtifactVersionNotFound extends Domain.Rejection(
	"ArtifactVersionNotFound",
	{ artifact_id: ArtifactId, version: PositiveInt },
	{ httpApiStatus: 404, description: "Artifact version does not exist." },
) {}

// token is a fresh random candidate, used only when the artifact is not published.
export class PublishArtifact extends Domain.Command("PublishArtifact", {
	input: {
		artifact_id: ArtifactId,
		token: PublicationToken,
		pinned_version: NonNegativeInt,
	},
	events: [ArtifactPublished],
	rejects: [ArtifactNotFound, ArtifactVersionNotFound],
}) {}
