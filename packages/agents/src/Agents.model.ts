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
