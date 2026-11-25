import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"

export class ArtifactUnpublished extends Domain.Event("artifact.unpublished") {}

export class UnpublishArtifact extends Domain.Command("UnpublishArtifact", {
	input: {
		artifact_id: ArtifactId,
	},
	events: [ArtifactUnpublished],
	rejects: [ArtifactNotFound],
}) {}
