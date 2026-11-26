import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { ResourceId } from "./SessionTypes.ts"

export class ToolConfirmationNotPending extends Domain.Rejection(
	"ToolConfirmationNotPending",
	{
		session_id: SessionId,
		tool_use_id: ResourceId,
	},
	{
		httpApiStatus: 409,
		description: "No tool call with this id is waiting for this answer in this session.",
	},
) {}
