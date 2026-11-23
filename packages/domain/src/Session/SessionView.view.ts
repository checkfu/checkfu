import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionArchived, SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { SessionStatusIdle } from "./CompleteTurn.command.ts"
import { AgentMessage } from "./RecordAgentMessage.command.ts"
import { AgentThinking } from "./RecordAgentThinking.command.ts"
import { SpanModelRequestEnd } from "./RecordModelRequestEnd.command.ts"
import { SpanModelRequestStart } from "./RecordModelRequestStart.command.ts"
import { SessionErrorEvent } from "./RecordSessionError.command.ts"
import { UserInterrupt } from "./SendUserInterrupt.command.ts"
import { SessionStatusRunning, UserMessage } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionId } from "./Session.id.ts"
import { NonNegativeInt, PositiveInt } from "./SessionTypes.ts"

export const SessionSnapshot = Schema.Struct({
	id: SessionId,
	type: Schema.Literal("session"),
	status: Schema.Literals(["idle", "running", "terminated"]),
	agent_id: Schema.String,
	agent_version: PositiveInt,
	environment_id: Schema.String,
	title: Schema.NullOr(Schema.String),
	turn: NonNegativeInt,
	usage: Schema.Struct({
		input_tokens: NonNegativeInt,
		output_tokens: NonNegativeInt,
	}),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type SessionSnapshot = typeof SessionSnapshot.Type

export class SessionView extends Domain.View("SessionView", {
	version: 1,
	from: [Session],
	key: Session,
	state: Schema.NullOr(SessionSnapshot),
	initial: null,
	events: [
		UserMessage,
		UserInterrupt,
		SessionStatusRunning,
		SpanModelRequestStart,
		AgentThinking,
		AgentMessage,
		SpanModelRequestEnd,
		SessionStatusIdle,
		SessionErrorEvent,
		SessionStatusTerminated,
		SessionArchived,
	],
	evolve: {
		"session.created": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.key.id,
						type: "session" as const,
						status: "idle" as const,
						agent_id: e.agent_id,
						agent_version: e.agent_version,
						environment_id: e.environment_id,
						title: e.title,
						turn: 0,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
						},
						created_at: ctx.at,
						updated_at: ctx.at,
						archived_at: null,
					},
		"user.message": (state, _e, ctx) => (state === null ? null : { ...state, updated_at: ctx.at }),
		"user.interrupt": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"session.status_running": (state, _e, ctx) =>
			state === null
				? null
				: {
						...state,
						status: "running" as const,
						turn: state.turn + 1,
						updated_at: ctx.at,
					},
		"span.model_request_start": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"agent.thinking": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"agent.message": (state, _e, ctx) => (state === null ? null : { ...state, updated_at: ctx.at }),
		"span.model_request_end": (state, e, ctx) =>
			state === null
				? null
				: {
						...state,
						usage: {
							input_tokens: state.usage.input_tokens + e.model_usage.input_tokens,
							output_tokens: state.usage.output_tokens + e.model_usage.output_tokens,
						},
						updated_at: ctx.at,
					},
		"session.status_idle": (state, _e, ctx) =>
			state === null
				? null
				: {
						...state,
						status: "idle" as const,
						updated_at: ctx.at,
					},
		"session.error": (state, _e, ctx) => (state === null ? null : { ...state, updated_at: ctx.at }),
		"session.archived": (state, _e, ctx) =>
			state === null
				? null
				: {
						...state,
						archived_at: state.archived_at ?? ctx.at,
						updated_at: ctx.at,
					},
		"session.status_terminated": (state, _e, ctx) =>
			state === null
				? null
				: {
						...state,
						status: "terminated" as const,
						updated_at: ctx.at,
					},
	},
}) {}
