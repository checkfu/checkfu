import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { NonEmptyString, NonNegativeInt, PositiveInt } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class SpanModelRequestStart extends Domain.Event("span.model_request_start", {
	model_request_start_id: NonEmptyString,
}) {}

export class DuplicateModelRequest extends Domain.Rejection(
	"DuplicateModelRequest",
	{
		session_id: SessionId,
		model_request_start_id: NonEmptyString,
		open_model_request_id: Schema.NullOr(NonEmptyString),
		model_requests_started: NonNegativeInt,
	},
	{
		httpApiStatus: 409,
		description: "A model request is already open or this request sequence has already been used.",
	},
) {}

export class OutOfOrderModelRequest extends Domain.Rejection(
	"OutOfOrderModelRequest",
	{
		session_id: SessionId,
		expected_request_seq: PositiveInt,
		received_request_seq: PositiveInt,
	},
	{
		httpApiStatus: 409,
		description: "Model request sequence number does not match the next expected request in turn.",
	},
) {}

export class RecordModelRequestStart extends Domain.Command("RecordModelRequestStart", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		request_seq: PositiveInt,
		model_request_start_id: NonEmptyString,
	},
	events: [SpanModelRequestStart],
	rejects: [
		SessionNotFound,
		SessionNotRunning,
		StaleTurn,
		DuplicateModelRequest,
		OutOfOrderModelRequest,
	],
}) {}
