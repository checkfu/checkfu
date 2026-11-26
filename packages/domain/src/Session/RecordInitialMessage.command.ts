import * as Domain from "@alchemy.run/domain"
import { SessionStatusRunning, UserMessage } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { MessageText, PositiveInt } from "./SessionTypes.ts"

export class RecordInitialMessage extends Domain.Command("RecordInitialMessage", {
	input: {
		session_id: SessionId,
		remaining: PositiveInt,
		text: MessageText,
	},
	events: [UserMessage, SessionStatusRunning],
}) {}
