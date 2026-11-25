import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Activity } from "effect/workflow"
import { RequestFailureDisposition } from "./FailModelRequest.command.ts"
import { ModelStopReason } from "./Harness.external.ts"
import {
	ErrorMessage,
	ErrorType,
	MessageText,
	ModelUsage,
	NonNegativeInt,
	PositiveInt,
	ResourceId,
	ThinkingText,
} from "./SessionTypes.ts"

export const StepOutcome = Schema.Struct({
	status: Schema.Literals(["proceed", "aborted"]),
})

export const TurnOutcome = Schema.Union([
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
	runHarnessTurn: { name: "run-harness-turn", success: TurnOutcome },
	interruptModelRequest: { name: "interrupt-model-request", success: StepOutcome },
	failModelRequest: { name: "fail-model-request", success: StepOutcome },
	commitModelReply: { name: "commit-model-reply", success: StepOutcome },
} as const

export type RunTurnActivityKey = keyof typeof RUN_TURN_ACTIVITIES

type ActivitySuccess<K extends RunTurnActivityKey> =
	(typeof RUN_TURN_ACTIVITIES)[K]["success"]["Type"]

export const runTurnActivity = <K extends RunTurnActivityKey, R>(
	key: K,
	execute: Effect.Effect<ActivitySuccess<K>, never, R>,
) =>
	Activity.make<R, (typeof RUN_TURN_ACTIVITIES)[K]["success"]>({
		name: RUN_TURN_ACTIVITIES[key].name,
		success: RUN_TURN_ACTIVITIES[key].success,
		execute,
	})

export const OpenedRun = Schema.Union([
	Schema.Struct({
		outcome: Schema.Literal("started"),
		agent_id: ResourceId,
		agent_version: PositiveInt,
	}),
	Schema.Struct({
		outcome: Schema.Literal("refused"),
		error_type: ErrorType,
		message: ErrorMessage,
		unrecoverable: Schema.Boolean,
	}),
	Schema.Struct({ outcome: Schema.Literal("reported") }),
])

export const OPEN_AUTOMATION_RUN_ACTIVITIES = {
	open: { name: "open", success: OpenedRun },
	report: { name: "report", success: Schema.Boolean },
} as const

export type OpenAutomationRunActivityKey = keyof typeof OPEN_AUTOMATION_RUN_ACTIVITIES

export const openAutomationRunActivity = <K extends OpenAutomationRunActivityKey, R>(
	key: K,
	execute: Effect.Effect<(typeof OPEN_AUTOMATION_RUN_ACTIVITIES)[K]["success"]["Type"], never, R>,
	attempt?: number,
) =>
	Activity.make<R, (typeof OPEN_AUTOMATION_RUN_ACTIVITIES)[K]["success"]>({
		name:
			attempt === undefined
				? OPEN_AUTOMATION_RUN_ACTIVITIES[key].name
				: `${OPEN_AUTOMATION_RUN_ACTIVITIES[key].name}:${attempt}`,
		success: OPEN_AUTOMATION_RUN_ACTIVITIES[key].success,
		execute,
	})
