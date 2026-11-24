import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import * as Schema from "effect/Schema"
import { MessageText, PositiveInt, SessionEventFields } from "./SessionTypes.ts"

export class UserMessage extends Domain.Event("user.message", {
	content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: MessageText })).check(
		Schema.isMinLength(1),
	),
}) {}

export class SessionStatusRunning extends Domain.Event(
	"session.status_running",
	SessionEventFields["session.status_running"],
) {}

export class PendingMessageQueueFull extends Domain.Rejection(
	"PendingMessageQueueFull",
	{
		session_id: SessionId,
		limit: PositiveInt,
	},
	{
		httpApiStatus: 429,
		description: "Too many queued user messages are already waiting for the active turn.",
	},
) {}

export class SessionAwaitingAction extends Domain.Rejection(
	"SessionAwaitingAction",
	{
		session_id: SessionId,
	},
	{
		httpApiStatus: 409,
		description:
			"The session is waiting for tool calls to be answered. Answer them or send an interrupt first.",
	},
) {}

export class SendUserMessage extends Domain.Command("SendUserMessage", {
	input: {
		session_id: SessionId,
		text: MessageText,
	},
	events: [UserMessage, SessionStatusRunning],
	rejects: [SessionNotFound, SessionTerminated, PendingMessageQueueFull, SessionAwaitingAction],
	reply: {
		turn: PositiveInt,
	},
}) {}
