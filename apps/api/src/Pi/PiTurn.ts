import { ModelStopReason, TurnInterrupted } from "@checkfu/domain/Session/Harness.external"
import { ModelUsage, ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import * as Schema from "effect/Schema"
import { OutputBytes, OutputsListing } from "../Workspace/SessionOutputs.ts"

const TURN_OPERATION_PREFIX = "turn:"

export const turnOperationId = (turn: number): string => `${TURN_OPERATION_PREFIX}${turn}`

export const turnOfOperation = (operationId: string): number | undefined => {
	const text = operationId.startsWith(TURN_OPERATION_PREFIX)
		? operationId.slice(TURN_OPERATION_PREFIX.length)
		: ""
	const turn = Number(text)
	return Number.isSafeInteger(turn) && turn >= 0 && String(turn) === text ? turn : undefined
}

export const PiTurnRequest = Schema.Struct({
	operationId: Schema.String,
	turn: Schema.Finite,
	provider: Schema.String.check(Schema.isMinLength(1)),
	modelId: Schema.String,
	system: Schema.NullOr(Schema.String),
	text: Schema.String,
	unpublishedOperationIds: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type PiTurnRequest = typeof PiTurnRequest.Type

export const PiTurnReply = Schema.Struct({
	thinking: Schema.NullOr(Schema.String),
	text: Schema.String,
	input_tokens: Schema.Finite,
	output_tokens: Schema.Finite,
	stop_reason: ModelStopReason,
})

export const PiTurnFailed = Schema.TaggedStruct("TurnFailed", {
	error_type: Schema.String,
	message: Schema.String,
	terminal: Schema.Boolean,
	model_usage: Schema.optionalKey(ModelUsage),
})

export const PiTurnOutcome = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		reply: PiTurnReply,
		tool_events: Schema.optionalKey(Schema.Array(ToolEvent)),
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		error: Schema.Union([PiTurnFailed, TurnInterrupted]),
		tool_events: Schema.optionalKey(Schema.Array(ToolEvent)),
	}),
])
export type PiTurnOutcome = typeof PiTurnOutcome.Type

export const PiRecoveredTurn = Schema.NullOr(PiTurnOutcome)

export const PiHarnessCalls = {
	recoverTurn: { args: Schema.Tuple([Schema.String, Schema.String]), result: PiRecoveredTurn },
	runTurn: { args: Schema.Tuple([Schema.String, PiTurnRequest]), result: PiTurnOutcome },
	abortTurn: { args: Schema.Tuple([Schema.String, Schema.String]), result: Schema.Boolean },
	listOutputs: { args: Schema.Tuple([Schema.String]), result: OutputsListing },
	readOutputs: {
		args: Schema.Tuple([Schema.String, Schema.Array(Schema.String)]),
		result: Schema.Array(OutputBytes),
	},
	discardWorkspace: { args: Schema.Tuple([Schema.String]), result: Schema.Void },
} as const
