import { AbandonTurn, TurnAbandoned } from "./AbandonTurn.command.ts"
import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import {
	ArchiveSession,
	SessionArchived,
	SessionStatusTerminated,
} from "./ArchiveSession.command.ts"
import { CommitModelReply } from "./CommitModelReply.command.ts"
import { CompleteTurn, SessionStatusIdle } from "./CompleteTurn.command.ts"
import { CreateSession, SessionAlreadyExists, SessionCreated } from "./CreateSession.command.ts"
import { FailModelRequest } from "./FailModelRequest.command.ts"
import { InterruptModelRequest } from "./InterruptModelRequest.command.ts"
import { OpenModelRequests } from "./OpenModelRequests.rejection.ts"
import { AgentMessage, RecordAgentMessage } from "./RecordAgentMessage.command.ts"
import { AgentThinking, RecordAgentThinking } from "./RecordAgentThinking.command.ts"
import {
	RecordModelRequestEnd,
	SpanModelRequestEnd,
	UnknownModelRequest,
} from "./RecordModelRequestEnd.command.ts"
import {
	DuplicateModelRequest,
	OutOfOrderModelRequest,
	RecordModelRequestStart,
	SpanModelRequestStart,
} from "./RecordModelRequestStart.command.ts"
import { RecordSessionError, SessionErrorEvent } from "./RecordSessionError.command.ts"
import { SendUserInterrupt, UserInterrupt } from "./SendUserInterrupt.command.ts"
import {
	PendingMessageQueueFull,
	SendUserMessage,
	SessionStatusRunning,
	UserMessage,
} from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import {
	NonEmptyString,
	NonNegativeInt,
	PositiveInt,
	type StopReason,
	type ModelUsage,
} from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"

export const SESSION_STATE_SCHEMA_VERSION = 1 as const

export const SessionState = Schema.Union([
	Schema.TaggedStruct("Uninitialized", {}),
	Schema.TaggedStruct("Idle", { turn: NonNegativeInt }),
	Schema.TaggedStruct("Running", {
		turn: PositiveInt,
		open_model_request_id: Schema.NullOr(NonEmptyString),
		model_requests_started: NonNegativeInt,
		pending_user_messages: NonNegativeInt,
	}),
	Schema.TaggedStruct("Terminated", {
		archived: Schema.Boolean,
	}),
])
export type SessionState = typeof SessionState.Type

export const SessionStateSnapshot = versionedSnapshot({
	current: SESSION_STATE_SCHEMA_VERSION,
	schema: SessionState,
})

type ActiveState = Extract<SessionState, { readonly _tag: "Idle" | "Running" }>
type RunningState = Extract<SessionState, { readonly _tag: "Running" }>

const shouldDrainQueue = (pending_user_messages: number, stop_reason: StopReason): boolean =>
	pending_user_messages > 0 &&
	(stop_reason.type === "end_turn" ||
		stop_reason.type === "retries_exhausted" ||
		stop_reason.type === "interrupted")

const abandonTurn = (
	running: RunningState,
	error_type: string,
	message: string,
	model_usage: ModelUsage,
) => {
	const errorEvent = new SessionErrorEvent({
		error: {
			type: error_type,
			message: message,
			retry_status: { type: "exhausted" },
		},
	})
	const stop_reason = { type: "retries_exhausted" as const }
	const idle = new SessionStatusIdle({ stop_reason })
	const settled = shouldDrainQueue(running.pending_user_messages, stop_reason)
		? [errorEvent, new TurnAbandoned(), idle, new SessionStatusRunning()]
		: [errorEvent, new TurnAbandoned(), idle]
	return running.open_model_request_id === null
		? settled
		: [
				new SpanModelRequestEnd({
					model_request_start_id: running.open_model_request_id,
					model_usage,
					is_error: true,
				}),
				...settled,
			]
}

const requireActive = (
	state: SessionState,
	session_id: SessionId,
): ActiveState | SessionNotFound | SessionTerminated => {
	if (state._tag === "Uninitialized") return new SessionNotFound({ session_id })
	if (state._tag === "Terminated") return new SessionTerminated({ session_id })
	return state
}

const requireRunningTurn = (
	state: SessionState,
	session_id: SessionId,
	turn: number,
): RunningState | SessionNotFound | SessionNotRunning | StaleTurn => {
	if (state._tag === "Uninitialized") return new SessionNotFound({ session_id })
	if (state._tag !== "Running") {
		return new SessionNotRunning({
			session_id,
			status: state._tag === "Idle" ? "idle" : "terminated",
		})
	}
	if (state.turn !== turn) {
		return new StaleTurn({ session_id, active_turn: state.turn, received_turn: turn })
	}
	return state
}

export class Session extends Domain.Aggregate("Session", {
	id: SessionId,
	state: SessionStateSnapshot,
	initial: { _tag: "Uninitialized" as const },
	commands: [
		CreateSession,
		SendUserMessage,
		SendUserInterrupt,
		RecordModelRequestStart,
		RecordAgentThinking,
		RecordAgentMessage,
		RecordModelRequestEnd,
		CompleteTurn,
		CommitModelReply,
		FailModelRequest,
		InterruptModelRequest,
		AbandonTurn,
		RecordSessionError,
		ArchiveSession,
	],
	keyOf: (cmd) => cmd.session_id,
	invariants: {
		RunningTurnIsPositive: (s) => s._tag !== "Running" || s.turn >= 1,
		IdleTurnIsNonNegative: (s) => s._tag !== "Idle" || s.turn >= 0,
		ModelRequestsStartedNonNegative: (s) => s._tag !== "Running" || s.model_requests_started >= 0,
		PendingUserMessagesWithinBounds: (s) =>
			s._tag !== "Running" || (s.pending_user_messages >= 0 && s.pending_user_messages <= 8),
		OpenModelRequestRequiresStartedCount: (s) =>
			s._tag !== "Running" || s.open_model_request_id === null || s.model_requests_started >= 1,
	},
	transitions: {
		TerminatedSessionStaysTerminated: ({ before, after }) =>
			before._tag !== "Terminated" || after._tag === "Terminated",
		ArchivedSessionStaysArchived: ({ before, after }) =>
			before._tag !== "Terminated" ||
			!before.archived ||
			(after._tag === "Terminated" && after.archived),
		CreatedSessionNeverReturnsToUninitialized: ({ before, after }) =>
			before._tag === "Uninitialized" || after._tag !== "Uninitialized",
		TurnNeverDecreases: ({ before, after }) =>
			(before._tag !== "Idle" && before._tag !== "Running") ||
			(after._tag !== "Idle" && after._tag !== "Running") ||
			after.turn >= before.turn,
		TurnAdvancesByAtMostOne: ({ before, after }) =>
			(before._tag !== "Idle" && before._tag !== "Running") ||
			(after._tag !== "Idle" && after._tag !== "Running") ||
			after.turn <= before.turn + 1,
		ModelRequestsStartedNeverDecreasesWithinTurn: ({ before, after }) =>
			before._tag !== "Running" ||
			after._tag !== "Running" ||
			after.turn !== before.turn ||
			after.model_requests_started >= before.model_requests_started,
	},
	decide: {
		CreateSession: (state, cmd, ctx) =>
			state._tag !== "Uninitialized"
				? new SessionAlreadyExists({ session_id: ctx.id })
				: [
						new SessionCreated({
							agent_id: cmd.agent_id,
							agent_version: cmd.agent_version,
							environment_id: cmd.environment_id,
							title: cmd.title,
						}),
					],

		SendUserMessage: (state, cmd, ctx) => {
			const active = requireActive(state, ctx.id)
			if (active._tag !== "Idle" && active._tag !== "Running") return active
			if (active._tag === "Running" && active.pending_user_messages >= 8) {
				return new PendingMessageQueueFull({ session_id: ctx.id, limit: 8 })
			}
			const message = new UserMessage({ content: [{ type: "text", text: cmd.text }] })
			return active._tag === "Running" ? [message] : [message, new SessionStatusRunning()]
		},

		SendUserInterrupt: (state, _cmd, ctx) => {
			const active = requireActive(state, ctx.id)
			if (active._tag !== "Idle" && active._tag !== "Running") return active
			if (active._tag !== "Running") {
				return new SessionNotRunning({ session_id: ctx.id, status: "idle" })
			}
			return [new UserInterrupt()]
		},

		RecordModelRequestStart: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") return running
			if (
				running.open_model_request_id !== null ||
				cmd.request_seq <= running.model_requests_started
			) {
				return new DuplicateModelRequest({
					session_id: ctx.id,
					model_request_start_id: cmd.model_request_start_id,
					open_model_request_id: running.open_model_request_id,
					model_requests_started: running.model_requests_started,
				})
			}
			if (cmd.request_seq !== running.model_requests_started + 1) {
				return new OutOfOrderModelRequest({
					session_id: ctx.id,
					expected_request_seq: running.model_requests_started + 1,
					received_request_seq: cmd.request_seq,
				})
			}
			return [new SpanModelRequestStart({ model_request_start_id: cmd.model_request_start_id })]
		},

		RecordAgentThinking: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			return running._tag === "Running" ? [new AgentThinking({ thinking: cmd.thinking })] : running
		},

		RecordAgentMessage: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			return running._tag === "Running"
				? [new AgentMessage({ content: [{ type: "text", text: cmd.text }] })]
				: running
		},

		RecordModelRequestEnd: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") return running
			if (
				running.open_model_request_id !== cmd.model_request_start_id ||
				running.model_requests_started !== cmd.request_seq
			) {
				return new UnknownModelRequest({
					session_id: ctx.id,
					model_request_start_id: cmd.model_request_start_id,
				})
			}
			return [
				new SpanModelRequestEnd({
					model_request_start_id: cmd.model_request_start_id,
					model_usage: cmd.model_usage,
					is_error: cmd.is_error,
				}),
			]
		},

		CompleteTurn: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") return running
			if (running.open_model_request_id !== null) {
				return new OpenModelRequests({
					session_id: ctx.id,
					open_model_request_id: running.open_model_request_id,
				})
			}
			const idle = new SessionStatusIdle({ stop_reason: cmd.stop_reason })
			if (shouldDrainQueue(running.pending_user_messages, cmd.stop_reason)) {
				return [idle, new SessionStatusRunning()]
			}
			return [idle]
		},

		CommitModelReply: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") return running
			if (
				running.open_model_request_id !== cmd.model_request_start_id ||
				running.model_requests_started !== cmd.request_seq
			) {
				return new UnknownModelRequest({
					session_id: ctx.id,
					model_request_start_id: cmd.model_request_start_id,
				})
			}
			const msg = new AgentMessage({
				content: [{ type: "text", text: cmd.text }],
				...(cmd.truncated === true ? { truncated: true as const } : {}),
			})
			const end = new SpanModelRequestEnd({
				model_request_start_id: cmd.model_request_start_id,
				model_usage: cmd.model_usage,
				is_error: false,
			})
			const idle = new SessionStatusIdle({ stop_reason: cmd.stop_reason })
			const drain = shouldDrainQueue(running.pending_user_messages, cmd.stop_reason)
			if (cmd.thinking !== null) {
				const thought = new AgentThinking({ thinking: cmd.thinking })
				return drain
					? [thought, msg, end, idle, new SessionStatusRunning()]
					: [thought, msg, end, idle]
			}
			return drain ? [msg, end, idle, new SessionStatusRunning()] : [msg, end, idle]
		},

		FailModelRequest: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") return running
			if (
				running.open_model_request_id !== cmd.model_request_start_id ||
				running.model_requests_started !== cmd.request_seq
			) {
				return new UnknownModelRequest({
					session_id: ctx.id,
					model_request_start_id: cmd.model_request_start_id,
				})
			}
			if (cmd.disposition === "abandoned")
				return abandonTurn(running, cmd.error_type, cmd.message, cmd.model_usage)
			const end = new SpanModelRequestEnd({
				model_request_start_id: cmd.model_request_start_id,
				model_usage: cmd.model_usage,
				is_error: true,
			})
			const errorEvent = new SessionErrorEvent({
				error: {
					type: cmd.error_type,
					message: cmd.message,
					retry_status: { type: cmd.disposition },
				},
			})
			if (cmd.disposition === "terminal") {
				return [end, errorEvent, new SessionStatusTerminated()]
			}
			const stop_reason = { type: "retries_exhausted" as const }
			const idle = new SessionStatusIdle({ stop_reason })
			return shouldDrainQueue(running.pending_user_messages, stop_reason)
				? [end, errorEvent, idle, new SessionStatusRunning()]
				: [end, errorEvent, idle]
		},

		InterruptModelRequest: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") return running
			if (
				running.open_model_request_id !== cmd.model_request_start_id ||
				running.model_requests_started !== cmd.request_seq
			) {
				return new UnknownModelRequest({
					session_id: ctx.id,
					model_request_start_id: cmd.model_request_start_id,
				})
			}
			const end = new SpanModelRequestEnd({
				model_request_start_id: cmd.model_request_start_id,
				model_usage: cmd.model_usage,
				is_error: true,
			})
			const stop_reason = { type: "interrupted" as const }
			const idle = new SessionStatusIdle({ stop_reason })
			return shouldDrainQueue(running.pending_user_messages, stop_reason)
				? [end, idle, new SessionStatusRunning()]
				: [end, idle]
		},

		AbandonTurn: (state, cmd) => {
			if (state._tag !== "Running" || state.turn !== cmd.turn) return []
			return abandonTurn(state, cmd.error_type, cmd.message, { input_tokens: 0, output_tokens: 0 })
		},

		RecordSessionError: (state, cmd, ctx) => {
			const active = requireActive(state, ctx.id)
			if (active._tag !== "Idle" && active._tag !== "Running") return active
			const errorEvent = new SessionErrorEvent({ error: cmd.error })
			if (cmd.turn !== null) {
				if (active._tag !== "Running") {
					return new SessionNotRunning({ session_id: ctx.id, status: "idle" })
				}
				if (active.turn !== cmd.turn) {
					return new StaleTurn({
						session_id: ctx.id,
						active_turn: active.turn,
						received_turn: cmd.turn,
					})
				}
				if (cmd.error.retry_status.type === "terminal") {
					return [errorEvent, new SessionStatusTerminated()]
				}
				if (cmd.error.retry_status.type === "exhausted") {
					if (active.open_model_request_id !== null) {
						return new OpenModelRequests({
							session_id: ctx.id,
							open_model_request_id: active.open_model_request_id,
						})
					}
					const stop_reason = { type: "retries_exhausted" as const }
					const idle = new SessionStatusIdle({ stop_reason })
					if (shouldDrainQueue(active.pending_user_messages, stop_reason)) {
						return [errorEvent, idle, new SessionStatusRunning()]
					}
					return [errorEvent, idle]
				}
				return [errorEvent]
			}
			return cmd.error.retry_status.type === "terminal"
				? [errorEvent, new SessionStatusTerminated()]
				: [errorEvent]
		},

		ArchiveSession: (state, _cmd, ctx) => {
			if (state._tag === "Uninitialized") return new SessionNotFound({ session_id: ctx.id })
			if (state._tag === "Terminated") {
				return state.archived ? [] : [new SessionArchived()]
			}
			if (state._tag === "Running" && state.open_model_request_id !== null) {
				return [
					new SpanModelRequestEnd({
						model_request_start_id: state.open_model_request_id,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionStatusTerminated(),
					new SessionArchived(),
				]
			}
			return [new SessionStatusTerminated(), new SessionArchived()]
		},
	},
	evolve: {
		"session.created": () => ({ _tag: "Idle" as const, turn: 0 }),
		"user.message": (state) =>
			state._tag === "Running"
				? {
						...state,
						pending_user_messages:
							state.pending_user_messages < 8 ? state.pending_user_messages + 1 : 8,
					}
				: state,
		"user.interrupt": (state) => state,
		"session.status_running": (state) =>
			state._tag === "Idle"
				? {
						_tag: "Running" as const,
						turn: state.turn + 1,
						open_model_request_id: null,
						model_requests_started: 0,
						pending_user_messages: 0,
					}
				: state,
		"span.model_request_start": (state, e) =>
			state._tag === "Running"
				? {
						...state,
						open_model_request_id: e.model_request_start_id,
						model_requests_started: state.model_requests_started + 1,
					}
				: state,
		"agent.thinking": (state) => state,
		"agent.message": (state) => state,
		"span.model_request_end": (state, e) =>
			state._tag === "Running" && state.open_model_request_id === e.model_request_start_id
				? {
						...state,
						open_model_request_id: null,
					}
				: state,
		"session.status_idle": (state) =>
			state._tag === "Running" ? { _tag: "Idle" as const, turn: state.turn } : state,
		"session.error": (state) => state,
		"turn.abandoned": (state) => state,
		"session.status_terminated": (state) =>
			state._tag === "Terminated" ? state : { _tag: "Terminated" as const, archived: false },
		"session.archived": (state) =>
			state._tag === "Terminated" ? { _tag: "Terminated" as const, archived: true } : state,
	},
	reply: {
		SendUserMessage: (state) => ({
			turn:
				state._tag !== "Running"
					? 1
					: state.pending_user_messages > 0
						? state.turn + 1
						: state.turn,
		}),
	},
}) {}
