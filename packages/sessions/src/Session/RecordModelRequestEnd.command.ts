import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { ModelUsage, NonEmptyString, PositiveInt } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class SpanModelRequestEnd extends Domain.Event("span.model_request_end", {
	model_request_start_id: NonEmptyString,
	model_usage: ModelUsage,
	is_error: Schema.NullOr(Schema.Boolean),
}) {}

export class UnknownModelRequest extends Domain.Rejection(
	"UnknownModelRequest",
	{
		session_id: SessionId,
		model_request_start_id: NonEmptyString,
	},
	{ httpApiStatus: 409, description: "No open model request exists with this id." },
) {}

export class RecordModelRequestEnd extends Domain.Command("RecordModelRequestEnd", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		request_seq: PositiveInt,
		model_request_start_id: NonEmptyString,
		model_usage: ModelUsage,
		is_error: Schema.NullOr(Schema.Boolean),
	},
	events: [SpanModelRequestEnd],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}
