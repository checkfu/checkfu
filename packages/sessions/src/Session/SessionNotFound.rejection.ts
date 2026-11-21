import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"

export class SessionNotFound extends Domain.Rejection(
	"SessionNotFound",
	{ session_id: SessionId },
	{ httpApiStatus: 404, description: "No session exists with this id." },
) {}
