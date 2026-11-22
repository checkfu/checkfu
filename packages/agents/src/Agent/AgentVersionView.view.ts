import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AgentDescription, AgentModel, AgentName, AgentSystem, PositiveInt } from "../AgentTypes.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentVersion } from "./AgentVersion.aggregate.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"

export const AgentVersionSnapshot = Schema.Struct({
	id: AgentVersionId,
	agent_id: AgentId,
	type: Schema.Literal("agent"),
	version: PositiveInt,
	name: AgentName,
	model: AgentModel,
	system: Schema.NullOr(AgentSystem),
	description: Schema.NullOr(AgentDescription),
	created_at: Schema.DateTimeUtc,
})
export type AgentVersionSnapshot = typeof AgentVersionSnapshot.Type

export class AgentVersionView extends Domain.View("AgentVersionView", {
	from: [AgentVersion],
	key: AgentVersion,
	state: Schema.NullOr(AgentVersionSnapshot),
	initial: null,
	evolve: {
		"agent_version.minted": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.key.id,
						agent_id: e.agent_id,
						type: "agent" as const,
						version: e.version,
						name: e.name,
						model: e.model,
						system: e.system,
						description: e.description,
						created_at: ctx.at,
					},
	},
}) {}
