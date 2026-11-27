import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { CapabilitiesText } from "./ArtifactCapabilities.ts"
import { ArtifactReservationLapsed } from "./ArtifactReservationLapsed.rejection.ts"
import {
	ArtifactName,
	ManifestHash,
	NonEmptyString,
	NonNegativeInt,
	PositiveInt,
} from "./ArtifactTypes.ts"

export class ArtifactCreated extends Domain.Event("artifact.created", {
	version: PositiveInt,
	name: NonEmptyString,
	manifest: ManifestHash,
	file_count: PositiveInt,
	total_bytes: NonNegativeInt,
	capabilities: CapabilitiesText,
}) {}

export class ArtifactAlreadyExists extends Domain.Rejection(
	"ArtifactAlreadyExists",
	{ artifact_id: ArtifactId },
	{ httpApiStatus: 409, description: "An artifact with this id already exists." },
) {}

export class CreateArtifact extends Domain.Command("CreateArtifact", {
	input: {
		artifact_id: ArtifactId,
		name: ArtifactName,
		manifest: ManifestHash,
		file_count: PositiveInt,
		total_bytes: NonNegativeInt,
		capabilities: CapabilitiesText,
		reservation: NonNegativeInt,
	},
	events: [ArtifactCreated],
	rejects: [ArtifactReservationLapsed, ArtifactAlreadyExists],
	reply: {
		version: PositiveInt,
	},
}) {}
