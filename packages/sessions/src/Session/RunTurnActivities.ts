import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Activity } from "effect/workflow"
import { RequestFailureDisposition } from "./FailModelRequest.command.ts"
import { ModelStopReason } from "./ModelProvider.external.ts"
import {
	ErrorMessage,
	ErrorType,
	MessageText,
	ModelUsage,
	NonNegativeInt,
	ThinkingText,
} from "./SessionTypes.ts"

export const StepOutcome = Schema.Struct({
	status: Schema.Literals(["proceed", "aborted"]),
})

export const GenerateOutcome = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		thinking: Schema.NullOr(ThinkingText),
		text: MessageText,
		truncated: Schema.optional(Schema.Literal(true)),
		input_tokens: NonNegativeInt,
		output_tokens: NonNegativeInt,
		stop_reason: ModelStopReason,
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		interrupted: Schema.Literal(true),
		model_usage: ModelUsage,
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		interrupted: Schema.Literal(false),
		model_usage: ModelUsage,
		error_type: ErrorType,
		message: ErrorMessage,
		disposition: RequestFailureDisposition,
	}),
])

export const RUN_TURN_ACTIVITIES = {
	startModelRequest: { name: "start-model-request", success: StepOutcome },
	generateModelReply: { name: "generate-model-reply", success: GenerateOutcome },
	interruptModelRequest: { name: "interrupt-model-request", success: StepOutcome },
	failModelRequest: { name: "fail-model-request", success: StepOutcome },
	commitModelReply: { name: "commit-model-reply", success: StepOutcome },
} as const

export type RunTurnActivityKey = keyof typeof RUN_TURN_ACTIVITIES

type ActivitySuccess<K extends RunTurnActivityKey> =
	(typeof RUN_TURN_ACTIVITIES)[K]["success"]["Type"]

/**
 * Single factory for RunTurn workflow activities. Every activity key must be
 * declared in {@link RUN_TURN_ACTIVITIES} so its checkpointed output schema is
 * automatically covered by `Persisted.lock.json`.
 */
export const runTurnActivity = <K extends RunTurnActivityKey, R>(
	key: K,
	execute: Effect.Effect<ActivitySuccess<K>, never, R>,
) =>
	Activity.make<R, (typeof RUN_TURN_ACTIVITIES)[K]["success"]>({
		name: RUN_TURN_ACTIVITIES[key].name,
		success: RUN_TURN_ACTIVITIES[key].success,
		execute,
	})
