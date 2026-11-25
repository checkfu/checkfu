import * as Domain from "@alchemy.run/domain"
import { NO_AGENT_TOOLS, NO_MCP_SERVERS } from "../Mcp/McpServers.ts"
import { Agent } from "./Agent.aggregate.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"
import { AgentAlreadyExists, AgentCreated, CreateAgent } from "./CreateAgent.command.ts"

export class CreateAgentDecision extends Domain.Decision(CreateAgent, {
	reads: { agent: Agent },
	keyOf: (cmd) => ({ agent: cmd.agent_id }),
	decide: ({ agent }, cmd) => {
		if (agent.state.status !== "") {
			return new AgentAlreadyExists({ agent_id: agent.id })
		}
		return [
			agent.record(
				new AgentCreated({
					version: 1,
					version_id: cmd.version_id,
					name: cmd.name,
					model: cmd.model,
					system: cmd.system,
					description: cmd.description,
					mcp_servers: cmd.mcp_servers ?? NO_MCP_SERVERS,
					tools: cmd.tools ?? NO_AGENT_TOOLS,
				}),
			),
		]
	},
	transitions: {
		NewAgentStartsAtVersionOne: ({ before, after, command }) =>
			[
				before.agent.status === "",
				after.agent.status === "active",
				after.agent.version === 1,
				after.agent.current_version_id === command.version_id,
			].every((ok) => ok),
		NewAgentKeepsItsDeclaredServers: ({ before, after, command }) =>
			before.agent.status !== "" ||
			after.agent.mcp_servers === (command.mcp_servers ?? NO_MCP_SERVERS),
		NewAgentKeepsItsDeclaredTools: ({ before, after, command }) =>
			before.agent.status !== "" || after.agent.tools === (command.tools ?? NO_AGENT_TOOLS),
	},
	reply: (states) => ({
		version: states.agent.version,
		version_id: AgentVersionId.make(states.agent.current_version_id, { disableChecks: true }),
	}),
}) {}
