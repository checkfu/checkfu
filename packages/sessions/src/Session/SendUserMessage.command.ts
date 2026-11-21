import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { PositiveInt, TextBlocks } from "./SessionTypes.ts"

export class UserMessage extends Domain.Event("user.message", {
	content: TextBlocks,
}) {}

export class SessionStatusRunning extends Domain.Event("session.status_running") {}

export class SendUserMessage extends Domain.Command("SendUserMessage", {
	target: SessionId,
	input: {
		content: TextBlocks,
	},
	events: [UserMessage, SessionStatusRunning],
	rejects: [SessionNotFound, SessionTerminated],
	reply: {
		turn: PositiveInt,
	},
}) {}
