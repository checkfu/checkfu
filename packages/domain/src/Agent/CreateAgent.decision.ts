import * as Domain from "@alchemy.run/domain"
import { Agent } from "./Agent.aggregate.ts"
import { AgentVersion, AgentVersionMinted } from "./AgentVersion.aggregate.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"
import { AgentVersionAlreadyExists } from "./AgentVersionAlreadyExists.rejection.ts"
import { AgentAlreadyExists, AgentCreated, CreateAgent } from "./CreateAgent.command.ts"

export class CreateAgentDecision extends Domain.Decision(CreateAgent, {
	reads: { agent: Agent, version: AgentVersion },
	keyOf: (cmd) => ({ agent: cmd.agent_id, version: cmd.version_id }),
	decide: ({ agent, version }, cmd) => {
		if (agent.state.status !== "") {
			return new AgentAlreadyExists({ agent_id: agent.id })
		}
		if (version.state.minted) {
			return new AgentVersionAlreadyExists({ version_id: version.id })
		}
		return [
			agent.record(
				new AgentCreated({
					version: 1,
					version_id: version.id,
					name: cmd.name,
					model: cmd.model,
					system: cmd.system,
					description: cmd.description,
				}),
			),
			version.record(
				new AgentVersionMinted({
					agent_id: agent.id,
					version: 1,
					name: cmd.name,
					model: cmd.model,
					system: cmd.system,
					description: cmd.description,
				}),
			),
		]
	},
	transitions: {
		NewAgentStartsAtVersionOne: ({ before, after, command }) =>
			[
				before.agent.status === "",
				!before.version.minted,
				after.agent.status === "active",
				after.agent.version === 1,
				after.agent.current_version_id === command.version_id,
				after.version.minted,
				after.version.version === 1,
				after.version.agent_id === command.agent_id,
			].every((ok) => ok),
	},
	reply: (states) => ({
		version: states.agent.version,
		version_id: AgentVersionId.make(states.agent.current_version_id, { disableChecks: true }),
	}),
}) {}
