import * as Domain from "@alchemy.run/domain"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import {
	ErrorMessage,
	ErrorType,
	MAX_ERROR_MESSAGE_LENGTH,
	MAX_ERROR_TYPE_LENGTH,
	MAX_MESSAGE_TEXT_LENGTH,
	MAX_THINKING_TEXT_LENGTH,
	MessageText,
	ModelUsage,
	NonNegativeInt,
	PositiveInt,
	ResourceId,
	ThinkingText,
} from "./SessionTypes.ts"

export const DEFAULT_MODEL_TIMEOUT_MS = 600_000

export const ModelStopReason = Schema.Struct({
	type: Schema.Literals(["end_turn", "budget_reached", "refusal"]),
})
export type ModelStopReason = typeof ModelStopReason.Type

export const ModelProviderError = Schema.TaggedStruct("ModelProviderError", {
	error_type: ErrorType,
	message: ErrorMessage,
	terminal: Schema.Boolean,
	model_usage: Schema.optionalKey(ModelUsage),
})
export type ModelProviderError = typeof ModelProviderError.Type

export const ModelRequestInterrupted = Schema.TaggedStruct("ModelRequestInterrupted", {
	model_usage: Schema.optionalKey(ModelUsage),
})
export type ModelRequestInterrupted = typeof ModelRequestInterrupted.Type

export const HARNESS_UNAVAILABLE = "harness_unavailable"
export const HARNESS_UNAVAILABLE_MESSAGE = "The agent runtime could not be reached."
export const TURN_TIMEOUT = "model_request_timeout"
export const TURN_TIMEOUT_MESSAGE = "Model request timed out."
export const HarnessUnavailable = Schema.TaggedStruct("HarnessUnavailable", {})
export type HarnessUnavailable = typeof HarnessUnavailable.Type

export class ModelProvider extends Domain.ExternalSystem("ModelProvider", {
	generate: {
		args: {
			session_id: SessionId,
			agent_id: ResourceId,
			agent_version: PositiveInt,
			environment_id: ResourceId,
			turn: PositiveInt,
			generation: NonNegativeInt,
			input: Schema.Array(MessageText),
		},
		success: {
			thinking: Schema.NullOr(ThinkingText),
			text: MessageText,
			truncated: Schema.optional(Schema.Literal(true)),
			input_tokens: NonNegativeInt,
			output_tokens: NonNegativeInt,
			stop_reason: ModelStopReason,
		},
		error: [ModelProviderError, ModelRequestInterrupted, HarnessUnavailable],
	},
	interrupt: {
		args: {
			session_id: SessionId,
			turn: PositiveInt,
			generation: NonNegativeInt,
		},
		error: HarnessUnavailable,
	},
}) {}

const clampText = (value: string, maxLength: number, fallback: string): string => {
	if (value.length === 0) {
		return fallback
	}
	return value.length > maxLength ? value.slice(0, maxLength) : value
}

export interface ModelProviderReply {
	readonly thinking: string | null
	readonly text: string
	readonly input_tokens: number
	readonly output_tokens: number
	readonly stop_reason: ModelStopReason
}

const EMPTY_REPLY_ERROR: ModelProviderError = {
	_tag: "ModelProviderError",
	error_type: "empty_model_reply",
	message: "Model provider returned an empty reply.",
	terminal: false,
}

export const clampModelReply = (
	reply: ModelProviderReply,
): Effect.Effect<ModelProviderReply & { readonly truncated?: true }, ModelProviderError> => {
	if (reply.text.length === 0) {
		return Effect.fail({
			...EMPTY_REPLY_ERROR,
			model_usage: { input_tokens: reply.input_tokens, output_tokens: reply.output_tokens },
		})
	}
	const truncated = reply.text.length > MAX_MESSAGE_TEXT_LENGTH
	return Effect.succeed({
		...reply,
		...(truncated ? { truncated: true as const } : {}),
		thinking:
			reply.thinking === null || reply.thinking.length === 0
				? null
				: reply.thinking.length > MAX_THINKING_TEXT_LENGTH
					? reply.thinking.slice(0, MAX_THINKING_TEXT_LENGTH)
					: reply.thinking,
		text: truncated ? reply.text.slice(0, MAX_MESSAGE_TEXT_LENGTH) : reply.text,
		stop_reason:
			truncated && reply.stop_reason.type === "end_turn"
				? { type: "budget_reached" as const }
				: reply.stop_reason,
	})
}

export const clampModelProviderError = (err: ModelProviderError): ModelProviderError => ({
	...err,
	error_type: clampText(err.error_type, MAX_ERROR_TYPE_LENGTH, "provider_error"),
	message: clampText(err.message, MAX_ERROR_MESSAGE_LENGTH, "Model provider failed."),
})

const INTERNAL_PROVIDER_ERROR: ModelProviderError = {
	_tag: "ModelProviderError",
	error_type: "provider_internal_error",
	message: "Model provider failed unexpectedly.",
	terminal: false,
}

/**
 * Wraps a raw model adapter so oversized reasoning traces, replies, or error
 * metadata are truncated before ExternalSystem schema validation and workflow
 * checkpointing, and empty replies are rejected as provider errors.
 */
export const boundedModelProvider = <R = never>(
	impl: Effect.Effect<
		{
			readonly generate: (args: {
				readonly session_id: SessionId
				readonly agent_id: string
				readonly agent_version: number
				readonly environment_id: string
				readonly turn: number
				readonly generation: number
				readonly input: ReadonlyArray<string>
			}) => Effect.Effect<
				ModelProviderReply,
				ModelProviderError | ModelRequestInterrupted | HarnessUnavailable
			>
			readonly interrupt: (args: {
				readonly session_id: SessionId
				readonly turn: number
				readonly generation: number
			}) => Effect.Effect<void, HarnessUnavailable>
		},
		never,
		R
	>,
) =>
	ModelProvider.toLayer(
		Effect.map(impl, (adapter) => ({
			generate: (args) =>
				Effect.exit(Effect.suspend(() => adapter.generate(args))).pipe(
					Effect.flatMap((exit) =>
						Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
							? Effect.die("the provider interrupted itself")
							: exit,
					),
					Effect.catchDefect((defect) =>
						Effect.andThen(
							Effect.logError("ModelProvider failed unexpectedly", defect),
							Effect.fail(INTERNAL_PROVIDER_ERROR),
						),
					),
					Effect.mapError((error) =>
						error._tag === "ModelProviderError" ? clampModelProviderError(error) : error,
					),
					Effect.flatMap(clampModelReply),
				),
			interrupt: adapter.interrupt,
		})),
	)
