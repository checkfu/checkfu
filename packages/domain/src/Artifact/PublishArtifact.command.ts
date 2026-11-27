import * as Domain from "@alchemy.run/domain"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"
import * as Schema from "effect/Schema"
import { ArtifactAccessLevel, GrantText } from "./ArtifactAccess.ts"
import { NonNegativeInt, PositiveInt, PublicationToken } from "./ArtifactTypes.ts"

export const KEEP_ACCESS = ""

export const RequestedAccess = Schema.Literals([KEEP_ACCESS, ...ArtifactAccessLevel.literals])

export class ArtifactPublished extends Domain.Event("artifact.published", {
	token: PublicationToken,
	pinned_version: NonNegativeInt,
	access: ArtifactAccessLevel,
	grant: GrantText,
}) {}

export class ArtifactVersionNotFound extends Domain.Rejection(
	"ArtifactVersionNotFound",
	{ artifact_id: ArtifactId, version: PositiveInt },
	{ httpApiStatus: 404, description: "Artifact version does not exist." },
) {}

export class PublishArtifact extends Domain.Command("PublishArtifact", {
	input: {
		artifact_id: ArtifactId,
		token: PublicationToken,
		pinned_version: NonNegativeInt,
		access: RequestedAccess,
		grant: GrantText,
	},
	events: [ArtifactPublished],
	rejects: [ArtifactNotFound, ArtifactVersionNotFound],
}) {}
