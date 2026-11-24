import * as Domain from "@alchemy.run/domain"
import { PositiveInt } from "./AgentTypes.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentArchivedError } from "./AgentArchived.rejection.ts"
import { AgentNotFound } from "./AgentNotFound.rejection.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"
import { AgentUpdated, AgentVersionConflict } from "./UpdateAgent.command.ts"

/**
 * Mints the next version of an agent with the configuration it already has.
 * It is how a change to something versioned with an agent but kept outside
 * it, such as its MCP servers, becomes a version of its own.
 */
export class RepublishAgent extends Domain.Command("RepublishAgent", {
	input: {
		agent_id: AgentId,
		expected_version: PositiveInt,
		next_version_id: AgentVersionId,
	},
	events: [AgentUpdated],
	rejects: [AgentNotFound, AgentArchivedError, AgentVersionConflict],
	reply: {
		version: PositiveInt,
		version_id: AgentVersionId,
	},
}) {}
