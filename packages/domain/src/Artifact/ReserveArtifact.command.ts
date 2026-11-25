import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { PositiveInt } from "./ArtifactTypes.ts"
import { ArtifactAlreadyExists } from "./CreateArtifact.command.ts"

export class ArtifactReserved extends Domain.Event("artifact.reserved", {
	reservation: PositiveInt,
}) {}

export class ReserveArtifact extends Domain.Command("ReserveArtifact", {
	input: {
		artifact_id: ArtifactId,
	},
	events: [ArtifactReserved],
	rejects: [ArtifactAlreadyExists],
	reply: {
		reservation: PositiveInt,
	},
}) {}
