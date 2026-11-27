import { MAX_ARTIFACT_PATH_LENGTH } from "@checkfu/sdk/Limits"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { FileId } from "../File/File.id.ts"
import { FileContentType, FileSha256, NonNegativeInt } from "../File/FileTypes.ts"

export { NonNegativeInt, PositiveInt } from "../File/FileTypes.ts"

export const MAX_OUTPUT_FILES = 64
export const MAX_OUTPUT_REASON_LENGTH = 512
export const MAX_OUTPUTS_TEXT_LENGTH = 256 * 1024

const OutputPath = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ARTIFACT_PATH_LENGTH * 2),
)

export const OutputReason = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_OUTPUT_REASON_LENGTH),
)

export const SavedOutput = Schema.Struct({
	path: OutputPath,
	file_id: FileId,
	size: NonNegativeInt,
	sha256: FileSha256,
	content_type: FileContentType,
})
export type SavedOutput = typeof SavedOutput.Type

export const SkippedOutput = Schema.Struct({ path: OutputPath, reason: OutputReason })
export type SkippedOutput = typeof SkippedOutput.Type

const SavedOutputs = Schema.Array(SavedOutput).check(Schema.isMaxLength(MAX_OUTPUT_FILES))
const SkippedOutputs = Schema.Array(SkippedOutput).check(Schema.isMaxLength(MAX_OUTPUT_FILES))

export const OutputsText = Schema.String.check(Schema.isMaxLength(MAX_OUTPUTS_TEXT_LENGTH))

const savedJson = Schema.fromJsonString(SavedOutputs)
const skippedJson = Schema.fromJsonString(SkippedOutputs)
const fits = Schema.is(OutputsText)

const encoder = <A>(list: Schema.Codec<A, string>) => {
	const encode = Schema.encodeUnknownOption(list)
	return (value: A): string | undefined => Option.getOrUndefined(Option.filter(encode(value), fits))
}

const readSaved = Schema.decodeOption(savedJson)
const readSkipped = Schema.decodeOption(skippedJson)

export const encodeSavedOutputs = encoder(savedJson)
export const encodeSkippedOutputs = encoder(skippedJson)

export const decodeSavedOutputs = (text: string): ReadonlyArray<SavedOutput> =>
	Option.getOrElse(readSaved(text), () => [])

export const decodeSkippedOutputs = (text: string): ReadonlyArray<SkippedOutput> =>
	Option.getOrElse(readSkipped(text), () => [])
