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

// The secret half of a public address. Its exact shape is checked where it is made and where an
// address is parsed, since the verifier reads no pattern.
export const PublicationToken = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))
