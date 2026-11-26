import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AgentId } from "../Agent/Agent.id.ts"
import { AgentArchivedError } from "../Agent/AgentArchived.rejection.ts"
import { AgentNotFound } from "../Agent/AgentNotFound.rejection.ts"
import { EnvironmentArchivedError } from "../Environment/EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "../Environment/EnvironmentNotFound.rejection.ts"
import { McpServerCredentialsText } from "../Mcp/McpServers.ts"
import { SessionAlreadyExists, SessionCreated } from "./CreateSession.command.ts"
import { InitialMessages } from "./InitialMessages.ts"
import { SessionId } from "./Session.id.ts"
import { MAX_IDENTIFIER_LENGTH, PositiveInt, SessionTitle } from "./SessionTypes.ts"

export const BoundedAgentId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("AgentId"))

export const BoundedEnvironmentId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("EnvironmentId"))

export class AgentVersionNotFound extends Domain.Rejection(
	"AgentVersionNotFound",
	{
		agent_id: AgentId,
		version: PositiveInt,
	},
	{ httpApiStatus: 404, description: "Agent version not found." },
) {}

const admission = {
	input: {
		session_id: SessionId,
		agent_id: BoundedAgentId,
		agent_version: Schema.NullOr(PositiveInt),
		environment_id: BoundedEnvironmentId,
		title: Schema.NullOr(SessionTitle),
		mcp_server_credentials: McpServerCredentialsText,
	},
	events: [SessionCreated],
	rejects: [
		AgentNotFound,
		AgentArchivedError,
		AgentVersionNotFound,
		EnvironmentNotFound,
		EnvironmentArchivedError,
		SessionAlreadyExists,
	],
	reply: {
		agent_version: PositiveInt,
	},
}
export class AdmitSession extends Domain.Command("AdmitSession", admission) {}

export class AdmitSessionWithMessages extends Domain.Command("AdmitSessionWithMessages", {
	...admission,
	input: { ...admission.input, initial_messages: InitialMessages },
}) {}
