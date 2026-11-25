import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { NonNegativeInt, PositiveInt } from "./ArtifactTypes.ts"

export class ArtifactWritesFenced extends Domain.Event("artifact.writes_fenced", {
	fence: PositiveInt,
}) {}

export class FenceArtifactWrites extends Domain.Command("FenceArtifactWrites", {
	input: {
		artifact_id: ArtifactId,
	},
	events: [ArtifactWritesFenced],
	reply: {
		fence: NonNegativeInt,
	},
}) {}
