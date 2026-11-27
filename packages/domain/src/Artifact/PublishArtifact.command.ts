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

export class ArtifactPublicationConflict extends Domain.Rejection(
	"ArtifactPublicationConflict",
	{ artifact_id: ArtifactId },
	{
		httpApiStatus: 409,
		description: "The artifact version or public address settings have changed.",
	},
) {}

export const PublicationCondition = Schema.Struct({
	head_version: PositiveInt,
	token: Schema.String.check(Schema.isMaxLength(32)),
	pinned_version: NonNegativeInt,
	access: RequestedAccess,
	grant: GrantText,
})
export type PublicationCondition = typeof PublicationCondition.Type

export class PublishArtifact extends Domain.Command("PublishArtifact", {
	input: {
		artifact_id: ArtifactId,
		token: PublicationToken,
		pinned_version: NonNegativeInt,
		access: RequestedAccess,
		grant: GrantText,
		if_current: Schema.optionalKey(PublicationCondition),
	},
	events: [ArtifactPublished],
	rejects: [ArtifactNotFound, ArtifactPublicationConflict, ArtifactVersionNotFound],
}) {}
