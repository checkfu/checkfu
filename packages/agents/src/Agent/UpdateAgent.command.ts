import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import {
	AgentDescription,
	AgentModel,
	AgentName,
	AgentSystem,
	NonEmptyString,
	PositiveInt,
} from "../AgentTypes.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentArchivedError } from "./AgentArchived.rejection.ts"
import { AgentNotFound } from "./AgentNotFound.rejection.ts"
import { AgentVersionMinted } from "./AgentVersion.aggregate.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"
import { AgentVersionAlreadyExists } from "./AgentVersionAlreadyExists.rejection.ts"

export class AgentUpdated extends Domain.Event("agent.updated", {
	version: PositiveInt,
	version_id: AgentVersionId,
	name: NonEmptyString,
	model: AgentModel,
	system: Schema.NullOr(Schema.String),
	description: Schema.NullOr(Schema.String),
}) {}

export class AgentVersionConflict extends Domain.Rejection(
	"AgentVersionConflict",
	{
		agent_id: AgentId,
		expected_version: PositiveInt,
		current_version: PositiveInt,
	},
	{ httpApiStatus: 409, description: "Agent version does not match expected_version." },
) {}

export class UpdateAgent extends Domain.Command("UpdateAgent", {
	input: {
		agent_id: AgentId,
		expected_version: PositiveInt,
		next_version_id: AgentVersionId,
		name: AgentName,
		model: AgentModel,
		system: Schema.NullOr(AgentSystem),
		description: Schema.NullOr(AgentDescription),
	},
	events: [AgentUpdated, AgentVersionMinted],
	rejects: [AgentNotFound, AgentArchivedError, AgentVersionConflict, AgentVersionAlreadyExists],
	reply: {
		version: PositiveInt,
		version_id: AgentVersionId,
	},
}) {}
