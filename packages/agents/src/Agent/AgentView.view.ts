import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AgentModel, NonEmptyString, PositiveInt } from "../AgentTypes.ts"
import { Agent } from "./Agent.aggregate.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"

export const AgentSnapshot = Schema.Struct({
	id: AgentId,
	type: Schema.Literal("agent"),
	version: PositiveInt,
	current_version_id: AgentVersionId,
	name: NonEmptyString,
	model: AgentModel,
	system: Schema.NullOr(Schema.String),
	description: Schema.NullOr(Schema.String),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type AgentSnapshot = typeof AgentSnapshot.Type

export class AgentView extends Domain.View("AgentView", {
	from: [Agent],
	key: Agent,
	state: Schema.NullOr(AgentSnapshot),
	initial: null,
	evolve: {
		"agent.created": (_state, e, ctx) => ({
			id: ctx.key.id,
			type: "agent" as const,
			version: e.version,
			current_version_id: e.version_id,
			name: e.name,
			model: e.model,
			system: e.system,
			description: e.description,
			created_at: ctx.at,
			updated_at: ctx.at,
			archived_at: null,
		}),
		"agent.updated": (state, e, ctx) =>
			state === null
				? null
				: {
						...state,
						version: e.version,
						current_version_id: e.version_id,
						name: e.name,
						model: e.model,
						system: e.system,
						description: e.description,
						updated_at: ctx.at,
					},
		"agent.archived": (state, _e, ctx) =>
			state === null || state.archived_at !== null
				? state
				: {
						...state,
						archived_at: ctx.at,
						updated_at: ctx.at,
					},
	},
}) {}
