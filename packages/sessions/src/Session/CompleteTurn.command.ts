import * as Domain from "@alchemy.run/domain"
import { OpenModelRequests } from "./OpenModelRequests.rejection.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { PositiveInt, StopReason } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class SessionStatusIdle extends Domain.Event("session.status_idle", {
	stop_reason: StopReason,
}) {}

export class CompleteTurn extends Domain.Command("CompleteTurn", {
	target: SessionId,
	input: {
		turn: PositiveInt,
		stop_reason: StopReason,
	},
	events: [SessionStatusIdle],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, OpenModelRequests],
}) {}
