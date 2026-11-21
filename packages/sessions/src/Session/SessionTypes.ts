import * as Schema from "effect/Schema"

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
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
	type: Schema.Literals(["end_turn", "retries_exhausted", "budget_reached", "refusal"]),
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
