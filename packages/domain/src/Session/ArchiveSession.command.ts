import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SpanModelRequestEnd } from "./CommitModelReply.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { PositiveInt, ToolUseIdsText } from "./SessionTypes.ts"

export class SessionArchived extends Domain.Event("session.archived") {}

export class SessionStatusTerminated extends Domain.Event("session.status_terminated", {
	running_turn: Schema.NullOr(PositiveInt),
	event_ids: ToolUseIdsText,
}) {}

export class ArchiveSession extends Domain.Command("ArchiveSession", {
	input: {
		session_id: SessionId,
	},
	events: [SpanModelRequestEnd, SessionStatusTerminated, SessionArchived],
	rejects: [SessionNotFound],
}) {}
