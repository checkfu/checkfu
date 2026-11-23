import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionErrorEvent, TurnAbandoned } from "./AbandonTurn.command.ts"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { SessionStatusIdle, SpanModelRequestEnd } from "./CommitModelReply.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { ErrorMessage, ErrorType, ModelUsage, NonEmptyString, PositiveInt } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"

export const RequestFailureDisposition = Schema.Literals(["exhausted", "terminal", "abandoned"])

export class FailModelRequest extends Domain.Command("FailModelRequest", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		request_seq: PositiveInt,
		model_request_start_id: NonEmptyString,
		model_usage: ModelUsage,
		error_type: ErrorType,
		message: ErrorMessage,
		disposition: RequestFailureDisposition,
	},
	events: [
		SpanModelRequestEnd,
		SessionErrorEvent,
		TurnAbandoned,
		SessionStatusIdle,
		SessionStatusRunning,
		SessionStatusTerminated,
	],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}
