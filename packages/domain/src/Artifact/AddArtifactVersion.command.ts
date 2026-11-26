import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"
import { ManifestHash, NonNegativeInt, PositiveInt } from "./ArtifactTypes.ts"

export class ArtifactVersionAdded extends Domain.Event("artifact.version_added", {
	version: PositiveInt,
	manifest: ManifestHash,
	file_count: PositiveInt,
	total_bytes: NonNegativeInt,
}) {}

export class ArtifactVersionConflict extends Domain.Rejection(
	"ArtifactVersionConflict",
	{
		artifact_id: ArtifactId,
		expected_version: NonNegativeInt,
		current_version: NonNegativeInt,
	},
	{ httpApiStatus: 409, description: "Artifact version does not match." },
) {}

export class AddArtifactVersion extends Domain.Command("AddArtifactVersion", {
	input: {
		artifact_id: ArtifactId,
		expected_version: NonNegativeInt,
		manifest: ManifestHash,
		file_count: PositiveInt,
		total_bytes: NonNegativeInt,
	},
	events: [ArtifactVersionAdded],
	rejects: [ArtifactNotFound, ArtifactVersionConflict],
	reply: {
		version: PositiveInt,
	},
}) {}
