import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { McpServerCredentialsText } from "../Mcp/McpServers.ts"
import { SessionId } from "./Session.id.ts"
import { PositiveInt, ResourceId, SessionTitle } from "./SessionTypes.ts"

export class SessionCreated extends Domain.Event("session.created", {
	agent_id: ResourceId,
	agent_version: PositiveInt,
	environment_id: ResourceId,
	title: Schema.NullOr(Schema.String),
	mcp_server_credentials: Schema.optionalKey(McpServerCredentialsText),
}) {}

export class SessionAlreadyExists extends Domain.Rejection(
	"SessionAlreadyExists",
	{ session_id: SessionId },
	{ httpApiStatus: 409, description: "A session with this id already exists." },
) {}

export class CreateSession extends Domain.Command("CreateSession", {
	input: {
		session_id: SessionId,
		agent_id: ResourceId,
		agent_version: PositiveInt,
		environment_id: ResourceId,
		title: Schema.NullOr(SessionTitle),
	},
	events: [SessionCreated],
	rejects: [SessionAlreadyExists],
}) {}
