import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SpanModelRequestEnd } from "./CommitModelReply.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { PositiveInt } from "./SessionTypes.ts"

export class SessionArchived extends Domain.Event("session.archived") {}

// The turn that was running when the session ended, so a stop reaches it; null when none was.
// A termination recorded before it carried one reads as naming none.
export class SessionStatusTerminated extends Domain.Event("session.status_terminated", {
	running_turn: Schema.NullOr(PositiveInt).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(null)),
	),
}) {}

export class ArchiveSession extends Domain.Command("ArchiveSession", {
	input: {
		session_id: SessionId,
	},
	events: [SpanModelRequestEnd, SessionStatusTerminated, SessionArchived],
	rejects: [SessionNotFound],
}) {}
