import type { AgentState } from "../Agent/Agent.aggregate.ts"
import type { AgentId } from "../Agent/Agent.id.ts"
import { AgentArchivedError } from "../Agent/AgentArchived.rejection.ts"
import { AgentNotFound } from "../Agent/AgentNotFound.rejection.ts"
import type { EnvironmentState } from "../Environment/Environment.aggregate.ts"
import type { EnvironmentId } from "../Environment/Environment.id.ts"
import { EnvironmentArchivedError } from "../Environment/EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "../Environment/EnvironmentNotFound.rejection.ts"
import { AgentVersionNotFound } from "./AdmitSession.command.ts"

export const admissionRefusal = (
	agent: { readonly id: AgentId; readonly state: AgentState },
	environment: { readonly id: EnvironmentId; readonly state: EnvironmentState },
	pinned: number,
) => {
	if (agent.state.status === "") {
		return new AgentNotFound({ agent_id: agent.id })
	}
	if (agent.state.status !== "active") {
		return new AgentArchivedError({ agent_id: agent.id })
	}
	if (pinned > agent.state.version) {
		return new AgentVersionNotFound({ agent_id: agent.id, version: pinned })
	}
	if (environment.state.status === "" || environment.state.status === "deleted") {
		return new EnvironmentNotFound({ environment_id: environment.id })
	}
	if (environment.state.status !== "active") {
		return new EnvironmentArchivedError({ environment_id: environment.id })
	}
	return undefined
}
