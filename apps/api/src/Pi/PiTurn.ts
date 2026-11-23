import {
	ModelStopReason,
	TurnFailed,
	TurnInterrupted,
} from "@checkfu/domain/Session/Harness.external"
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

export const PiTurnOutcome = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), reply: PiTurnReply }),
	Schema.Struct({ ok: Schema.Literal(false), error: Schema.Union([TurnFailed, TurnInterrupted]) }),
])
export type PiTurnOutcome = typeof PiTurnOutcome.Type

export const PiTurnResult = Schema.Union([PiTurnOutcome, Schema.Literal("history_required")])
export type PiTurnResult = typeof PiTurnResult.Type

export const PiRecoveredTurn = Schema.NullOr(PiTurnOutcome)
