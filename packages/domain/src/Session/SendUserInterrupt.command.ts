import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SessionId, SessionInputEventId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { PositiveInt } from "./SessionTypes.ts"

export class UserInterrupt extends Domain.Event("user.interrupt", {
	event_id: Schema.optionalKey(SessionInputEventId),
	turn: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

export class SendUserInterrupt extends Domain.Command("SendUserInterrupt", {
	input: {
		session_id: SessionId,
		event_id: Schema.optionalKey(SessionInputEventId),
	},
	events: [UserInterrupt],
	rejects: [SessionNotFound, SessionTerminated, SessionNotRunning],
}) {}
