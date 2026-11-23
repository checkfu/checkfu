import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
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
	TextBlocks,
	ThinkingText,
} from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"

export class AgentThinking extends Domain.Event("agent.thinking", {
	thinking: Schema.String,
}) {}

export class AgentMessage extends Domain.Event("agent.message", {
	content: TextBlocks,
	truncated: Schema.optionalKey(Schema.Literal(true)),
}) {}

export class SpanModelRequestEnd extends Domain.Event("span.model_request_end", {
	model_request_start_id: NonEmptyString,
	model_usage: ModelUsage,
	is_error: Schema.NullOr(Schema.Boolean),
}) {}

export class SessionStatusIdle extends Domain.Event("session.status_idle", {
	stop_reason: StopReason,
}) {}

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
