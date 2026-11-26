import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AgentModel, NonEmptyString, PositiveInt } from "./AgentTypes.ts"
import { McpServers, decodeMcpServers } from "../Mcp/McpServers.ts"
import { Agent } from "./Agent.aggregate.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"

export const AgentVersionLookupId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("AgentVersionLookupId"),
)
export type AgentVersionLookupId = typeof AgentVersionLookupId.Type

export const agentVersionLookupKey = (agentId: string, version: number): AgentVersionLookupId =>
	AgentVersionLookupId.make(`${agentId}@${version}`)

export const AgentVersionSnapshot = Schema.Struct({
	id: AgentVersionId,
	agent_id: AgentId,
	type: Schema.Literal("agent"),
	version: PositiveInt,
	name: NonEmptyString,
	model: AgentModel,
	system: Schema.NullOr(Schema.String),
	description: Schema.NullOr(Schema.String),
	mcp_servers: McpServers,
	created_at: Schema.DateTimeUtc,
})
export type AgentVersionSnapshot = typeof AgentVersionSnapshot.Type

export class AgentVersionByNumberView extends Domain.View("AgentVersionByNumberView", {
	version: 3,
	from: [Agent],
	key: AgentVersionLookupId,
	keyOf: {
		"agent.created": ({ event, source }) => agentVersionLookupKey(source.id, event.version),
		"agent.updated": ({ event, source }) => agentVersionLookupKey(source.id, event.version),
		"agent.archived": () => undefined,
	},
	state: Schema.NullOr(AgentVersionSnapshot),
	initial: null,
	evolve: {
		"agent.created": (state, e, ctx) =>
			state ?? {
				id: e.version_id,
				agent_id: ctx.source.id,
				type: "agent" as const,
				version: e.version,
				name: e.name,
				model: e.model,
				system: e.system,
				description: e.description,
				mcp_servers: decodeMcpServers(e.mcp_servers),
				created_at: ctx.at,
			},
		"agent.updated": (state, e, ctx) =>
			state ?? {
				id: e.version_id,
				agent_id: ctx.source.id,
				type: "agent" as const,
				version: e.version,
				name: e.name,
				model: e.model,
				system: e.system,
				description: e.description,
				mcp_servers: decodeMcpServers(e.mcp_servers),
				created_at: ctx.at,
			},
		"agent.archived": (state) => state,
	},
}) {}
