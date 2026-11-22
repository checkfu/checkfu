import * as Domain from "@alchemy.run/domain"
import { SessionStatusIdle } from "./CompleteTurn.command.ts"
import { SpanModelRequestEnd } from "./RecordModelRequestEnd.command.ts"
import { SessionErrorEvent } from "./RecordSessionError.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { ErrorMessage, ErrorType, PositiveInt } from "./SessionTypes.ts"

export class TurnAbandoned extends Domain.Event("turn.abandoned") {}

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
