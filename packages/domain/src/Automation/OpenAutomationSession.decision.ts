import * as Domain from "@alchemy.run/domain"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { admissionRefusal } from "../Session/AdmissionRefusal.ts"
import { SessionAlreadyExists, SessionCreated } from "../Session/CreateSession.command.ts"
import { SessionStatusRunning, UserMessage } from "../Session/SendUserMessage.command.ts"
import { Session } from "../Session/Session.aggregate.ts"
import { OpenAutomationSession } from "./OpenAutomationSession.command.ts"

export class OpenAutomationSessionDecision extends Domain.Decision(OpenAutomationSession, {
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
					...(cmd.automation_id === undefined ? {} : { automation_id: cmd.automation_id }),
					title: cmd.title,
					resources: cmd.resources,
					...(cmd.mcp_server_credentials === undefined
						? {}
						: { mcp_server_credentials: cmd.mcp_server_credentials }),
				}),
			),
			session.record(new UserMessage({ content: [{ type: "text", text: cmd.text }] })),
			session.record(new SessionStatusRunning({ turn: 1 })),
		]
	},
	transitions: {
		OnlyActiveAgentAndEnvironmentOpenAnAutomationSession: ({ before, after }) =>
			[
				before.agent.status === "active",
				before.environment.status === "active",
				before.session._tag === "Uninitialized",
				after.session._tag === "Running",
			].every((ok) => ok),
		AnAutomationSessionOpensOnItsFirstTurnWithNothingQueued: ({ after, events }) =>
			after.session._tag === "Running" &&
			after.session.turn === 1 &&
			after.session.pending_user_messages === 0 &&
			events.length === 3,
		AnAutomationSessionPinsAVersionWithinTheAgentHead: ({ before, command }) =>
			command.agent_version === null || command.agent_version <= before.agent.version,
		AnAutomationSessionRecordsItsAutomation: ({ command, events }) =>
			events.some(
				(event) =>
					event._tag === "session.created" && event.automation_id === command.automation_id,
			),
		FirstTurnAdmissionKeepsGivenCredentials: ({ command, events }) =>
			events.some(
				(event) =>
					event._tag === "session.created" &&
					event.mcp_server_credentials === command.mcp_server_credentials,
			),
		OpeningAnAutomationSessionLeavesAgentAndEnvironmentUnchanged: ({ before, after }) =>
			[
				after.agent.status === before.agent.status,
				after.agent.version === before.agent.version,
				after.environment.status === before.environment.status,
				after.environment.version === before.environment.version,
			].every((ok) => ok),
	},
}) {}
