import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
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
import { SessionResources } from "./SessionResource.ts"
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

export const repositoryResources = SessionResources.check(
	Schema.makeFilter(
		(resources) => resources.every((resource) => resource.type === "github_repository"),
		{ expected: "resources other than repositories must use mounted session admission" },
	),
)

export const admissionFields = {
	session_id: SessionId,
	agent_id: BoundedAgentId,
	agent_version: Schema.NullOr(PositiveInt),
	environment_id: BoundedEnvironmentId,
	title: Schema.NullOr(SessionTitle),
	mcp_server_credentials: McpServerCredentialsText,
	resources: repositoryResources.pipe(Schema.withConstructorDefault(Effect.succeed([]))),
}
export const admissionRejections = [
	AgentNotFound,
	AgentArchivedError,
	AgentVersionNotFound,
	EnvironmentNotFound,
	EnvironmentArchivedError,
	SessionAlreadyExists,
] as const

const admission = {
	input: admissionFields,
	events: [SessionCreated],
	rejects: admissionRejections,
	reply: {
		agent_version: PositiveInt,
	},
}
export class AdmitSession extends Domain.Command("AdmitSession", admission) {}

export class AdmitSessionWithMessages extends Domain.Command("AdmitSessionWithMessages", {
	...admission,
	input: { ...admission.input, initial_messages: InitialMessages },
}) {}
