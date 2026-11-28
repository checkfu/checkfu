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

/** Hosting custody can close an allocated ID before an admission reaches its aggregate. */
export class SessionAdmissionFenced extends Domain.Event("session.admission_fenced") {}

export class FenceSessionAdmission extends Domain.Command("FenceSessionAdmission", {
	input: { session_id: SessionId },
	events: [SessionAdmissionFenced],
	rejects: [],
}) {}
