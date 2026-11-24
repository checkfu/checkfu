import * as Domain from "@alchemy.run/domain"
import { SessionStatusIdle, SpanModelRequestEnd } from "./CommitModelReply.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { NonEmptyString, PositiveInt, ToolUseIdsText } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"

export class UserMessagesQueued extends Domain.Rejection(
	"UserMessagesQueued",
	{
		session_id: SessionId,
	},
	{
		httpApiStatus: 409,
		description: "User messages are queued behind the turn, so it cannot wait for an answer.",
	},
) {}

/**
 * Ends a turn that cannot go on until a person answers its waiting tool calls.
 * The harness keeps the calls parked; the session goes idle naming them.
 */
export class PauseTurn extends Domain.Command("PauseTurn", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		request_seq: PositiveInt,
		model_request_start_id: NonEmptyString,
		event_ids: ToolUseIdsText,
	},
	events: [SpanModelRequestEnd, SessionStatusIdle],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest, UserMessagesQueued],
}) {}
