import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionStatusIdle } from "./CompleteTurn.command.ts"
import { AgentMessage } from "./RecordAgentMessage.command.ts"
import { AgentThinking } from "./RecordAgentThinking.command.ts"
import { SpanModelRequestEnd, UnknownModelRequest } from "./RecordModelRequestEnd.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import {
	MessageText,
	ModelUsage,
	NonEmptyString,
	PositiveInt,
	StopReason,
	ThinkingText,
} from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export class CommitModelReply extends Domain.Command("CommitModelReply", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		request_seq: PositiveInt,
		model_request_start_id: NonEmptyString,
		thinking: Schema.NullOr(ThinkingText),
		text: MessageText,
		truncated: Schema.optional(Schema.Literal(true)),
		model_usage: ModelUsage,
		stop_reason: StopReason,
	},
	events: [
		AgentThinking,
		AgentMessage,
		SpanModelRequestEnd,
		SessionStatusIdle,
		SessionStatusRunning,
	],
	rejects: [SessionNotFound, SessionNotRunning, StaleTurn, UnknownModelRequest],
}) {}
