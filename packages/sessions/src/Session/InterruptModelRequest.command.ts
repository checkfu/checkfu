import * as Domain from "@alchemy.run/domain"
import { SessionStatusIdle } from "./CompleteTurn.command.ts"
import { SpanModelRequestEnd, UnknownModelRequest } from "./RecordModelRequestEnd.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { ModelUsage, NonEmptyString, PositiveInt } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class InterruptModelRequest extends Domain.Command("InterruptModelRequest", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		request_seq: PositiveInt,
		model_request_start_id: NonEmptyString,
		model_usage: ModelUsage,
	},
	events: [SpanModelRequestEnd, SessionStatusIdle, SessionStatusRunning],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}
