import * as Domain from "@alchemy.run/domain"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { PositiveInt } from "./SessionTypes.ts"

/**
 * Sets a paused session running again when an answer arrived while its turn
 * was still pausing. It names the paused turn, so sending it twice, or after
 * the session moved on, does nothing.
 */
export class ResumeTurn extends Domain.Command("ResumeTurn", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
	},
	events: [SessionStatusRunning],
	rejects: [],
}) {}
