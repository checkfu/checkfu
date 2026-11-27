import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { CapabilitiesText } from "./ArtifactCapabilities.ts"
import { MadeFromText } from "./ArtifactMadeFrom.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"
import { ArtifactWriteRequest, ManifestHash, NonNegativeInt, PositiveInt } from "./ArtifactTypes.ts"

export class ArtifactVersionAdded extends Domain.Event("artifact.version_added", {
	version: PositiveInt,
	manifest: ManifestHash,
	file_count: PositiveInt,
	total_bytes: NonNegativeInt,
	capabilities: CapabilitiesText,
	made_from: MadeFromText,
	request: ArtifactWriteRequest,
}) {}

export class ArtifactVersionConflict extends Domain.Rejection(
	"ArtifactVersionConflict",
	{
		artifact_id: ArtifactId,
		expected_version: PositiveInt,
		current_version: PositiveInt,
	},
	{ httpApiStatus: 409, description: "Artifact version does not match." },
) {}

export class AddArtifactVersion extends Domain.Command("AddArtifactVersion", {
	input: {
		artifact_id: ArtifactId,
		expected_version: PositiveInt,
		manifest: ManifestHash,
		file_count: PositiveInt,
		total_bytes: NonNegativeInt,
		capabilities: CapabilitiesText,
		made_from: MadeFromText,
		request: ArtifactWriteRequest,
	},
	events: [ArtifactVersionAdded],
	rejects: [ArtifactNotFound, ArtifactVersionConflict],
	reply: {
		version: PositiveInt,
	},
}) {}
