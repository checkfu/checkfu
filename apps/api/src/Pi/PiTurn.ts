import { ModelStopReason, TurnInterrupted } from "@checkfu/domain/Session/Harness.external"
import { McpServerBinding } from "@checkfu/domain/Mcp/McpServers"
import { ModelUsage, ToolCall } from "@checkfu/domain/Session/SessionTypes"
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
])
export type PiTurnOutcome = typeof PiTurnOutcome.Type

export const PiRecoveredTurn = Schema.NullOr(PiTurnOutcome)

// Every method the harness Worker serves, as its argument tuple and its result. The RPC type
// and the persisted lock are both derived from this, so neither can describe a different call.
export const PiHarnessCalls = {
	recoverTurn: { args: Schema.Tuple([Schema.String, Schema.String]), result: PiRecoveredTurn },
	runTurn: { args: Schema.Tuple([Schema.String, PiTurnRequest]), result: PiTurnOutcome },
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
