import * as Schema from "effect/Schema"

export const MAX_IDENTIFIER_LENGTH = 256
export const MAX_TITLE_LENGTH = 1024
export const MAX_MESSAGE_TEXT_LENGTH = 16_384
export const MAX_THINKING_TEXT_LENGTH = 16_384
export const MAX_ERROR_TYPE_LENGTH = 128
export const MAX_ERROR_MESSAGE_LENGTH = 4096

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
export const ResourceId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
)
export const SessionTitle = Schema.String.check(Schema.isMaxLength(MAX_TITLE_LENGTH))
export const MessageText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_MESSAGE_TEXT_LENGTH),
)
export const ThinkingText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_THINKING_TEXT_LENGTH),
)
export const ErrorType = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ERROR_TYPE_LENGTH),
)
export const ErrorMessage = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ERROR_MESSAGE_LENGTH),
)
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const TextBlock = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String,
})
export type TextBlock = typeof TextBlock.Type

export const TextBlocks = Schema.Array(TextBlock).check(Schema.isMinLength(1))
export type TextBlocks = typeof TextBlocks.Type

export const StopReason = Schema.Struct({
	type: Schema.Literals([
		"end_turn",
		"interrupted",
		"retries_exhausted",
		"budget_reached",
		"refusal",
	]),
})
export type StopReason = typeof StopReason.Type

export const RetryStatus = Schema.Struct({
	type: Schema.Literals(["retrying", "exhausted", "terminal"]),
})
export type RetryStatus = typeof RetryStatus.Type

export const SessionErrorBody = Schema.Struct({
	type: Schema.String,
	message: Schema.String,
	retry_status: RetryStatus,
})
export type SessionErrorBody = typeof SessionErrorBody.Type

export const ModelUsage = Schema.Struct({
	input_tokens: NonNegativeInt,
	output_tokens: NonNegativeInt,
})
export type ModelUsage = typeof ModelUsage.Type

export const SessionStatus = Schema.Literals(["idle", "running", "terminated"])
export type SessionStatus = typeof SessionStatus.Type
