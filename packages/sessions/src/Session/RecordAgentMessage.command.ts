import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { NonEmptyString, PositiveInt, TextBlocks } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class AgentMessage extends Domain.Event("agent.message", {
	content: TextBlocks,
}) {}

export class RecordAgentMessage extends Domain.Command("RecordAgentMessage", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		text: NonEmptyString,
	},
	events: [AgentMessage],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn],
}) {}
