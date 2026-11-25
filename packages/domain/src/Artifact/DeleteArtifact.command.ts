import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"
import { ArtifactWriteFenced } from "./ArtifactWriteFenced.rejection.ts"
import { NonNegativeInt } from "./ArtifactTypes.ts"

export class ArtifactDeleted extends Domain.Event("artifact.deleted") {}

export class DeleteArtifact extends Domain.Command("DeleteArtifact", {
	input: {
		artifact_id: ArtifactId,
		fence: NonNegativeInt,
	},
	events: [ArtifactDeleted],
	rejects: [ArtifactWriteFenced, ArtifactNotFound],
}) {}
