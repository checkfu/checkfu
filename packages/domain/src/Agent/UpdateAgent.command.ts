import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import {
	AgentDescription,
	AgentModel,
	AgentName,
	AgentSystem,
	NonEmptyString,
	PositiveInt,
} from "./AgentTypes.ts"
import { McpServersText } from "../Mcp/McpServers.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentArchivedError } from "./AgentArchived.rejection.ts"
import { AgentNotFound } from "./AgentNotFound.rejection.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"

export class AgentUpdated extends Domain.Event("agent.updated", {
	version: PositiveInt,
	version_id: AgentVersionId,
	name: NonEmptyString,
	model: AgentModel,
	system: Schema.NullOr(Schema.String),
	description: Schema.NullOr(Schema.String),
	mcp_servers: Schema.optionalKey(McpServersText),
}) {}

export class AgentVersionConflict extends Domain.Rejection(
	"AgentVersionConflict",
	{
		agent_id: AgentId,
		expected_version: PositiveInt,
		current_version: PositiveInt,
	},
	{ httpApiStatus: 409, description: "Agent version does not match." },
) {}

export class UpdateAgent extends Domain.Command("UpdateAgent", {
	input: {
		agent_id: AgentId,
		expected_version: PositiveInt,
		next_version_id: AgentVersionId,
		changes: Schema.Struct({
			name: Schema.optionalKey(AgentName),
			model: Schema.optionalKey(AgentModel),
			system: Schema.optionalKey(Schema.NullOr(AgentSystem)),
			description: Schema.optionalKey(Schema.NullOr(AgentDescription)),
			mcp_servers: Schema.optionalKey(McpServersText),
		}),
	},
	events: [AgentUpdated],
	rejects: [AgentNotFound, AgentArchivedError, AgentVersionConflict],
	reply: {
		version: PositiveInt,
		version_id: AgentVersionId,
	},
}) {}
