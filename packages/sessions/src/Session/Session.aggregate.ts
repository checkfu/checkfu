import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { ArchiveSession, SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { CompleteTurn, SessionStatusIdle } from "./CompleteTurn.command.ts"
import { CreateSession, SessionAlreadyExists, SessionCreated } from "./CreateSession.command.ts"
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
import { SendUserMessage, SessionStatusRunning, UserMessage } from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { NonEmptyString, NonNegativeInt, PositiveInt } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"

export const SessionState = Schema.Union([
	Schema.Struct({ _tag: Schema.Literal("Uninitialized") }),
	Schema.Struct({ _tag: Schema.Literal("Idle"), turn: NonNegativeInt }),
	Schema.Struct({
		_tag: Schema.Literal("Running"),
		turn: PositiveInt,
		interrupt_requested: Schema.Boolean,
		open_model_request_id: Schema.NullOr(NonEmptyString),
		model_requests_started: NonNegativeInt,
	}),
	Schema.Struct({ _tag: Schema.Literal("Terminated") }),
])
export type SessionState = typeof SessionState.Type

type ActiveState = Extract<SessionState, { readonly _tag: "Idle" | "Running" }>
type RunningState = Extract<SessionState, { readonly _tag: "Running" }>

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
	state: SessionState,
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
		RecordSessionError,
		ArchiveSession,
	],
	keyOf: (cmd) => cmd.session_id,
	invariants: {
		RunningTurnIsPositive: (s) => s._tag !== "Running" || s.turn >= 1,
		IdleTurnIsNonNegative: (s) => s._tag !== "Idle" || s.turn >= 0,
		ModelRequestsStartedNonNegative: (s) => s._tag !== "Running" || s.model_requests_started >= 0,
		OpenModelRequestRequiresStartedCount: (s) =>
			s._tag !== "Running" || s.open_model_request_id === null || s.model_requests_started >= 1,
	},
	transitions: {
		TerminatedSessionStaysTerminated: ({ before, after }) =>
			before._tag !== "Terminated" || after._tag === "Terminated",
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
		InterruptFlagStaysSetDuringSameTurn: ({ before, after }) =>
			before._tag !== "Running" ||
			!before.interrupt_requested ||
			after._tag !== "Running" ||
			after.turn !== before.turn ||
			after.interrupt_requested,
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
			const message = new UserMessage({ content: [{ type: "text", text: cmd.text }] })
			return active._tag === "Running" ? [message] : [message, new SessionStatusRunning()]
		},

		SendUserInterrupt: (state, _cmd, ctx) => {
			const active = requireActive(state, ctx.id)
			if (active._tag !== "Idle" && active._tag !== "Running") return active
			if (active._tag !== "Running")
				return new SessionNotRunning({ session_id: ctx.id, status: "idle" })
			return active.interrupt_requested ? [] : [new UserInterrupt()]
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
			return [new SessionStatusIdle({ stop_reason: cmd.stop_reason })]
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
					return [errorEvent, new SessionStatusIdle({ stop_reason: { type: "retries_exhausted" } })]
				}
				return [errorEvent]
			}
			return cmd.error.retry_status.type === "terminal"
				? [errorEvent, new SessionStatusTerminated()]
				: [errorEvent]
		},

		ArchiveSession: (state, _cmd, ctx) => {
			if (state._tag === "Uninitialized") return new SessionNotFound({ session_id: ctx.id })
			if (state._tag === "Terminated") return []
			return [new SessionStatusTerminated()]
		},
	},
	evolve: {
		"session.created": () => ({ _tag: "Idle" as const, turn: 0 }),
		"user.message": (state) => state,
		"user.interrupt": (state) =>
			state._tag === "Running" ? { ...state, interrupt_requested: true } : state,
		"session.status_running": (state) =>
			state._tag === "Idle"
				? {
						_tag: "Running" as const,
						turn: state.turn + 1,
						interrupt_requested: false,
						open_model_request_id: null,
						model_requests_started: 0,
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
		"session.status_terminated": () => ({ _tag: "Terminated" as const }),
	},
	reply: {
		SendUserMessage: (state) => ({ turn: state._tag === "Running" ? state.turn : 1 }),
	},
}) {}
