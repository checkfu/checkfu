import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"

export class SessionStatusTerminated extends Domain.Event("session.status_terminated") {}

export class ArchiveSession extends Domain.Command("ArchiveSession", {
	input: {
		session_id: SessionId,
	},
	events: [SessionStatusTerminated],
	rejects: [SessionNotFound],
}) {}
