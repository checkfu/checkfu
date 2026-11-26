import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"

export class InitialMessagesPending extends Domain.Rejection(
	"InitialMessagesPending",
	{ session_id: SessionId },
	{ httpApiStatus: 409, description: "The session is recording its initial events." },
) {}
