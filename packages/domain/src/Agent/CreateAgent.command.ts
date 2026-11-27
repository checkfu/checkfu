import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AgentDescription, AgentModel, AgentName, AgentSystem, PositiveInt } from "./AgentTypes.ts"
import { AgentToolsText, McpServersText } from "../Mcp/McpServers.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"

export class AgentCreated extends Domain.Event("agent.created", {
	version: PositiveInt,
	version_id: AgentVersionId,
	name: AgentName,
	model: AgentModel,
	system: Schema.NullOr(AgentSystem),
	description: Schema.NullOr(AgentDescription),
	mcp_servers: McpServersText,
	tools: AgentToolsText,
}) {}

export class AgentAlreadyExists extends Domain.Rejection(
	"AgentAlreadyExists",
	{ agent_id: AgentId },
	{ httpApiStatus: 409, description: "An agent with this id already exists." },
) {}

export class CreateAgent extends Domain.Command("CreateAgent", {
	input: {
		agent_id: AgentId,
		version_id: AgentVersionId,
		name: AgentName,
		model: AgentModel,
		system: Schema.NullOr(AgentSystem),
		description: Schema.NullOr(AgentDescription),
		mcp_servers: McpServersText,
		tools: AgentToolsText,
	},
	events: [AgentCreated],
	rejects: [AgentAlreadyExists],
	reply: {
		version: PositiveInt,
		version_id: AgentVersionId,
	},
}) {}
