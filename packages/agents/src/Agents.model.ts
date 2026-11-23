import * as Domain from "@alchemy.run/domain"
import { Agent } from "./Agent/Agent.aggregate.ts"
import { AgentVersion } from "./Agent/AgentVersion.aggregate.ts"
import { AgentVersionByNumberView } from "./Agent/AgentVersionByNumberView.view.ts"
import { AgentVersionView } from "./Agent/AgentVersionView.view.ts"
import { AgentView } from "./Agent/AgentView.view.ts"
import { CreateAgentDecision } from "./Agent/CreateAgent.decision.ts"
import { UpdateAgentDecision } from "./Agent/UpdateAgent.decision.ts"

export class Agents extends Domain.Model("Agents", {
	aggregates: [Agent, AgentVersion],
	decisions: [CreateAgentDecision, UpdateAgentDecision],
	views: [AgentView, AgentVersionView, AgentVersionByNumberView],
	invariants: {
		AgentViewMatchesAgent: (m) =>
			[
				m.Agent.every((a) => {
					const view = m.AgentView.find((v) => v.id === a.id)
					if (a.state.status === "") return view === undefined
					if (view === undefined) return false
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
		AgentVersionViewMatchesAgentVersion: (m) =>
			[
				m.AgentVersion.every((av) => {
					const view = m.AgentVersionView.find((v) => v.id === av.id)
					if (!av.state.minted) return view === undefined
					if (view === undefined) return false
					return [
						view.state.id === av.id,
						view.state.agent_id === av.state.agent_id,
						view.state.version === av.state.version,
						view.state.name === av.state.name,
						view.state.model.id === av.state.model_id,
						(view.state.system !== null) === av.state.has_system,
						(view.state.system ?? "") === av.state.system,
						(view.state.description !== null) === av.state.has_description,
						(view.state.description ?? "") === av.state.description,
					].every((ok) => ok)
				}),
				m.AgentVersionView.every((v) =>
					m.AgentVersion.some((av) => [av.id === v.id, av.state.minted].every((ok) => ok)),
				),
			].every((ok) => ok),
		AgentVersionByNumberMatchesAgentVersion: (m) =>
			[
				m.AgentVersion.every((av) => {
					if (!av.state.minted) return true
					const lookupId = `${av.state.agent_id}@${av.state.version}`
					const view = m.AgentVersionByNumberView.find((v) => v.id === lookupId)
					if (view === undefined) return false
					return [
						view.state.id === av.id,
						view.state.agent_id === av.state.agent_id,
						view.state.version === av.state.version,
						view.state.name === av.state.name,
						view.state.model.id === av.state.model_id,
						(view.state.system !== null) === av.state.has_system,
						(view.state.system ?? "") === av.state.system,
						(view.state.description !== null) === av.state.has_description,
						(view.state.description ?? "") === av.state.description,
					].every((ok) => ok)
				}),
				m.AgentVersionByNumberView.every((v) =>
					m.AgentVersion.some((av) =>
						[
							av.state.minted,
							av.id === v.state.id,
							v.id === `${av.state.agent_id}@${av.state.version}`,
						].every((ok) => ok),
					),
				),
			].every((ok) => ok),
	},
	relations: {
		AMintedVersionBelongsToItsAgent: Domain.Relation({
			over: { version: AgentVersion, agent: Agent },
			holds: ({ version, agent }) =>
				[
					!version.state.minted,
					version.state.agent_id !== agent.id,
					[agent.state.status !== "", version.state.version <= agent.state.version].every(
						(ok) => ok,
					),
				].some((ok) => ok),
		}),
		AnAgentsHeadIsItsLatestVersion: Domain.Relation({
			over: { agent: Agent, version: AgentVersion },
			holds: ({ agent, version }) =>
				[
					agent.state.status === "",
					agent.state.current_version_id !== version.id,
					[
						version.state.minted,
						version.state.agent_id === agent.id,
						version.state.version === agent.state.version,
						version.state.name === agent.state.name,
						version.state.model_id === agent.state.model_id,
						version.state.has_system === agent.state.has_system,
						version.state.system === agent.state.system,
						version.state.has_description === agent.state.has_description,
						version.state.description === agent.state.description,
					].every((ok) => ok),
				].some((ok) => ok),
		}),
		VersionNumbersAreDistinct: Domain.Relation({
			over: { a: AgentVersion, b: AgentVersion },
			holds: ({ a, b }) =>
				[
					a.id === b.id,
					!a.state.minted,
					!b.state.minted,
					a.state.agent_id !== b.state.agent_id,
					a.state.version !== b.state.version,
				].some((ok) => ok),
		}),
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
	views: ["AgentView", "AgentVersionView", "AgentVersionByNumberView"],
}) {}
