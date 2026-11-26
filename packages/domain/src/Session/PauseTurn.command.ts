import * as Domain from "@alchemy.run/domain"
import { SessionErrorEvent } from "./AbandonTurn.command.ts"
import { SessionStatusIdle, SpanModelRequestEnd } from "./CommitModelReply.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { ModelUsage, NonEmptyString, PositiveInt } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"

export class TurnAwaiting extends Domain.Event("turn.awaiting", {
	turn: PositiveInt,
}) {}

export class TurnContinued extends Domain.Event("turn.continued", {
	turn: PositiveInt,
	segment: PositiveInt,
}) {}

export class PauseTurn extends Domain.Command("PauseTurn", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		request_seq: PositiveInt,
		model_request_start_id: NonEmptyString,
		model_usage: ModelUsage,
	},
	events: [
		SpanModelRequestEnd,
		TurnAwaiting,
		TurnContinued,
		SessionErrorEvent,
		SessionStatusIdle,
		SessionStatusRunning,
	],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}
