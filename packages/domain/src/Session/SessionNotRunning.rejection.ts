import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionStatus } from "./SessionTypes.ts"

export class SessionNotRunning extends Domain.Rejection(
	"SessionNotRunning",
	{ session_id: SessionId, status: SessionStatus },
	{ httpApiStatus: 409, description: "The session is not currently running a turn." },
) {}
