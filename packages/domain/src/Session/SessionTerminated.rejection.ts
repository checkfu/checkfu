import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"

export class SessionTerminated extends Domain.Rejection(
	"SessionTerminated",
	{ session_id: SessionId },
	{ httpApiStatus: 409, description: "The session has already been terminated." },
) {}
