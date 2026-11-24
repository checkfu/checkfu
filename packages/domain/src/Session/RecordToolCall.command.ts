import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import {
	NonEmptyString,
	PositiveInt,
	SessionEventFields,
	ToolCall,
	ToolInput,
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
	input: ToolInput,
}) {}

export class AgentMcpToolResult extends Domain.Event(
	"agent.mcp_tool_result",
	SessionEventFields["agent.mcp_tool_result"],
) {}

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
