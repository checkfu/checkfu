import * as Schema from "effect/Schema"

export {
	ArtifactName,
	MAX_ARTIFACT_NAME_LENGTH,
	NonEmptyString,
	NonNegativeInt,
	PositiveInt,
} from "@checkfu/sdk/Schemas"

export const MANIFEST_HASH_LENGTH = 64

export const ManifestHash = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MANIFEST_HASH_LENGTH),
)

export const ArtifactWriteId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))

export const PublicationToken = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))
