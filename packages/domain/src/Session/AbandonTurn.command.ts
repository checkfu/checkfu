import * as Domain from "@alchemy.run/domain"
import { SessionStatusIdle, SpanModelRequestEnd } from "./CommitModelReply.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import {
	ErrorMessage,
	ErrorType,
	NonNegativeInt,
	PositiveInt,
	SessionEventFields,
} from "./SessionTypes.ts"

export class SessionErrorEvent extends Domain.Event(
	"session.error",
	SessionEventFields["session.error"],
) {}

export class TurnAbandoned extends Domain.Event("turn.abandoned", {
	turn: PositiveInt,
	generation: NonNegativeInt,
}) {}

export class AbandonTurn extends Domain.Command("AbandonTurn", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		error_type: ErrorType,
		message: ErrorMessage,
	},
	events: [
		SpanModelRequestEnd,
		SessionErrorEvent,
		TurnAbandoned,
		SessionStatusIdle,
		SessionStatusRunning,
	],
	rejects: [],
}) {}
