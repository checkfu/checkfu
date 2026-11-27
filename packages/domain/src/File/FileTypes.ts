import { MAX_ARTIFACT_CONTENT_TYPE_LENGTH, MAX_FILE_NAME_LENGTH } from "@checkfu/sdk/Limits"
import * as Schema from "effect/Schema"

export { NonNegativeInt, PositiveInt } from "@checkfu/sdk/Schemas"

export const FileName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_FILE_NAME_LENGTH * 2),
)

export const FileContentType = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ARTIFACT_CONTENT_TYPE_LENGTH * 2),
)

export const FileSha256 = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
