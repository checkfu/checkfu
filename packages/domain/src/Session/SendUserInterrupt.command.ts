import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"

export class UserInterrupt extends Domain.Event("user.interrupt") {}

export class SendUserInterrupt extends Domain.Command("SendUserInterrupt", {
	input: {
		session_id: SessionId,
	},
	events: [UserInterrupt],
	rejects: [SessionNotFound, SessionTerminated, SessionNotRunning],
}) {}
