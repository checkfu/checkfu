import * as Domain from "@alchemy.run/domain"
import { AgentId } from "./Agent.id.ts"
import { AgentNotFound } from "./AgentNotFound.rejection.ts"

export class AgentArchived extends Domain.Event("agent.archived") {}

export class ArchiveAgent extends Domain.Command("ArchiveAgent", {
	input: {
		agent_id: AgentId,
	},
	events: [AgentArchived],
	rejects: [AgentNotFound],
}) {}
