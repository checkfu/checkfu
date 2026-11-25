import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"

export class ArtifactDeleted extends Domain.Event("artifact.deleted") {}

export class DeleteArtifact extends Domain.Command("DeleteArtifact", {
	input: {
		artifact_id: ArtifactId,
	},
	events: [ArtifactDeleted],
	rejects: [ArtifactNotFound],
}) {}
