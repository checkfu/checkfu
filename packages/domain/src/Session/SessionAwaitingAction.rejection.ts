import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"

export class SessionAwaitingAction extends Domain.Rejection(
	"SessionAwaitingAction",
	{ session_id: SessionId },
	{
		httpApiStatus: 409,
		description:
			"The session's turn waits on tool calls; answer them with user.tool_confirmation or user.custom_tool_result first.",
	},
) {}
