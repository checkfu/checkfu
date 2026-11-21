import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import { PositiveInt } from "./SessionTypes.ts"

export class SessionCreated extends Domain.Event("session.created", {
	agent_id: Schema.String,
	agent_version: PositiveInt,
	environment_id: Schema.String,
	title: Schema.NullOr(Schema.String),
}) {}

export class SessionAlreadyExists extends Domain.Rejection(
	"SessionAlreadyExists",
	{ session_id: SessionId },
	{ httpApiStatus: 409, description: "A session with this id already exists." },
) {}

export class CreateSession extends Domain.Command("CreateSession", {
	target: SessionId,
	input: {
		agent_id: Schema.String,
		agent_version: PositiveInt,
		environment_id: Schema.String,
		title: Schema.NullOr(Schema.String),
	},
	events: [SessionCreated],
	rejects: [SessionAlreadyExists],
}) {}
