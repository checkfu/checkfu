import * as Domain from "@alchemy.run/domain"
import { AutomationId } from "@checkfu/sdk/Schemas"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { AgentArchivedError } from "../Agent/AgentArchived.rejection.ts"
import { AgentNotFound } from "../Agent/AgentNotFound.rejection.ts"
import { EnvironmentArchivedError } from "../Environment/EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "../Environment/EnvironmentNotFound.rejection.ts"
import { McpServerCredentialsText } from "../Mcp/McpServers.ts"
import {
	AgentVersionNotFound,
	BoundedAgentId,
	BoundedEnvironmentId,
} from "../Session/AdmitSession.command.ts"
import { SessionAlreadyExists, SessionCreated } from "../Session/CreateSession.command.ts"
import { SessionStatusRunning, UserMessage } from "../Session/SendUserMessage.command.ts"
import { SessionId } from "../Session/Session.id.ts"
import { SessionResources } from "../Session/SessionResource.ts"
import { MessageText, PositiveInt, SessionTitle } from "../Session/SessionTypes.ts"

export class OpenAutomationSession extends Domain.Command("OpenAutomationSession", {
	input: {
		session_id: SessionId,
		automation_id: Schema.optionalKey(AutomationId),
		agent_id: BoundedAgentId,
		agent_version: Schema.NullOr(PositiveInt),
		environment_id: BoundedEnvironmentId,
		title: Schema.NullOr(SessionTitle),
		text: MessageText,
		mcp_server_credentials: Schema.optionalKey(McpServerCredentialsText),
		resources: SessionResources.pipe(Schema.withConstructorDefault(Effect.succeed([]))),
	},
	events: [SessionCreated, UserMessage, SessionStatusRunning],
	rejects: [
		AgentNotFound,
		AgentArchivedError,
		AgentVersionNotFound,
		EnvironmentNotFound,
		EnvironmentArchivedError,
		SessionAlreadyExists,
	],
}) {}
