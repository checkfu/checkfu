import { ModelStopReason, TurnInterrupted } from "@checkfu/domain/Session/Harness.external"
import { CustomTool } from "@checkfu/domain/Mcp/CustomTools"
import { McpServerBinding } from "@checkfu/domain/Mcp/McpServers"
import { ModelUsage, TextBlock, ToolCall } from "@checkfu/domain/Session/SessionTypes"
import * as Schema from "effect/Schema"
import { SUPPORTED_PROVIDERS } from "./PiCatalog.ts"

export const PiTurnRequest = Schema.Struct({
	operationId: Schema.String,
	turn: Schema.Finite,
	provider: Schema.Literals(SUPPORTED_PROVIDERS),
	modelId: Schema.String,
	system: Schema.NullOr(Schema.String),
	text: Schema.String,
	unpublishedOperationIds: Schema.optionalKey(Schema.Array(Schema.String)),
	/** The agent's MCP servers, as this session bound them. */
	mcp_servers: Schema.optionalKey(Schema.Array(McpServerBinding)),
	/** The tools the caller's application runs, as the agent version declares them. */
	custom_tools: Schema.optionalKey(Schema.Array(CustomTool)),
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

/**
 * The turn cannot go on until a person answers the tool calls in `waiting`. Pi keeps them parked
 * and has nothing else to do.
 */
export const PiTurnPaused = Schema.Struct({
	ok: Schema.Literal(false),
	waiting: Schema.Array(Schema.String),
	/** Those of `waiting` that wait for a result from the caller's application, not for a person's allow or deny. */
	waiting_results: Schema.optionalKey(Schema.Array(Schema.String)),
	tool_calls: Schema.optionalKey(Schema.Array(ToolCall)),
	/** The turn that asked carries on an operation an earlier turn started. */
	carried: Schema.optionalKey(Schema.Literal(true)),
})
export type PiTurnPaused = typeof PiTurnPaused.Type

export const PiTurnOutcome = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		reply: PiTurnReply,
		// The turn's tool calls, already bounded by the session object.
		tool_calls: Schema.optionalKey(Schema.Array(ToolCall)),
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		error: Schema.Union([PiTurnFailed, TurnInterrupted]),
	}),
	PiTurnPaused,
])
export type PiTurnOutcome = typeof PiTurnOutcome.Type

export const isPaused = (outcome: PiTurnOutcome): outcome is PiTurnPaused => "waiting" in outcome

/** A person's answer to one waiting tool call. */
export const PiToolDecision = Schema.Struct({
	tool_use_id: Schema.String,
	allow: Schema.Boolean,
	/** Why a call was denied, as the model is told; empty for the default wording. */
	message: Schema.String,
})

/** The result of one waiting custom tool call, as its caller's application returned it. */
export const PiToolResult = Schema.Struct({
	tool_use_id: Schema.String,
	content: Schema.Array(TextBlock),
	is_error: Schema.Boolean,
})

/** What ends a tool call's wait. A denial of a call that waits for a result ends it as a failed result. */
export const PiToolAnswer = Schema.Union([PiToolDecision, PiToolResult])

export const PiRecoveredTurn = Schema.NullOr(PiTurnOutcome)

// Every method the harness Worker serves, as its argument tuple and its result. The RPC type
// and the persisted lock are both derived from this, so neither can describe a different call.
export const PiHarnessCalls = {
	recoverTurn: { args: Schema.Tuple([Schema.String, Schema.String]), result: PiRecoveredTurn },
	runTurn: { args: Schema.Tuple([Schema.String, PiTurnRequest]), result: PiTurnOutcome },
	// A paused turn carries on once the answers to its waiting calls arrive.
	resumeTurn: {
		args: Schema.Tuple([Schema.String, Schema.String, Schema.Array(PiToolAnswer)]),
		result: PiRecoveredTurn,
	},
	waitingCalls: { args: Schema.Tuple([Schema.String]), result: Schema.Array(Schema.String) },
	// Whether Pi can check calls against each custom tool's input schema; the API asks before
	// it accepts an agent's tools.
	checkToolSchemas: {
		args: Schema.Tuple([Schema.Array(Schema.JsonObject)]),
		result: Schema.Array(Schema.Boolean),
	},
	cancelWaiting: { args: Schema.Tuple([Schema.String, Schema.String]), result: Schema.Void },
	abortTurn: { args: Schema.Tuple([Schema.String, Schema.String]), result: Schema.Boolean },
	// The workspace is the harness's: its tools run next to the session object that calls them.
	discardWorkspace: { args: Schema.Tuple([Schema.String]), result: Schema.Void },
	// A credential's secret is held by its connection object, which lives here beside the sessions
	// that use it. The API stores, replaces, confirms and erases it by credential id.
	// The secret is stored with the one MCP server URL it may ever be sent to.
	storeSecret: {
		args: Schema.Tuple([Schema.String, Schema.String, Schema.String]),
		result: Schema.Boolean,
	},
	replaceSecret: { args: Schema.Tuple([Schema.String, Schema.String]), result: Schema.Boolean },
	keepSecret: { args: Schema.Tuple([Schema.String]), result: Schema.Void },
	eraseSecret: { args: Schema.Tuple([Schema.String]), result: Schema.Void },
} as const
