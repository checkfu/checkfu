import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { PositiveInt } from "./SessionTypes.ts"

// Carries its turn, so whatever forwards it to the harness stops that turn and no later one.
export class UserInterrupt extends Domain.Event("user.interrupt", { turn: PositiveInt }) {}

export class SendUserInterrupt extends Domain.Command("SendUserInterrupt", {
	input: {
		session_id: SessionId,
	},
	events: [UserInterrupt],
	rejects: [SessionNotFound, SessionTerminated, SessionNotRunning],
}) {}
