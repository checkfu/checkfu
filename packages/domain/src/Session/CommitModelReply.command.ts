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
	NonNegativeInt,
	PositiveInt,
	SessionEventFields,
	StopReason,
	ThinkingText,
	ToolUseIdsText,
} from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"

const PreviewOrigin = Schema.Struct({ turn: PositiveInt, started_at: NonNegativeInt })

export class AgentThinking extends Domain.Event("agent.thinking", {
	thinking: Schema.String,
	preview_origin: Schema.optionalKey(PreviewOrigin),
}) {}

export class AgentMessage extends Domain.Event("agent.message", {
	...SessionEventFields["agent.message"],
	preview_origin: Schema.optionalKey(PreviewOrigin),
}) {}

export class SpanModelRequestEnd extends Domain.Event(
	"span.model_request_end",
	SessionEventFields["span.model_request_end"],
) {}

export class SessionStatusIdle extends Domain.Event("session.status_idle", {
	...SessionEventFields["session.status_idle"],
	event_ids: ToolUseIdsText,
}) {}

export class CommitModelReply extends Domain.Command("CommitModelReply", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		request_seq: PositiveInt,
		model_request_start_id: NonEmptyString,
		thinking: Schema.NullOr(ThinkingText),
		response_started_at: Schema.optionalKey(NonNegativeInt),
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
