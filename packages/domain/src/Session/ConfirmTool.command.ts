import * as Domain from "@alchemy.run/domain"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import {
	DenyMessage,
	ResourceId,
	SessionEventFields,
	ToolConfirmationResult,
} from "./SessionTypes.ts"
import { ToolConfirmationAnswered } from "./ToolConfirmation.aggregate.ts"
import { ToolConfirmationId } from "./ToolConfirmation.id.ts"
import { ToolConfirmationNotPending } from "./ToolConfirmationNotPending.rejection.ts"

export class UserToolConfirmation extends Domain.Event(
	"user.tool_confirmation",
	SessionEventFields["user.tool_confirmation"],
) {}

/** A person's answer to one waiting tool call. `deny_message` is empty when none was given. */
export class ConfirmTool extends Domain.Command("ConfirmTool", {
	input: {
		session_id: SessionId,
		confirmation_id: ToolConfirmationId,
		tool_use_id: ResourceId,
		result: ToolConfirmationResult,
		deny_message: DenyMessage,
	},
	events: [ToolConfirmationAnswered, UserToolConfirmation, SessionStatusRunning],
	rejects: [SessionNotFound, SessionTerminated, ToolConfirmationNotPending],
}) {}
