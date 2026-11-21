import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { PositiveInt } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class AgentThinking extends Domain.Event("agent.thinking", {
	thinking: Schema.String,
}) {}

export class RecordAgentThinking extends Domain.Command("RecordAgentThinking", {
	target: SessionId,
	input: {
		turn: PositiveInt,
		thinking: Schema.String,
	},
	events: [AgentThinking],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn],
}) {}
