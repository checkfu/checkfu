import { ModelStopReason, TurnInterrupted } from "@checkfu/domain/Session/Harness.external"
import { ModelUsage } from "@checkfu/domain/Session/SessionTypes"
import * as Schema from "effect/Schema"
import { SUPPORTED_PROVIDERS } from "./PiCatalog.ts"

export const PiSeedMessage = Schema.Struct({
	role: Schema.Literals(["user", "assistant"]),
	text: Schema.String,
})
export type PiSeedMessage = typeof PiSeedMessage.Type

export const PiSeed = Schema.Struct({
	api: Schema.String,
	messages: Schema.Array(PiSeedMessage),
	trimmed: Schema.optionalKey(Schema.Boolean),
})
export type PiSeed = typeof PiSeed.Type

export const PiTurnRequest = Schema.Struct({
	operationId: Schema.String,
	turn: Schema.Finite,
	provider: Schema.Literals(SUPPORTED_PROVIDERS),
	modelId: Schema.String,
	system: Schema.NullOr(Schema.String),
	text: Schema.String,
	seed: Schema.optionalKey(PiSeed),
})
export type PiTurnRequest = typeof PiTurnRequest.Type

export const PiTurnReply = Schema.Struct({
	thinking: Schema.NullOr(Schema.String),
	text: Schema.String,
	input_tokens: Schema.Finite,
	output_tokens: Schema.Finite,
	stop_reason: ModelStopReason,
})

// Not held to the domain's length limits: the API clamps a failure after it arrives.
export const PiTurnFailed = Schema.TaggedStruct("TurnFailed", {
	error_type: Schema.String,
	message: Schema.String,
	terminal: Schema.Boolean,
	model_usage: Schema.optionalKey(ModelUsage),
})

export const PiTurnOutcome = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), reply: PiTurnReply }),
	Schema.Struct({
		ok: Schema.Literal(false),
		error: Schema.Union([PiTurnFailed, TurnInterrupted]),
	}),
])
export type PiTurnOutcome = typeof PiTurnOutcome.Type

export const PiTurnResult = Schema.Union([PiTurnOutcome, Schema.Literal("history_required")])
export type PiTurnResult = typeof PiTurnResult.Type

export const PiRecoveredTurn = Schema.NullOr(PiTurnOutcome)
