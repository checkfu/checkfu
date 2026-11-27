import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"
import { PublicationToken } from "./ArtifactTypes.ts"
import { ArtifactPublicationConflict } from "./PublishArtifact.command.ts"

export class ArtifactUnpublished extends Domain.Event("artifact.unpublished") {}

export class UnpublishArtifact extends Domain.Command("UnpublishArtifact", {
	input: {
		artifact_id: ArtifactId,
		if_current: Schema.optionalKey(PublicationToken),
	},
	events: [ArtifactUnpublished],
	rejects: [ArtifactNotFound, ArtifactPublicationConflict],
}) {}
