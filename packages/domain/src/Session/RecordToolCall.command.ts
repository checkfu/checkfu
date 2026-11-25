import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import {
	ActionInput,
	NonEmptyString,
	PositiveInt,
	SessionEventFields,
	ToolCall,
	ToolInput,
	ToolResult,
	ToolUse,
} from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"

export class AgentToolUse extends Domain.Event("agent.tool_use", {
	...SessionEventFields["agent.tool_use"],
	input: ToolInput,
}) {}

export class AgentToolResult extends Domain.Event(
	"agent.tool_result",
	SessionEventFields["agent.tool_result"],
) {}

export class AgentMcpToolUse extends Domain.Event("agent.mcp_tool_use", {
	...SessionEventFields["agent.mcp_tool_use"],
	input: ActionInput,
}) {}

export class AgentMcpToolResult extends Domain.Event(
	"agent.mcp_tool_result",
	SessionEventFields["agent.mcp_tool_result"],
) {}

export class AgentCustomToolUse extends Domain.Event("agent.custom_tool_use", {
	...SessionEventFields["agent.custom_tool_use"],
	input: ActionInput,
}) {}

export class RecordToolCall extends Domain.Command("RecordToolCall", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		model_request_start_id: NonEmptyString,
		call: ToolCall,
	},
	events: [AgentToolUse, AgentToolResult, AgentMcpToolUse, AgentMcpToolResult],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}

export class RecordToolResult extends Domain.Command("RecordToolResult", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		model_request_start_id: NonEmptyString,
		result: ToolResult,
	},
	events: [AgentToolResult, AgentMcpToolResult],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}

export class RecordToolUse extends Domain.Command("RecordToolUse", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		model_request_start_id: NonEmptyString,
		use: ToolUse,
	},
	events: [AgentToolUse],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}
