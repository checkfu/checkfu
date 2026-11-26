import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactAlreadyExists } from "./CreateArtifact.command.ts"
import { ArtifactReservationLapsed } from "./ArtifactReservationLapsed.rejection.ts"
import { ArtifactName, NonEmptyString, NonNegativeInt } from "./ArtifactTypes.ts"

export class ArtifactOpened extends Domain.Event("artifact.opened", {
	name: NonEmptyString,
}) {}

export class OpenArtifact extends Domain.Command("OpenArtifact", {
	input: {
		artifact_id: ArtifactId,
		name: ArtifactName,
		reservation: NonNegativeInt,
	},
	events: [ArtifactOpened],
	rejects: [ArtifactReservationLapsed, ArtifactAlreadyExists],
	reply: {
		version: NonNegativeInt,
	},
}) {}
