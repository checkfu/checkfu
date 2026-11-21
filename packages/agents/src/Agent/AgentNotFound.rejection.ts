import * as Domain from "@alchemy.run/domain"
import { AgentId } from "./Agent.id.ts"

export class AgentNotFound extends Domain.Rejection(
	"AgentNotFound",
	{ agent_id: AgentId },
	{ httpApiStatus: 404, description: "Agent does not exist." },
) {}
