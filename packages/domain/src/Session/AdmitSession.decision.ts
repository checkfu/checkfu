import * as Domain from "@alchemy.run/domain"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { AdmitSession } from "./AdmitSession.command.ts"
import { admissionRefusal } from "./AdmissionRefusal.ts"
import { SessionAlreadyExists, SessionCreated } from "./CreateSession.command.ts"
import { SessionStatusRunning, UserMessage } from "./SendUserMessage.command.ts"
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
		const created = session.record(
			new SessionCreated({
				agent_id: agent.id,
				agent_version: pinnedVersion,
				environment_id: environment.id,
				title: cmd.title,
			}),
		)
		const [first, ...queued] = cmd.initial_messages ?? []
		if (first === undefined) {
			return [created]
		}
		return [
			created,
			session.record(new UserMessage({ content: [{ type: "text", text: first }] })),
			session.record(new SessionStatusRunning({ turn: 1 })),
			...queued.map((text) =>
				session.record(new UserMessage({ content: [{ type: "text", text }] })),
			),
		]
	},
	transitions: {
		OnlyActiveAgentAndEnvironmentAdmitSession: ({ before, after, command }) =>
			before.agent.status === "active" &&
			before.environment.status === "active" &&
			before.session._tag === "Uninitialized" &&
			((command.initial_messages ?? []).length === 0
				? after.session._tag === "Idle" && after.session.turn === 0
				: after.session._tag === "Running" &&
					after.session.turn === 1 &&
					after.session.pending_user_messages === (command.initial_messages ?? []).length - 1),
		PinnedVersionWithinAgentHead: ({ before, command, events }) => {
			const pinned = command.agent_version ?? before.agent.version
			return (
				before.agent.version >= 1 &&
				pinned >= 1 &&
				pinned <= before.agent.version &&
				events.some(
					(event) =>
						event._tag === "session.created" &&
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
