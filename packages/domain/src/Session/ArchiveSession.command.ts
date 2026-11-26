import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SpanModelRequestEnd } from "./CommitModelReply.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { PositiveInt, ToolUseIdsText } from "./SessionTypes.ts"

export class SessionArchived extends Domain.Event("session.archived") {}

export class SessionStatusTerminated extends Domain.Event("session.status_terminated", {
	running_turn: Schema.NullOr(PositiveInt).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(null)),
	),
	event_ids: Schema.optionalKey(ToolUseIdsText),
}) {}

export class ArchiveSession extends Domain.Command("ArchiveSession", {
	input: {
		session_id: SessionId,
	},
	events: [SpanModelRequestEnd, SessionStatusTerminated, SessionArchived],
	rejects: [SessionNotFound],
}) {}
