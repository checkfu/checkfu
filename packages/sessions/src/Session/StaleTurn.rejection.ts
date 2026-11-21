import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { PositiveInt } from "./SessionTypes.ts"

export class StaleTurn extends Domain.Rejection(
	"StaleTurn",
	{
		session_id: SessionId,
		active_turn: PositiveInt,
		received_turn: PositiveInt,
	},
	{ httpApiStatus: 409, description: "The turn identifier does not match the active turn." },
) {}
