import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { SessionStatusIdle } from "./CompleteTurn.command.ts"
import { OpenModelRequests } from "./OpenModelRequests.rejection.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { PositiveInt, SessionErrorBody } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class SessionErrorEvent extends Domain.Event("session.error", {
	error: SessionErrorBody,
}) {}

export class RecordSessionError extends Domain.Command("RecordSessionError", {
	target: SessionId,
	input: {
		turn: Schema.NullOr(PositiveInt),
		error: SessionErrorBody,
	},
	events: [SessionErrorEvent, SessionStatusIdle, SessionStatusTerminated],
	rejects: [SessionNotFound, SessionTerminated, SessionNotRunning, StaleTurn, OpenModelRequests],
}) {}
