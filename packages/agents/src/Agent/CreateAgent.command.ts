import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AgentDescription, AgentModel, AgentName, AgentSystem, PositiveInt } from "../AgentTypes.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentVersionMinted } from "./AgentVersion.aggregate.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"
import { AgentVersionAlreadyExists } from "./AgentVersionAlreadyExists.rejection.ts"

export class AgentCreated extends Domain.Event("agent.created", {
	version: PositiveInt,
	version_id: AgentVersionId,
	name: AgentName,
	model: AgentModel,
	system: Schema.NullOr(AgentSystem),
	description: Schema.NullOr(AgentDescription),
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
	},
	events: [AgentCreated, AgentVersionMinted],
	rejects: [AgentAlreadyExists, AgentVersionAlreadyExists],
	reply: {
		version: PositiveInt,
		version_id: AgentVersionId,
	},
}) {}
