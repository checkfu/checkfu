import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { TurnContinued } from "./PauseTurn.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { ResourceId, SessionEventFields, ToolResultText } from "./SessionTypes.ts"
import { ToolResultReturned } from "./ToolConfirmation.aggregate.ts"
import { ToolConfirmationId } from "./ToolConfirmation.id.ts"
import { ToolConfirmationNotPending } from "./ToolConfirmationNotPending.rejection.ts"

export class UserCustomToolResult extends Domain.Event(
	"user.custom_tool_result",
	SessionEventFields["user.custom_tool_result"],
) {}

export class ReturnCustomToolResult extends Domain.Command("ReturnCustomToolResult", {
	input: {
		session_id: SessionId,
		confirmation_id: ToolConfirmationId,
		custom_tool_use_id: ResourceId,
		text: ToolResultText,
		is_error: Schema.Boolean,
	},
	events: [ToolResultReturned, UserCustomToolResult, SessionStatusRunning, TurnContinued],
	rejects: [SessionNotFound, SessionTerminated, ToolConfirmationNotPending],
}) {}
