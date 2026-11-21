import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { SessionStatusIdle } from "./CompleteTurn.command.ts"
import { SpanModelRequestEnd, UnknownModelRequest } from "./RecordModelRequestEnd.command.ts"
import { SessionErrorEvent } from "./RecordSessionError.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { ErrorMessage, ErrorType, NonEmptyString, PositiveInt } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class FailModelRequest extends Domain.Command("FailModelRequest", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		request_seq: PositiveInt,
		model_request_start_id: NonEmptyString,
		error_type: ErrorType,
		message: ErrorMessage,
		terminal: Schema.Boolean,
	},
	events: [
		SpanModelRequestEnd,
		SessionErrorEvent,
		SessionStatusIdle,
		SessionStatusRunning,
		SessionStatusTerminated,
	],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}
