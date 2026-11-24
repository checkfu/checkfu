import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactWriteFenced } from "./ArtifactWriteFenced.rejection.ts"
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
		fence: NonNegativeInt,
	},
	events: [ArtifactCreated],
	rejects: [ArtifactWriteFenced, ArtifactAlreadyExists],
	reply: {
		version: PositiveInt,
	},
}) {}
