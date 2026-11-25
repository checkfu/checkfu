import * as Domain from "@alchemy.run/domain"
import { AgentSnapshot } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { decodeAgentTools, decodeMcpServers } from "../Mcp/McpServers.ts"
import { Agent } from "./Agent.aggregate.ts"

export { AgentSnapshot }

export class AgentView extends Domain.View("AgentView", {
	version: 3,
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
			mcp_servers: decodeMcpServers(e.mcp_servers),
			tools: decodeAgentTools(e.tools),
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
						mcp_servers:
							e.mcp_servers === undefined ? state.mcp_servers : decodeMcpServers(e.mcp_servers),
						tools: e.tools === undefined ? state.tools : decodeAgentTools(e.tools),
						updated_at: ctx.at,
					},
		"agent.archived": (state, _e, ctx) =>
			state === null || state.archived_at
				? state
				: {
						...state,
						archived_at: ctx.at,
						updated_at: ctx.at,
					},
	},
}) {}
