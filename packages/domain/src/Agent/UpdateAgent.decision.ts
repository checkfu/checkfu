import * as Domain from "@alchemy.run/domain"
import { Agent } from "./Agent.aggregate.ts"
import { AgentArchivedError } from "./AgentArchived.rejection.ts"
import { AgentNotFound } from "./AgentNotFound.rejection.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"
import { AgentUpdated, AgentVersionConflict, UpdateAgent } from "./UpdateAgent.command.ts"

export class UpdateAgentDecision extends Domain.Decision(UpdateAgent, {
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
		if (cmd.expected_version !== undefined && cmd.expected_version !== head.version) {
			return new AgentVersionConflict({
				agent_id: agent.id,
				expected_version: cmd.expected_version,
				current_version: head.version,
			})
		}
		const name = cmd.changes.name === undefined ? head.name : cmd.changes.name
		const modelId = cmd.changes.model === undefined ? head.model_id : cmd.changes.model.id
		const hasSystem =
			cmd.changes.system === undefined ? head.has_system : cmd.changes.system !== null
		const system = cmd.changes.system === undefined ? head.system : (cmd.changes.system ?? "")
		const hasDescription =
			cmd.changes.description === undefined
				? head.has_description
				: cmd.changes.description !== null
		const description =
			cmd.changes.description === undefined ? head.description : (cmd.changes.description ?? "")
		if (
			[
				name === head.name,
				modelId === head.model_id,
				hasSystem === head.has_system,
				system === head.system,
				hasDescription === head.has_description,
				description === head.description,
			].every((same) => same)
		) {
			return []
		}
		const nextVersion = head.version + 1
		const next = {
			name,
			model: { id: modelId },
			system: hasSystem ? system : null,
			description: hasDescription ? description : null,
		}
		return [
			agent.record(
				new AgentUpdated({ version: nextVersion, version_id: cmd.next_version_id, ...next }),
			),
		]
	},
	transitions: {
		ChangeMintsNextVersionOrNoOps: ({ before, after, command }) => {
			const name = command.changes.name === undefined ? before.agent.name : command.changes.name
			const modelId =
				command.changes.model === undefined ? before.agent.model_id : command.changes.model.id
			const hasSystem =
				command.changes.system === undefined
					? before.agent.has_system
					: command.changes.system !== null
			const system =
				command.changes.system === undefined ? before.agent.system : (command.changes.system ?? "")
			const hasDescription =
				command.changes.description === undefined
					? before.agent.has_description
					: command.changes.description !== null
			const description =
				command.changes.description === undefined
					? before.agent.description
					: (command.changes.description ?? "")
			const unchanged = [
				name === before.agent.name,
				modelId === before.agent.model_id,
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
					].every((ok) => ok),
					[
						!unchanged,
						after.agent.version === before.agent.version + 1,
						after.agent.current_version_id === command.next_version_id,
						after.agent.name === name,
						after.agent.model_id === modelId,
						after.agent.has_system === hasSystem,
						after.agent.system === system,
						after.agent.has_description === hasDescription,
						after.agent.description === description,
					].every((ok) => ok),
				].some((ok) => ok),
			].every((ok) => ok)
		},
		UnchangedConfigMintsNothing: ({ before, after, command }) => {
			const name = command.changes.name === undefined ? before.agent.name : command.changes.name
			const modelId =
				command.changes.model === undefined ? before.agent.model_id : command.changes.model.id
			const hasSystem =
				command.changes.system === undefined
					? before.agent.has_system
					: command.changes.system !== null
			const system =
				command.changes.system === undefined ? before.agent.system : (command.changes.system ?? "")
			const hasDescription =
				command.changes.description === undefined
					? before.agent.has_description
					: command.changes.description !== null
			const description =
				command.changes.description === undefined
					? before.agent.description
					: (command.changes.description ?? "")
			return [
				before.agent.status !== "active",
				name !== before.agent.name,
				modelId !== before.agent.model_id,
				hasSystem !== before.agent.has_system,
				system !== before.agent.system,
				hasDescription !== before.agent.has_description,
				description !== before.agent.description,
				[
					after.agent.status === "active",
					after.agent.version === before.agent.version,
					after.agent.current_version_id === before.agent.current_version_id,
				].every((ok) => ok),
			].some((ok) => ok)
		},
	},
	reply: (states) => ({
		version: states.agent.version,
		version_id: AgentVersionId.make(states.agent.current_version_id, { disableChecks: true }),
	}),
}) {}
