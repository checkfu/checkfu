import * as Domain from "@alchemy.run/domain"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { AdmitSession } from "./AdmitSession.command.ts"
import { admissionRefusal } from "./AdmissionRefusal.ts"
import { SessionAlreadyExists, SessionCreated } from "./CreateSession.command.ts"
import { Session } from "./Session.aggregate.ts"

export class AdmitSessionDecision extends Domain.Decision(AdmitSession, {
	reads: { agent: Agent, environment: Environment, session: Session },
	keyOf: (cmd) => ({
		agent: cmd.agent_id,
		environment: cmd.environment_id,
		session: cmd.session_id,
	}),
	decide: ({ agent, environment, session }, cmd) => {
		if (session.state._tag !== "Uninitialized") {
			return new SessionAlreadyExists({ session_id: session.id })
		}
		const pinnedVersion = cmd.agent_version ?? agent.state.version
		const refused = admissionRefusal(agent, environment, pinnedVersion)
		if (refused !== undefined) {
			return refused
		}
		return [
			session.record(
				new SessionCreated({
					agent_id: agent.id,
					agent_version: pinnedVersion,
					environment_id: environment.id,
					title: cmd.title,
					resources: cmd.resources,
				}),
			),
		]
	},
	transitions: {
		OnlyActiveAgentAndEnvironmentAdmitSession: ({ before, after }) =>
			before.agent.status === "active" &&
			before.environment.status === "active" &&
			before.session._tag === "Uninitialized" &&
			after.session._tag === "Idle" &&
			after.session.turn === 0,
		PinnedVersionWithinAgentHead: ({ before, command, events }) => {
			const pinned = command.agent_version ?? before.agent.version
			return (
				before.agent.version >= 1 &&
				pinned >= 1 &&
				pinned <= before.agent.version &&
				events.length === 1 &&
				events.every(
					(event) =>
						event.agent_id === command.agent_id &&
						event.agent_version === pinned &&
						event.environment_id === command.environment_id,
				)
			)
		},
		AdmissionLeavesAgentAndEnvironmentUnchanged: ({ before, after }) =>
			[
				after.agent.status === before.agent.status,
				after.agent.version === before.agent.version,
				after.agent.current_version_id === before.agent.current_version_id,
				after.agent.name === before.agent.name,
				after.agent.model_id === before.agent.model_id,
				after.agent.has_system === before.agent.has_system,
				after.agent.system === before.agent.system,
				after.agent.has_description === before.agent.has_description,
				after.agent.description === before.agent.description,
				after.environment.status === before.environment.status,
				after.environment.version === before.environment.version,
				after.environment.name === before.environment.name,
			].every((ok) => ok),
	},
	reply: (states, events) => {
		const created = events.find((event) => event._tag === "session.created")
		return {
			agent_version: created !== undefined ? created.agent_version : states.agent.version,
		}
	},
}) {}
