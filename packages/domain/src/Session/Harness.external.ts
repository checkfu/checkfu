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
import { truncateText } from "./TextBounds.ts"

export const DEFAULT_TURN_TIMEOUT_MS = 600_000

export const ModelStopReason = Schema.Struct({
	type: Schema.Literals(["end_turn", "budget_reached", "refusal"]),
})
export type ModelStopReason = typeof ModelStopReason.Type

export const TurnFailed = Schema.TaggedStruct("TurnFailed", {
	error_type: ErrorType,
	message: ErrorMessage,
	terminal: Schema.Boolean,
	model_usage: Schema.optionalKey(ModelUsage),
})
export type TurnFailed = typeof TurnFailed.Type

export const TurnInterrupted = Schema.TaggedStruct("TurnInterrupted", {
	model_usage: Schema.optionalKey(ModelUsage),
})
export type TurnInterrupted = typeof TurnInterrupted.Type

export const TurnPaused = Schema.TaggedStruct("TurnPaused", {
	model_usage: ModelUsage,
})
export type TurnPaused = typeof TurnPaused.Type

export const HARNESS_UNAVAILABLE = "harness_unavailable"
export const HARNESS_UNAVAILABLE_MESSAGE = "The agent runtime could not be reached."
export const TURN_TIMEOUT = "model_request_timeout"
export const TURN_TIMEOUT_MESSAGE = "Model request timed out."
export const HarnessUnavailable = Schema.TaggedStruct("HarnessUnavailable", {})
export type HarnessUnavailable = typeof HarnessUnavailable.Type

export class Harness extends Domain.ExternalSystem("Harness", {
	runTurn: {
		args: {
			session_id: SessionId,
			agent_id: ResourceId,
			agent_version: PositiveInt,
			environment_id: ResourceId,
			turn: PositiveInt,
			input: Schema.Array(MessageText),
			last_reply_turn: Schema.optionalKey(NonNegativeInt),
			segment: Schema.optionalKey(PositiveInt),
		},
		success: {
			response_started_at: Schema.optionalKey(NonNegativeInt),
			thinking: Schema.NullOr(ThinkingText),
			text: MessageText,
			truncated: Schema.optional(Schema.Literal(true)),
			input_tokens: NonNegativeInt,
			output_tokens: NonNegativeInt,
			stop_reason: ModelStopReason,
		},
		error: [TurnFailed, TurnInterrupted, TurnPaused, HarnessUnavailable],
	},
	interrupt: {
		args: {
			session_id: SessionId,
			turn: PositiveInt,
		},
		error: HarnessUnavailable,
	},
	discardWorkspace: {
		args: {
			session_id: SessionId,
		},
	},
}) {}

const clampText = (value: string, maxLength: number, fallback: string): string => {
	if (value.length === 0) {
		return fallback
	}
	return truncateText(value, maxLength)
}

export interface HarnessReply {
	readonly response_started_at?: number
	readonly thinking: string | null
	readonly text: string
	readonly input_tokens: number
	readonly output_tokens: number
	readonly stop_reason: ModelStopReason
}

const EMPTY_REPLY_ERROR: TurnFailed = {
	_tag: "TurnFailed",
	error_type: "empty_model_reply",
	message: "Model provider returned an empty reply.",
	terminal: false,
}

export const clampHarnessReply = (
	reply: HarnessReply,
): Effect.Effect<HarnessReply & { readonly truncated?: true }, TurnFailed> => {
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
					? truncateText(reply.thinking, MAX_THINKING_TEXT_LENGTH)
					: reply.thinking,
		text: truncated ? truncateText(reply.text, MAX_MESSAGE_TEXT_LENGTH) : reply.text,
		stop_reason:
			truncated && reply.stop_reason.type === "end_turn"
				? { type: "budget_reached" as const }
				: reply.stop_reason,
	})
}

export const clampTurnFailure = (err: TurnFailed): TurnFailed => ({
	...err,
	error_type: clampText(err.error_type, MAX_ERROR_TYPE_LENGTH, "provider_error"),
	message: clampText(err.message, MAX_ERROR_MESSAGE_LENGTH, "Model provider failed."),
})

const INTERNAL_PROVIDER_ERROR: TurnFailed = {
	_tag: "TurnFailed",
	error_type: "provider_internal_error",
	message: "Model provider failed unexpectedly.",
	terminal: false,
}

export const boundedHarness = <R = never>(
	impl: Effect.Effect<
		{
			readonly runTurn: (args: {
				readonly session_id: SessionId
				readonly agent_id: string
				readonly agent_version: number
				readonly environment_id: string
				readonly turn: number
				readonly input: ReadonlyArray<string>
				readonly last_reply_turn?: number
				readonly segment?: number
			}) => Effect.Effect<
				HarnessReply,
				TurnFailed | TurnInterrupted | TurnPaused | HarnessUnavailable
			>
			readonly interrupt: (args: {
				readonly session_id: SessionId
				readonly turn: number
			}) => Effect.Effect<void, HarnessUnavailable>
			readonly discardWorkspace: (args: { readonly session_id: SessionId }) => Effect.Effect<void>
		},
		never,
		R
	>,
) =>
	Harness.toLayer(
		Effect.map(impl, (adapter) => ({
			runTurn: (args) =>
				Effect.exit(Effect.suspend(() => adapter.runTurn(args))).pipe(
					Effect.flatMap((exit) =>
						Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
							? Effect.die("the provider interrupted itself")
							: exit,
					),
					Effect.catchDefect((defect) =>
						Effect.andThen(
							Effect.logError("Harness failed unexpectedly", defect),
							Effect.fail(INTERNAL_PROVIDER_ERROR),
						),
					),
					Effect.mapError((error) =>
						error._tag === "TurnFailed" ? clampTurnFailure(error) : error,
					),
					Effect.flatMap(clampHarnessReply),
				),
			interrupt: adapter.interrupt,
			discardWorkspace: adapter.discardWorkspace,
		})),
	)
