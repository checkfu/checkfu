import { EnvironmentNetworking } from "@checkfu/domain/Environment/EnvironmentTypes"
import { AgentToolsText, McpServerBinding } from "@checkfu/domain/Mcp/McpServers"
import { ModelStopReason, TurnInterrupted } from "@checkfu/domain/Session/Harness.external"
import { ModelUsage, ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import * as Schema from "effect/Schema"
import { OutputBytes, OutputsListing } from "../Workspace/SessionOutputs.ts"
import { HeldSecret, PutMode, PutOutcome } from "../Connection/SecretCustody.ts"

const TURN_OPERATION_PREFIX = "turn:"

export const turnOperationId = (turn: number): string => `${TURN_OPERATION_PREFIX}${turn}`

export const turnOfOperation = (operationId: string): number | undefined => {
	const text = operationId.startsWith(TURN_OPERATION_PREFIX)
		? operationId.slice(TURN_OPERATION_PREFIX.length)
		: ""
	const turn = Number(text)
	return Number.isSafeInteger(turn) && turn >= 0 && String(turn) === text ? turn : undefined
}

export const McpTurn = Schema.Struct({
	servers: Schema.Array(McpServerBinding),
	networking: Schema.NullOr(EnvironmentNetworking),
})
export type McpTurn = typeof McpTurn.Type

export const MCP_TURN_KEY = "mcp-turn"

export const PiTurnRequest = Schema.Struct({
	operationId: Schema.String,
	turn: Schema.Finite,
	provider: Schema.String.check(Schema.isMinLength(1)),
	modelId: Schema.String,
	system: Schema.NullOr(Schema.String),
	systemContext: Schema.optionalKey(Schema.String),
	text: Schema.String,
	unpublishedOperationIds: Schema.optionalKey(Schema.Array(Schema.String)),
	mcp: Schema.optionalKey(McpTurn),
	tools: Schema.optionalKey(AgentToolsText),
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

export const PiParkedCall = Schema.Struct({
	tool_use_id: Schema.String,
	awaits: Schema.Literals(["confirmation", "result"]),
	name: Schema.String,
	mcp_server_name: Schema.String,
	input: Schema.JsonObject,
})
export type PiParkedCall = typeof PiParkedCall.Type

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
	Schema.Struct({
		ok: Schema.Literal("paused"),
		calls: Schema.Array(PiParkedCall),
		tool_events: Schema.optionalKey(Schema.Array(ToolEvent)),
	}),
])
export type PiTurnOutcome = typeof PiTurnOutcome.Type

export const PiActionAnswer = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("confirmation"),
		allow: Schema.Boolean,
		deny_message: Schema.String,
	}),
	Schema.Struct({ type: Schema.Literal("result"), text: Schema.String, is_error: Schema.Boolean }),
])

export const PiRecoveredTurn = Schema.NullOr(PiTurnOutcome)

export const PiHarnessCalls = {
	recoverTurn: { args: Schema.Tuple([Schema.String, Schema.String]), result: PiRecoveredTurn },
	runTurn: { args: Schema.Tuple([Schema.String, PiTurnRequest]), result: PiTurnOutcome },
	abortTurn: { args: Schema.Tuple([Schema.String, Schema.String]), result: Schema.Boolean },
	listOutputs: {
		args: Schema.Tuple([Schema.String, Schema.Int]),
		result: Schema.NullOr(OutputsListing),
	},
	readOutputs: {
		args: Schema.Tuple([Schema.String, Schema.Int, Schema.Array(Schema.String)]),
		result: Schema.NullOr(Schema.Array(OutputBytes)),
	},
	pauseUsage: {
		args: Schema.Tuple([Schema.String, Schema.String, Schema.String]),
		result: ModelUsage,
	},
	answerCall: {
		args: Schema.Tuple([Schema.String, Schema.String, PiActionAnswer]),
		result: Schema.Literals(["delivered", "gone"]),
	},
	customToolFaults: {
		args: Schema.Tuple([
			Schema.Array(Schema.Struct({ name: Schema.String, input_schema: Schema.JsonObject })),
			Schema.Array(Schema.String),
		]),
		result: Schema.Array(Schema.NullOr(Schema.String)),
	},
	discardWorkspace: { args: Schema.Tuple([Schema.String]), result: Schema.Void },
	putSecret: {
		args: Schema.Tuple([Schema.String, Schema.String, HeldSecret, Schema.String, PutMode]),
		result: PutOutcome,
	},
	secretUsable: { args: Schema.Tuple([Schema.String, Schema.String]), result: Schema.Boolean },
	eraseSecret: { args: Schema.Tuple([Schema.String, Schema.String]), result: Schema.Void },
	sealVault: { args: Schema.Tuple([Schema.String]), result: Schema.Void },
} as const
