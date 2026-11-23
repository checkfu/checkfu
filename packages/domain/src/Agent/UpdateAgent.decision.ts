import * as Domain from "@alchemy.run/domain"
import { Agent } from "./Agent.aggregate.ts"
import { AgentArchivedError } from "./AgentArchived.rejection.ts"
import { AgentNotFound } from "./AgentNotFound.rejection.ts"
import { AgentVersion, AgentVersionMinted } from "./AgentVersion.aggregate.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"
import { AgentVersionAlreadyExists } from "./AgentVersionAlreadyExists.rejection.ts"
import { AgentUpdated, AgentVersionConflict, UpdateAgent } from "./UpdateAgent.command.ts"

export class UpdateAgentDecision extends Domain.Decision(UpdateAgent, {
	reads: { agent: Agent, version: AgentVersion },
	keyOf: (cmd) => ({ agent: cmd.agent_id, version: cmd.next_version_id }),
	decide: ({ agent, version }, cmd) => {
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
		const hasSystem = cmd.system !== null
		const system = cmd.system ?? ""
		const hasDescription = cmd.description !== null
		const description = cmd.description ?? ""
		if (
			[
				cmd.name === head.name,
				cmd.model.id === head.model_id,
				hasSystem === head.has_system,
				system === head.system,
				hasDescription === head.has_description,
				description === head.description,
			].every((same) => same)
		) {
			return []
		}
		if (version.state.minted) {
			return new AgentVersionAlreadyExists({ version_id: version.id })
		}
		const nextVersion = head.version + 1
		return [
			agent.record(
				new AgentUpdated({
					version: nextVersion,
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
					version: nextVersion,
					name: cmd.name,
					model: cmd.model,
					system: cmd.system,
					description: cmd.description,
				}),
			),
		]
	},
	transitions: {
		ChangeMintsNextVersionOrNoOps: ({ before, after, command }) => {
			const hasSystem = command.system !== null
			const system = command.system ?? ""
			const hasDescription = command.description !== null
			const description = command.description ?? ""
			const unchanged = [
				command.name === before.agent.name,
				command.model.id === before.agent.model_id,
				hasSystem === before.agent.has_system,
				system === before.agent.system,
				hasDescription === before.agent.has_description,
				description === before.agent.description,
			].every((same) => same)
			return [
				before.agent.status === "active",
				after.agent.status === "active",
				[
					[
						unchanged,
						after.agent.version === before.agent.version,
						after.agent.current_version_id === before.agent.current_version_id,
						after.version.minted === before.version.minted,
					].every((ok) => ok),
					[
						!unchanged,
						after.agent.version === before.agent.version + 1,
						after.agent.current_version_id === command.next_version_id,
						after.agent.name === command.name,
						after.agent.model_id === command.model.id,
						after.agent.has_system === hasSystem,
						after.agent.system === system,
						after.agent.has_description === hasDescription,
						after.agent.description === description,
						!before.version.minted,
						after.version.minted,
						after.version.version === after.agent.version,
						after.version.agent_id === command.agent_id,
					].every((ok) => ok),
				].some((ok) => ok),
			].every((ok) => ok)
		},
		UnchangedConfigMintsNothing: ({ before, after, command }) => {
			const hasSystem = command.system !== null
			const system = command.system ?? ""
			const hasDescription = command.description !== null
			const description = command.description ?? ""
			return [
				before.agent.status !== "active",
				command.name !== before.agent.name,
				command.model.id !== before.agent.model_id,
				hasSystem !== before.agent.has_system,
				system !== before.agent.system,
				hasDescription !== before.agent.has_description,
				description !== before.agent.description,
				[
					after.agent.status === "active",
					after.agent.version === before.agent.version,
					after.agent.current_version_id === before.agent.current_version_id,
					after.version.minted === before.version.minted,
				].every((ok) => ok),
			].some((ok) => ok)
		},
	},
	reply: (states) => ({
		version: states.agent.version,
		version_id: AgentVersionId.make(states.agent.current_version_id, { disableChecks: true }),
	}),
}) {}
