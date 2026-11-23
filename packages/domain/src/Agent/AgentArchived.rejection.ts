import * as Domain from "@alchemy.run/domain"
import { AgentId } from "./Agent.id.ts"

export class AgentArchivedError extends Domain.Rejection(
	"AgentArchivedError",
	{ agent_id: AgentId },
	{ httpApiStatus: 409, description: "Agent is archived and cannot be modified." },
) {}
