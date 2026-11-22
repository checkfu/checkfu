import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { MessageText, PositiveInt, TextBlocks } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class AgentMessage extends Domain.Event("agent.message", {
	content: TextBlocks,
	truncated: Schema.optionalKey(Schema.Literal(true)),
}) {}

export class RecordAgentMessage extends Domain.Command("RecordAgentMessage", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		text: MessageText,
	},
	events: [AgentMessage],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn],
}) {}
