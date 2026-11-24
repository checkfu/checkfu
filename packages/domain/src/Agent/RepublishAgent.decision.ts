import * as Domain from "@alchemy.run/domain"
import { Agent } from "./Agent.aggregate.ts"
import { AgentArchivedError } from "./AgentArchived.rejection.ts"
import { AgentNotFound } from "./AgentNotFound.rejection.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"
import { RepublishAgent } from "./RepublishAgent.command.ts"
import { AgentUpdated, AgentVersionConflict } from "./UpdateAgent.command.ts"

export class RepublishAgentDecision extends Domain.Decision(RepublishAgent, {
	reads: { agent: Agent },
	keyOf: (cmd) => ({ agent: cmd.agent_id }),
	decide: ({ agent }, cmd) => {
		if (agent.state.status === "") {
			return new AgentNotFound({ agent_id: agent.id })
		}
		if (agent.state.status !== "active") {
			return new AgentArchivedError({ agent_id: agent.id })
		}
		const head = agent.state
		if (cmd.expected_version !== head.version) {
			return new AgentVersionConflict({
				agent_id: agent.id,
				expected_version: cmd.expected_version,
				current_version: head.version,
			})
		}
		return [
			agent.record(
				new AgentUpdated({
					version: head.version + 1,
					version_id: cmd.next_version_id,
					name: head.name,
					model: { id: head.model_id },
					system: head.has_system ? head.system : null,
					description: head.has_description ? head.description : null,
				}),
			),
		]
	},
	transitions: {
		RepublishingMintsTheNextVersionUnchanged: ({ before, after, command }) =>
			[
				before.agent.status === "active",
				after.agent.status === "active",
				after.agent.version === before.agent.version + 1,
				after.agent.current_version_id === command.next_version_id,
				after.agent.name === before.agent.name,
				after.agent.model_id === before.agent.model_id,
				after.agent.has_system === before.agent.has_system,
				after.agent.system === before.agent.system,
				after.agent.has_description === before.agent.has_description,
				after.agent.description === before.agent.description,
			].every((ok) => ok),
	},
	reply: (states) => ({
		version: states.agent.version,
		version_id: AgentVersionId.make(states.agent.current_version_id, { disableChecks: true }),
	}),
}) {}
