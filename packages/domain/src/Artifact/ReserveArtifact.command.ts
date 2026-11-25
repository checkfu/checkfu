import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactWriteId } from "./ArtifactTypes.ts"
import { ArtifactAlreadyExists } from "./CreateArtifact.command.ts"

export class ArtifactReserved extends Domain.Event("artifact.reserved", {
	write_id: ArtifactWriteId,
}) {}

export class ReserveArtifact extends Domain.Command("ReserveArtifact", {
	input: {
		artifact_id: ArtifactId,
		write_id: ArtifactWriteId,
	},
	events: [ArtifactReserved],
	rejects: [ArtifactAlreadyExists],
}) {}
