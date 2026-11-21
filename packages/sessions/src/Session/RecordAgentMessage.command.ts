import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { PositiveInt, TextBlocks } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class AgentMessage extends Domain.Event("agent.message", {
	content: TextBlocks,
}) {}

export class RecordAgentMessage extends Domain.Command("RecordAgentMessage", {
	target: SessionId,
	input: {
		turn: PositiveInt,
		content: TextBlocks,
	},
	events: [AgentMessage],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn],
}) {}
