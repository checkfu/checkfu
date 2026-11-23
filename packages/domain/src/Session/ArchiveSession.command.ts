import * as Domain from "@alchemy.run/domain"
import { SpanModelRequestEnd } from "./CommitModelReply.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"

export class SessionArchived extends Domain.Event("session.archived") {}

export class SessionStatusTerminated extends Domain.Event("session.status_terminated") {}

export class ArchiveSession extends Domain.Command("ArchiveSession", {
	input: {
		session_id: SessionId,
	},
	events: [SpanModelRequestEnd, SessionStatusTerminated, SessionArchived],
	rejects: [SessionNotFound],
}) {}
