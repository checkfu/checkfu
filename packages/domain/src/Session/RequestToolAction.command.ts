import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AgentCustomToolUse, AgentMcpToolUse } from "./RecordToolCall.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { ActionInput, NonEmptyString, PositiveInt, ResourceId } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { ToolCallAwaits, ToolConfirmationRequested } from "./ToolConfirmation.aggregate.ts"
import { ToolConfirmationId } from "./ToolConfirmation.id.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"

export class RequestToolAction extends Domain.Command("RequestToolAction", {
	input: {
		session_id: SessionId,
		confirmation_id: ToolConfirmationId,
		turn: PositiveInt,
		model_request_start_id: NonEmptyString,
		tool_use_id: ResourceId,
		name: ResourceId,
		input: ActionInput,
		awaits: ToolCallAwaits,
		mcp_server_name: Schema.String,
	},
	events: [ToolConfirmationRequested, AgentMcpToolUse, AgentCustomToolUse],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}
