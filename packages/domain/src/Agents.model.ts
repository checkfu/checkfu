import * as Domain from "@alchemy.run/domain"
import { Agent } from "./Agent/Agent.aggregate.ts"
import { AgentVersionByNumberView } from "./Agent/AgentVersionByNumberView.view.ts"
import { AgentView } from "./Agent/AgentView.view.ts"
import { CreateAgentDecision } from "./Agent/CreateAgent.decision.ts"
import { UpdateAgentDecision } from "./Agent/UpdateAgent.decision.ts"

export class Agents extends Domain.Model("Agents", {
	aggregates: [Agent],
	decisions: [CreateAgentDecision, UpdateAgentDecision],
	views: [AgentView, AgentVersionByNumberView],
	invariants: {
		AgentViewMatchesAgent: (m) =>
			[
				m.Agent.every((a) => {
					const view = m.AgentView.find((v) => v.id === a.id)
					if (a.state.status === "") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === a.id,
						view.state.version === a.state.version,
						view.state.current_version_id === a.state.current_version_id,
						view.state.name === a.state.name,
						view.state.model.id === a.state.model_id,
						(view.state.system !== null) === a.state.has_system,
						(view.state.system ?? "") === a.state.system,
						(view.state.description !== null) === a.state.has_description,
						(view.state.description ?? "") === a.state.description,
						!!view.state.archived_at === (a.state.status === "archived"),
					].every((ok) => ok)
				}),
				m.AgentView.every((v) =>
					m.Agent.some((a) => [a.id === v.id, a.state.status !== ""].every((ok) => ok)),
				),
			].every((ok) => ok),
		EveryVersionIsRecordedByNumber: (m) =>
			m.Agent.every((a) => {
				if (a.state.status === "") {
					return true
				}
				if (
					m.AgentVersionByNumberView.filter((v) => v.state.agent_id === a.id).length !==
					a.state.version
				) {
					return false
				}
				const view = m.AgentVersionByNumberView.find((v) => v.id === `${a.id}@${a.state.version}`)
				if (view === undefined) {
					return false
				}
				return [
					view.state.agent_id === a.id,
					view.state.id === a.state.current_version_id,
					view.state.version === a.state.version,
					view.state.name === a.state.name,
					view.state.model.id === a.state.model_id,
					(view.state.system !== null) === a.state.has_system,
					(view.state.system ?? "") === a.state.system,
					(view.state.description !== null) === a.state.has_description,
					(view.state.description ?? "") === a.state.description,
				].every((ok) => ok)
			}),
		EveryRecordedVersionBelongsToItsAgent: (m) =>
			m.AgentVersionByNumberView.every((v) =>
				m.Agent.some((a) => {
					const source = a.events
						.filter((event) => event._tag === "agent.created" || event._tag === "agent.updated")
						.find((event) => event.version === v.state.version)
					if (source === undefined) {
						return false
					}
					return [
						a.id === v.state.agent_id,
						a.state.status !== "",
						v.state.version <= a.state.version,
						v.id === `${a.id}@${v.state.version}`,
						source.version_id === v.state.id,
						source.name === v.state.name,
						source.model.id === v.state.model.id,
						source.system === v.state.system,
						source.description === v.state.description,
					].every((ok) => ok)
				}),
			),
	},
	sometimes: {
		AnAgentIsUpdated: (m) =>
			m.Agent.some((a) => [a.state.status === "active", a.state.version >= 2].every((ok) => ok)),
		AnAgentIsArchived: (m) => m.Agent.some((a) => a.state.status === "archived"),
	},
}) {}

export class AgentsApi extends Domain.Api("AgentsApi", {
	model: Agents,
	commands: ["CreateAgent", "UpdateAgent", "ArchiveAgent"],
	views: ["AgentView", "AgentVersionByNumberView"],
}) {}
