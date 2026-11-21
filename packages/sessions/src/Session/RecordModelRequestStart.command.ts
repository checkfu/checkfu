import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { NonEmptyString, PositiveInt } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class SpanModelRequestStart extends Domain.Event("span.model_request_start", {
	model_request_start_id: NonEmptyString,
}) {}

export class DuplicateModelRequest extends Domain.Rejection(
	"DuplicateModelRequest",
	{
		session_id: SessionId,
		model_request_start_id: NonEmptyString,
	},
	{
		httpApiStatus: 409,
		description: "A model request with this id has already been started in this turn.",
	},
) {}

export class RecordModelRequestStart extends Domain.Command("RecordModelRequestStart", {
	target: SessionId,
	input: {
		turn: PositiveInt,
		model_request_start_id: NonEmptyString,
	},
	events: [SpanModelRequestStart],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, DuplicateModelRequest],
}) {}
