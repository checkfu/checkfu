import { AbandonTurn, SessionErrorEvent, TurnAbandoned } from "./AbandonTurn.command.ts"
import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import {
	ArchiveSession,
	SessionArchived,
	SessionStatusTerminated,
} from "./ArchiveSession.command.ts"
import {
	AgentMessage,
	AgentThinking,
	CommitModelReply,
	SessionStatusIdle,
	SpanModelRequestEnd,
} from "./CommitModelReply.command.ts"
import { UserToolConfirmation } from "./ConfirmTool.command.ts"
import { UserCustomToolResult } from "./ReturnCustomToolResult.command.ts"
import { CreateSession, SessionAlreadyExists, SessionCreated } from "./CreateSession.command.ts"
import { FailModelRequest } from "./FailModelRequest.command.ts"
import { InterruptModelRequest } from "./InterruptModelRequest.command.ts"
import { PauseTurn, UserMessagesQueued } from "./PauseTurn.command.ts"
import {
	DuplicateModelRequest,
	OutOfOrderModelRequest,
	RecordModelRequestStart,
	SpanModelRequestStart,
} from "./RecordModelRequestStart.command.ts"
import {
	AgentApiToolResult,
	AgentApiToolUse,
	AgentCustomToolUse,
	AgentMcpToolResult,
	AgentMcpToolUse,
	AgentToolResult,
	AgentToolUse,
	RecordToolCall,
} from "./RecordToolCall.command.ts"
import { ResumeTurn } from "./ResumeTurn.command.ts"
import { SendUserInterrupt, UserInterrupt } from "./SendUserInterrupt.command.ts"
import {
	PendingMessageQueueFull,
	SendUserMessage,
	SessionAwaitingAction,
	SessionStatusRunning,
	UserMessage,
} from "./SendUserMessage.command.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { NonEmptyString, NonNegativeInt, PositiveInt } from "./SessionTypes.ts"
import type { StopReason, ModelUsage } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"
import { snapshotVersion, versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"

export const SESSION_STATE_SCHEMA_VERSION = 2 as const

const Uninitialized = Schema.TaggedStruct("Uninitialized", {})
const Running = Schema.TaggedStruct("Running", {
	turn: PositiveInt,
	open_model_request_id: Schema.NullOr(NonEmptyString),
	model_requests_started: NonNegativeInt,
	pending_user_messages: NonNegativeInt,
})
const Terminated = Schema.TaggedStruct("Terminated", {
	archived: Schema.Boolean,
})

export const SessionState = Schema.Union([
	Uninitialized,
	Schema.TaggedStruct("Idle", {
		turn: NonNegativeInt,
		// Its last turn paused on tool calls a person has yet to answer.
		awaiting: Schema.Boolean,
	}),
	Running,
	Terminated,
])
export type SessionState = typeof SessionState.Type

const SessionStateV1 = Schema.Union([
	Uninitialized,
	Schema.TaggedStruct("Idle", { turn: NonNegativeInt }),
	Running,
	Terminated,
])

export const SessionStateSnapshot = versionedSnapshot({
	current: SESSION_STATE_SCHEMA_VERSION,
	schema: SessionState,
	previous: [
		snapshotVersion({
			version: 1,
			schema: SessionStateV1,
			migrate: (state) => (state._tag === "Idle" ? { ...state, awaiting: false } : state),
		}),
	],
})

type ActiveState = Extract<SessionState, { readonly _tag: "Idle" | "Running" }>
type RunningState = Extract<SessionState, { readonly _tag: "Running" }>

const shouldDrainQueue = (pending_user_messages: number, stop_reason: StopReason): boolean =>
	pending_user_messages > 0 &&
	(stop_reason.type === "end_turn" ||
		stop_reason.type === "retries_exhausted" ||
		stop_reason.type === "interrupted")

const endTurn = (running: RunningState, stop_reason: StopReason) => {
	const idle = new SessionStatusIdle({ stop_reason, turn: running.turn })
	return shouldDrainQueue(running.pending_user_messages, stop_reason)
		? [idle, new SessionStatusRunning({ turn: running.turn + 1 })]
		: [idle]
}

const abandonTurn = (
	running: RunningState,
	error_type: string,
	message: string,
	model_usage: ModelUsage,
) => {
	const settled = [
		new SessionErrorEvent({
			error: {
				type: error_type,
				message,
				retry_status: { type: "exhausted" },
			},
		}),
		new TurnAbandoned({ turn: running.turn }),
		...endTurn(running, { type: "retries_exhausted" }),
	]
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
	if (state._tag === "Uninitialized") {
		return new SessionNotFound({ session_id })
	}
	if (state._tag === "Terminated") {
		return new SessionTerminated({ session_id })
	}
	return state
}

const requireRunningTurn = (
	state: SessionState,
	session_id: SessionId,
	turn: number,
): RunningState | SessionNotFound | SessionNotRunning | StaleTurn => {
	if (state._tag === "Uninitialized") {
		return new SessionNotFound({ session_id })
	}
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
		RecordToolCall,
		PauseTurn,
		ResumeTurn,
		CommitModelReply,
		FailModelRequest,
		InterruptModelRequest,
		AbandonTurn,
		ArchiveSession,
	],
	events: [UserToolConfirmation, UserCustomToolResult],
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
		ModelRequestsStartedGrowsByAtMostOneWithinTurn: ({ before, after }) =>
			before._tag !== "Running" ||
			after._tag !== "Running" ||
			after.turn !== before.turn ||
			after.model_requests_started <= before.model_requests_started + 1,
		PendingUserMessagesGrowsByAtMostOneWithinTurn: ({ before, after }) =>
			before._tag !== "Running" ||
			after._tag !== "Running" ||
			after.turn !== before.turn ||
			after.pending_user_messages <= before.pending_user_messages + 1,
		OnlySendUserMessageAddsPendingMessages: ({ before, after, command }) =>
			before._tag !== "Running" ||
			after._tag !== "Running" ||
			after.turn !== before.turn ||
			after.pending_user_messages <= before.pending_user_messages ||
			command._tag === "SendUserMessage",
		OnlyArchiveSessionSetsArchivedFlag: ({ before, after, command }) =>
			after._tag !== "Terminated" ||
			!after.archived ||
			(before._tag === "Terminated" && before.archived) ||
			command._tag === "ArchiveSession",
		IdleSessionStartsTheNextTurn: ({ before, after }) =>
			before._tag !== "Idle" || after._tag !== "Running" || after.turn === before.turn + 1,
		StatusRunningCarriesStartedTurn: ({ after, events }) =>
			events.every(
				(event) =>
					event._tag !== "session.status_running" ||
					(after._tag === "Running" && event.turn === after.turn),
			),
		StatusIdleCarriesEndedTurn: ({ before, after, events }) =>
			events.every(
				(event) =>
					event._tag !== "session.status_idle" ||
					(before._tag === "Running" &&
						event.turn === before.turn &&
						(after._tag === "Idle" || after._tag === "Running")),
			),
		AbandonedTurnEnds: ({ before, after, events }) =>
			events.every(
				(event) =>
					event._tag !== "turn.abandoned" ||
					(before._tag === "Running" &&
						event.turn === before.turn &&
						(after._tag === "Idle" ||
							(after._tag === "Running" && after.turn === before.turn + 1))),
			),
		AgentMessageEndsTheTurn: ({ before, after, events }) =>
			events.every(
				(event) =>
					event._tag !== "agent.message" ||
					(before._tag === "Running" &&
						(after._tag === "Idle" ||
							(after._tag === "Running" && after.turn === before.turn + 1))),
			),
		OpenModelRequestClosedBeforeLeavingRunning: ({ before, after, events }) => {
			if (
				before._tag !== "Running" ||
				before.open_model_request_id === null ||
				(after._tag === "Running" && after.turn === before.turn)
			) {
				return true
			}
			const endIndex = events.findIndex(
				(event) =>
					event._tag === "span.model_request_end" &&
					event.model_request_start_id === before.open_model_request_id,
			)
			const leaveIndex = events.findIndex(
				(event) =>
					event._tag === "session.status_idle" || event._tag === "session.status_terminated",
			)
			return endIndex >= 0 && (leaveIndex < 0 || endIndex < leaveIndex)
		},
		OnlyAPauseLeavesTheSessionAwaiting: ({ before, after, events }) =>
			after._tag !== "Idle" ||
			!after.awaiting ||
			(before._tag === "Idle" && before.awaiting) ||
			events.some(
				(event) =>
					event._tag === "session.status_idle" && event.stop_reason.type === "requires_action",
			),
		AnAwaitingSessionTakesNoUserMessage: ({ before, events }) =>
			before._tag !== "Idle" ||
			!before.awaiting ||
			events.every((event) => event._tag !== "user.message"),
		APauseKeepsNoQueuedMessage: ({ before, events }) =>
			before._tag !== "Running" ||
			before.pending_user_messages === 0 ||
			events.every(
				(event) =>
					event._tag !== "session.status_idle" || event.stop_reason.type !== "requires_action",
			),
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
			if (active._tag !== "Idle" && active._tag !== "Running") {
				return active
			}
			if (active._tag === "Running" && active.pending_user_messages >= 8) {
				return new PendingMessageQueueFull({ session_id: ctx.id, limit: 8 })
			}
			if (active._tag === "Idle" && active.awaiting) {
				return new SessionAwaitingAction({ session_id: ctx.id })
			}
			const message = new UserMessage({ content: [{ type: "text", text: cmd.text }] })
			return active._tag === "Running"
				? [message]
				: [message, new SessionStatusRunning({ turn: active.turn + 1 })]
		},

		SendUserInterrupt: (state, _cmd, ctx) => {
			const active = requireActive(state, ctx.id)
			if (active._tag !== "Idle" && active._tag !== "Running") {
				return active
			}
			// Interrupting a paused session gives up the tool calls it waits on.
			if (active._tag !== "Running" && !active.awaiting) {
				return new SessionNotRunning({ session_id: ctx.id, status: "idle" })
			}
			return [new UserInterrupt()]
		},

		RecordModelRequestStart: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") {
				return running
			}
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

		RecordToolCall: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") {
				return running
			}
			if (running.open_model_request_id !== cmd.model_request_start_id) {
				return new UnknownModelRequest({
					session_id: ctx.id,
					model_request_start_id: cmd.model_request_start_id,
				})
			}
			const { call } = cmd
			if (call._tag === "result") {
				const { result } = call
				const recorded = {
					tool_use_id: result.tool_use_id,
					content: result.content,
					is_error: result.is_error,
					...(result.truncated === true ? { truncated: true as const } : {}),
				}
				return [
					result.type === "tool_result"
						? new AgentToolResult(recorded)
						: result.type === "mcp_tool_result"
							? new AgentMcpToolResult(recorded)
							: new AgentApiToolResult(recorded),
				]
			}
			const { use } = call
			const useTruncated = use.truncated === true ? { truncated: true as const } : {}
			const used =
				use.type === "tool_use"
					? new AgentToolUse({
							tool_use_id: use.tool_use_id,
							name: use.name,
							input: use.input,
							...useTruncated,
						})
					: use.type === "custom_tool_use"
						? new AgentCustomToolUse({
								tool_use_id: use.tool_use_id,
								name: use.name,
								input: use.input,
								...useTruncated,
							})
						: use.type === "mcp_tool_use"
							? new AgentMcpToolUse({
									tool_use_id: use.tool_use_id,
									mcp_server_name: use.mcp_server_name,
									name: use.name,
									input: use.input,
									...(use.evaluated_permission === undefined
										? {}
										: { evaluated_permission: use.evaluated_permission }),
									...(use.parent_tool_use_id === undefined
										? {}
										: { parent_tool_use_id: use.parent_tool_use_id }),
									...useTruncated,
								})
							: new AgentApiToolUse({
									tool_use_id: use.tool_use_id,
									api_server_name: use.api_server_name,
									name: use.name,
									input: use.input,
									...(use.evaluated_permission === undefined
										? {}
										: { evaluated_permission: use.evaluated_permission }),
									...(use.parent_tool_use_id === undefined
										? {}
										: { parent_tool_use_id: use.parent_tool_use_id }),
									...useTruncated,
								})
			if (call._tag === "use") {
				return [used]
			}
			const { result } = call
			const recorded = {
				tool_use_id: result.tool_use_id,
				content: result.content,
				is_error: result.is_error,
				...(result.truncated === true ? { truncated: true as const } : {}),
			}
			return [
				used,
				result.type === "tool_result"
					? new AgentToolResult(recorded)
					: result.type === "mcp_tool_result"
						? new AgentMcpToolResult(recorded)
						: new AgentApiToolResult(recorded),
			]
		},

		PauseTurn: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") {
				return running
			}
			if (
				running.open_model_request_id !== cmd.model_request_start_id ||
				running.model_requests_started !== cmd.request_seq
			) {
				return new UnknownModelRequest({
					session_id: ctx.id,
					model_request_start_id: cmd.model_request_start_id,
				})
			}
			// A queued message would wait behind an answer nobody may give; it runs first.
			if (running.pending_user_messages > 0) {
				return new UserMessagesQueued({ session_id: ctx.id })
			}
			return [
				new SpanModelRequestEnd({
					model_request_start_id: cmd.model_request_start_id,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: false,
				}),
				new SessionStatusIdle({
					stop_reason: { type: "requires_action" },
					event_ids: cmd.event_ids,
					turn: running.turn,
				}),
			]
		},

		ResumeTurn: (state, cmd) =>
			state._tag === "Idle" && state.awaiting && state.turn === cmd.turn
				? [new SessionStatusRunning({ turn: state.turn + 1 })]
				: [],

		CommitModelReply: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") {
				return running
			}
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
			const settled = endTurn(running, cmd.stop_reason)
			if (cmd.thinking !== null) {
				return [new AgentThinking({ thinking: cmd.thinking }), msg, end, ...settled]
			}
			return [msg, end, ...settled]
		},

		FailModelRequest: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") {
				return running
			}
			if (
				running.open_model_request_id !== cmd.model_request_start_id ||
				running.model_requests_started !== cmd.request_seq
			) {
				return new UnknownModelRequest({
					session_id: ctx.id,
					model_request_start_id: cmd.model_request_start_id,
				})
			}
			if (cmd.disposition === "abandoned") {
				return abandonTurn(running, cmd.error_type, cmd.message, cmd.model_usage)
			}
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
			return [end, errorEvent, ...endTurn(running, { type: "retries_exhausted" })]
		},

		InterruptModelRequest: (state, cmd, ctx) => {
			const running = requireRunningTurn(state, ctx.id, cmd.turn)
			if (running._tag !== "Running") {
				return running
			}
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
			return [end, ...endTurn(running, { type: "interrupted" })]
		},

		AbandonTurn: (state, cmd) => {
			if (state._tag !== "Running" || state.turn !== cmd.turn) {
				return []
			}
			return abandonTurn(state, cmd.error_type, cmd.message, { input_tokens: 0, output_tokens: 0 })
		},

		ArchiveSession: (state, _cmd, ctx) => {
			if (state._tag === "Uninitialized") {
				return new SessionNotFound({ session_id: ctx.id })
			}
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
		"session.created": () => ({ _tag: "Idle" as const, turn: 0, awaiting: false }),
		"user.message": (state) =>
			state._tag === "Running"
				? {
						...state,
						pending_user_messages:
							state.pending_user_messages < 8 ? state.pending_user_messages + 1 : 8,
					}
				: state,
		"user.interrupt": (state) =>
			state._tag === "Idle" && state.awaiting ? { ...state, awaiting: false } : state,
		"user.tool_confirmation": (state) => state,
		"user.custom_tool_result": (state) => state,
		"session.status_running": (state, e) =>
			state._tag === "Idle"
				? {
						_tag: "Running" as const,
						turn: e.turn,
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
		"agent.tool_use": (state) => state,
		"agent.tool_result": (state) => state,
		"agent.mcp_tool_use": (state) => state,
		"agent.mcp_tool_result": (state) => state,
		"agent.custom_tool_use": (state) => state,
		"agent.api_tool_use": (state) => state,
		"agent.api_tool_result": (state) => state,
		"agent.thinking": (state) => state,
		"agent.message": (state) => state,
		"span.model_request_end": (state, e) =>
			state._tag === "Running" && state.open_model_request_id === e.model_request_start_id
				? {
						...state,
						open_model_request_id: null,
					}
				: state,
		"session.status_idle": (state, e) =>
			state._tag === "Running"
				? {
						_tag: "Idle" as const,
						turn: e.turn,
						awaiting: e.stop_reason.type === "requires_action",
					}
				: state,
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
