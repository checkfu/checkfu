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
import { ClaimIdempotencyKey, IdempotencyKeyClaimed } from "./ClaimIdempotencyKey.command.ts"
import { CreateSession, SessionAlreadyExists, SessionCreated } from "./CreateSession.command.ts"
import { FailModelRequest } from "./FailModelRequest.command.ts"
import { InterruptModelRequest } from "./InterruptModelRequest.command.ts"
import { PauseTurn, TurnAwaiting, TurnContinued } from "./PauseTurn.command.ts"
import {
	DuplicateModelRequest,
	OutOfOrderModelRequest,
	RecordModelRequestStart,
	SpanModelRequestStart,
} from "./RecordModelRequestStart.command.ts"
import { UserToolConfirmation } from "./ConfirmTool.command.ts"
import { UserCustomToolResult } from "./ReturnCustomToolResult.command.ts"
import { SessionAwaitingAction } from "./SessionAwaitingAction.rejection.ts"
import {
	AgentCustomToolUse,
	AgentMcpToolResult,
	AgentMcpToolUse,
	AgentToolResult,
	AgentToolUse,
	RecordToolCall,
	RecordToolResult,
} from "./RecordToolCall.command.ts"
import { InitialMessagesPending } from "./InitialMessagesPending.rejection.ts"
import { RecordInitialMessage } from "./RecordInitialMessage.command.ts"
import { SystemMessage } from "./SendSystemMessage.command.ts"
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
	MAX_SESSION_INITIAL_EVENTS,
	NO_TOOL_USE_IDS,
	NonEmptyString,
	NonNegativeInt,
	PositiveInt,
	ToolUseIdsText,
	addToolUseId,
	removeToolUseId,
} from "./SessionTypes.ts"
import type { StopReason, ModelUsage } from "./SessionTypes.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"
import { snapshotVersion, versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"

export const SESSION_STATE_SCHEMA_VERSION = 3 as const

const Uninitialized = Schema.TaggedStruct("Uninitialized", {})
const IdleV2 = Schema.TaggedStruct("Idle", { turn: NonNegativeInt })
const Idle = Schema.TaggedStruct("Idle", {
	...IdleV2.fields,
	initial_messages_remaining: Schema.optionalKey(NonNegativeInt),
})
const Terminated = Schema.TaggedStruct("Terminated", { archived: Schema.Boolean })
const RunningV1 = Schema.TaggedStruct("Running", {
	turn: PositiveInt,
	open_model_request_id: Schema.NullOr(NonEmptyString),
	model_requests_started: NonNegativeInt,
	pending_user_messages: NonNegativeInt,
})

const Running = Schema.TaggedStruct("Running", {
	...RunningV1.fields,
	awaiting_calls: NonNegativeInt,
	awaiting_ids: ToolUseIdsText,
	paused: Schema.Boolean,
	asked_calls: NonNegativeInt,
	interrupted: Schema.Boolean,
})

export const SessionState = Schema.Union([Uninitialized, Idle, Running, Terminated])
export type SessionState = typeof SessionState.Type

export const SessionStateSnapshot = versionedSnapshot({
	current: SESSION_STATE_SCHEMA_VERSION,
	schema: SessionState,
	previous: [
		snapshotVersion({
			version: 2,
			schema: Schema.Union([Uninitialized, IdleV2, Running, Terminated]),
			migrate: (state) => state,
		}),
		snapshotVersion({
			version: 1,
			schema: Schema.Union([Uninitialized, IdleV2, RunningV1, Terminated]),
			migrate: (state) =>
				state._tag === "Running"
					? {
							...state,
							awaiting_calls: 0,
							awaiting_ids: NO_TOOL_USE_IDS,
							paused: false,
							asked_calls: 0,
							interrupted: false,
						}
					: state,
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
	const idle = new SessionStatusIdle({
		stop_reason,
		turn: running.turn,
		event_ids: running.awaiting_ids,
	})
	return shouldDrainQueue(running.pending_user_messages, stop_reason)
		? [idle, new SessionStatusRunning({ turn: running.turn + 1 })]
		: [idle]
}

const endSession = (state: ActiveState) =>
	new SessionStatusTerminated({
		running_turn: state._tag === "Running" ? state.turn : null,
		event_ids: state._tag === "Running" ? state.awaiting_ids : NO_TOOL_USE_IDS,
	})

const segmentOf = (running: RunningState) =>
	running.open_model_request_id === null && !running.paused
		? running.model_requests_started + 1
		: running.model_requests_started

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
		RecordInitialMessage,
		SendUserInterrupt,
		RecordModelRequestStart,
		RecordToolCall,
		RecordToolResult,
		PauseTurn,
		CommitModelReply,
		FailModelRequest,
		InterruptModelRequest,
		AbandonTurn,
		ArchiveSession,
		ClaimIdempotencyKey,
	],
	events: [AgentCustomToolUse, UserToolConfirmation, UserCustomToolResult, SystemMessage],
	keyOf: (cmd) => cmd.session_id,
	invariants: {
		RunningTurnIsPositive: (s) => s._tag !== "Running" || s.turn >= 1,
		IdleTurnIsNonNegative: (s) => s._tag !== "Idle" || s.turn >= 0,
		InitialMessagesAreBoundedAndOnlyBeforeTheFirstTurn: (s) =>
			s._tag !== "Idle" ||
			s.initial_messages_remaining === undefined ||
			(s.turn === 0 &&
				s.initial_messages_remaining >= 0 &&
				s.initial_messages_remaining <= MAX_SESSION_INITIAL_EVENTS),
		ModelRequestsStartedNonNegative: (s) => s._tag !== "Running" || s.model_requests_started >= 0,
		PendingUserMessagesWithinBounds: (s) =>
			s._tag !== "Running" || (s.pending_user_messages >= 0 && s.pending_user_messages <= 8),
		OpenModelRequestRequiresStartedCount: (s) =>
			s._tag !== "Running" || s.open_model_request_id === null || s.model_requests_started >= 1,
		APausedTurnHoldsNoModelRequest: (s) =>
			s._tag !== "Running" || !s.paused || s.open_model_request_id === null,
		APausedTurnWaitsOnACall: (s) => s._tag !== "Running" || !s.paused || s.awaiting_calls >= 1,
		APausedTurnAskedWhatItWaitsOn: (s) => s._tag !== "Running" || !s.paused || s.asked_calls >= 1,
		AnInterruptedTurnIsNotPaused: (s) => s._tag !== "Running" || !s.interrupted || !s.paused,
	},
	transitions: {
		OnlyTheNextInitialMessageCanAdvanceAdmission: ({ before, command, events }) =>
			command._tag !== "RecordInitialMessage" ||
			events.length === 0 ||
			(before._tag === "Idle" && before.initial_messages_remaining === command.remaining),
		OnlyTheLastInitialMessageStartsTheTurn: ({ before, command, events }) =>
			command._tag !== "RecordInitialMessage" ||
			!events.some((e) => e._tag === "session.status_running") ||
			(before._tag === "Idle" && before.initial_messages_remaining === 1),
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
		OnlyAPauseMakesATurnWait: ({ before, after, events }) =>
			after._tag !== "Running" ||
			!after.paused ||
			(before._tag === "Running" && before.turn === after.turn && before.paused) ||
			events.some((event) => event._tag === "turn.awaiting"),
		APausedTurnTakesNoUserMessage: ({ before, events }) =>
			before._tag !== "Running" ||
			!before.paused ||
			events.every((event) => event._tag !== "user.message"),
		APausedTurnIsNotAbandoned: ({ before, events }) =>
			before._tag !== "Running" ||
			!before.paused ||
			events.every((event) => event._tag !== "turn.abandoned"),
		APauseKeepsTheTurn: ({ before, after, events }) =>
			events.every(
				(event) =>
					event._tag !== "turn.awaiting" ||
					(before._tag === "Running" &&
						after._tag === "Running" &&
						after.turn === before.turn &&
						after.paused),
			),
		AContinuationKeepsTheTurn: ({ before, after, events }) =>
			events.every(
				(event) =>
					event._tag !== "turn.continued" ||
					(before._tag === "Running" &&
						after._tag === "Running" &&
						after.turn === before.turn &&
						!after.paused),
			),
		APausedTurnGoesOnOnceAnswered: ({ before, after, events }) =>
			before._tag !== "Running" ||
			!before.paused ||
			after._tag !== "Running" ||
			after.turn !== before.turn ||
			after.awaiting_calls >= 1 ||
			(!after.paused && events.some((event) => event._tag === "turn.continued")),
		AnInterruptEndsAPausedTurn: ({ before, after, command }) =>
			before._tag !== "Running" ||
			!before.paused ||
			command._tag !== "SendUserInterrupt" ||
			after._tag === "Idle" ||
			(after._tag === "Running" && after.turn === before.turn + 1),
		AnInterruptedTurnNeitherWaitsNorGoesOn: ({ before, events }) =>
			before._tag !== "Running" ||
			!before.interrupted ||
			events.every((event) => event._tag !== "turn.awaiting" && event._tag !== "turn.continued"),
		AnInterruptedTurnStaysInterrupted: ({ before, after }) =>
			before._tag !== "Running" ||
			!before.interrupted ||
			after._tag !== "Running" ||
			after.turn !== before.turn ||
			after.interrupted,
		ADeadlineAbandonsOnlyItsOwnSegment: ({ before, command, events }) =>
			command._tag !== "AbandonTurn" ||
			before._tag !== "Running" ||
			events.length === 0 ||
			(command.segment ?? 1) ===
				(before.open_model_request_id === null && !before.paused
					? before.model_requests_started + 1
					: before.model_requests_started),
		AnEndedTurnStartsTheQueuedOne: ({ before, after, events }) =>
			before._tag !== "Running" ||
			before.pending_user_messages === 0 ||
			after._tag !== "Idle" ||
			events.every(
				(event) =>
					event._tag !== "session.status_idle" ||
					(event.stop_reason.type !== "end_turn" &&
						event.stop_reason.type !== "retries_exhausted" &&
						event.stop_reason.type !== "interrupted"),
			),
		AStopNamesTheUnansweredCalls: ({ before, events }) =>
			events.every(
				(event) =>
					(event._tag !== "session.status_idle" && event._tag !== "session.status_terminated") ||
					event.event_ids === (before._tag === "Running" ? before.awaiting_ids : NO_TOOL_USE_IDS),
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

		RecordInitialMessage: (state, cmd) => {
			if (state._tag !== "Idle" || state.initial_messages_remaining !== cmd.remaining) {
				return []
			}
			const message = new UserMessage({
				initial: true,
				content: [{ type: "text", text: cmd.text }],
			})
			return cmd.remaining === 1 ? [message, new SessionStatusRunning({ turn: 1 })] : [message]
		},

		SendUserMessage: (state, cmd, ctx) => {
			const active = requireActive(state, ctx.id)
			if (active._tag !== "Idle" && active._tag !== "Running") {
				return active
			}
			if (active._tag === "Idle" && (active.initial_messages_remaining ?? 0) > 0) {
				return new InitialMessagesPending({ session_id: ctx.id })
			}
			if (active._tag === "Running" && active.paused) {
				return new SessionAwaitingAction({ session_id: ctx.id })
			}
			if (active._tag === "Running" && active.pending_user_messages >= 8) {
				return new PendingMessageQueueFull({ session_id: ctx.id, limit: 8 })
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
			if (active._tag !== "Running") {
				return new SessionNotRunning({ session_id: ctx.id, status: "idle" })
			}
			const segment = segmentOf(active)
			const interrupt = new UserInterrupt(
				segment === 1 ? { turn: active.turn } : { turn: active.turn, segment },
			)
			return active.paused ? [interrupt, ...endTurn(active, { type: "interrupted" })] : [interrupt]
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
			if (cmd.request_seq !== running.model_requests_started + 1 || running.paused) {
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
			const use = {
				tool_use_id: call.tool_use_id,
				name: call.name,
				input: call.input,
				...(call.input_truncated === true ? { truncated: true as const } : {}),
			}
			const result = {
				tool_use_id: call.tool_use_id,
				content: call.content,
				is_error: call.is_error,
				...(call.result_truncated === true ? { truncated: true as const } : {}),
				...(call.rejected === undefined ? {} : { rejected: call.rejected }),
			}
			return call.mcp_server_name === undefined
				? [new AgentToolUse(use), new AgentToolResult(result)]
				: [
						new AgentMcpToolUse({
							...use,
							mcp_server_name: call.mcp_server_name,
							...(call.evaluated_permission === undefined
								? {}
								: { evaluated_permission: call.evaluated_permission }),
						}),
						new AgentMcpToolResult(result),
					]
		},

		RecordToolResult: (state, cmd, ctx) => {
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
			const result = {
				tool_use_id: cmd.result.tool_use_id,
				content: cmd.result.content,
				is_error: cmd.result.is_error,
				...(cmd.result.truncated === true ? { truncated: true as const } : {}),
				...(cmd.result.rejected === undefined ? {} : { rejected: cmd.result.rejected }),
			}
			return [
				cmd.result.mcp === true ? new AgentMcpToolResult(result) : new AgentToolResult(result),
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
			const end = new SpanModelRequestEnd({
				model_request_start_id: cmd.model_request_start_id,
				model_usage: cmd.model_usage,
				is_error: false,
			})
			const failed = new SpanModelRequestEnd({
				model_request_start_id: cmd.model_request_start_id,
				model_usage: cmd.model_usage,
				is_error: true,
			})
			if (running.interrupted) {
				return [failed, ...endTurn(running, { type: "interrupted" })]
			}
			if (running.asked_calls === 0) {
				return [
					failed,
					new SessionErrorEvent({
						error: {
							type: "harness_paused_without_calls",
							message: "The harness paused a turn that asked for no answer.",
							retry_status: { type: "exhausted" },
						},
					}),
					...endTurn(running, { type: "retries_exhausted" }),
				]
			}
			if (running.awaiting_calls === 0) {
				return [end, new TurnContinued({ turn: running.turn, segment: cmd.request_seq + 1 })]
			}
			return [
				end,
				new TurnAwaiting({ turn: running.turn }),
				new SessionStatusIdle({
					stop_reason: { type: "requires_action" },
					turn: running.turn,
					event_ids: running.awaiting_ids,
				}),
			]
		},

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
				return [end, errorEvent, endSession(running)]
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
			if (
				state._tag !== "Running" ||
				state.turn !== cmd.turn ||
				state.paused ||
				segmentOf(state) !== (cmd.segment ?? 1)
			) {
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
					endSession(state),
					new SessionArchived(),
				]
			}
			return [endSession(state), new SessionArchived()]
		},

		ClaimIdempotencyKey: (state, cmd, ctx) =>
			state._tag === "Uninitialized"
				? new SessionNotFound({ session_id: ctx.id })
				: [new IdempotencyKeyClaimed({ fingerprint: cmd.fingerprint })],
	},
	evolve: {
		"session.created": (_, e) => ({
			_tag: "Idle" as const,
			turn: 0,
			...(e.initial_messages === undefined
				? {}
				: { initial_messages_remaining: e.initial_messages.count }),
		}),
		"user.message": (state, e) => {
			if (
				state._tag === "Idle" &&
				e.initial === true &&
				(state.initial_messages_remaining ?? 0) > 0
			) {
				return { ...state, initial_messages_remaining: (state.initial_messages_remaining ?? 0) - 1 }
			}
			return state._tag === "Running"
				? {
						...state,
						pending_user_messages:
							state.pending_user_messages < 8 ? state.pending_user_messages + 1 : 8,
					}
				: state
		},
		"system.message": (state) => state,
		"user.interrupt": (state) =>
			state._tag === "Running" ? { ...state, interrupted: true } : state,
		"user.tool_confirmation": (state, e) =>
			state._tag === "Running" && state.awaiting_calls > 0
				? {
						...state,
						awaiting_calls: state.awaiting_calls - 1,
						awaiting_ids: removeToolUseId(state.awaiting_ids, e.tool_use_id),
					}
				: state,
		"user.custom_tool_result": (state, e) =>
			state._tag === "Running" && state.awaiting_calls > 0
				? {
						...state,
						awaiting_calls: state.awaiting_calls - 1,
						awaiting_ids: removeToolUseId(state.awaiting_ids, e.custom_tool_use_id),
					}
				: state,
		"turn.awaiting": (state, e) =>
			state._tag === "Running" && state.turn === e.turn ? { ...state, paused: true } : state,
		"turn.continued": (state, e) =>
			state._tag === "Running" && state.turn === e.turn
				? { ...state, paused: false, asked_calls: 0 }
				: state,
		"session.status_running": (state, e) =>
			state._tag === "Idle"
				? {
						_tag: "Running" as const,
						turn: e.turn,
						open_model_request_id: null,
						model_requests_started: 0,
						pending_user_messages: 0,
						awaiting_calls: 0,
						awaiting_ids: NO_TOOL_USE_IDS,
						paused: false,
						asked_calls: 0,
						interrupted: false,
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
		"agent.mcp_tool_use": (state, e) =>
			state._tag === "Running" && e.evaluated_permission === "ask"
				? {
						...state,
						awaiting_calls: state.awaiting_calls + 1,
						awaiting_ids: addToolUseId(state.awaiting_ids, e.tool_use_id),
						asked_calls: state.asked_calls + 1,
					}
				: state,
		"agent.custom_tool_use": (state, e) =>
			state._tag === "Running"
				? {
						...state,
						awaiting_calls: state.awaiting_calls + 1,
						awaiting_ids: addToolUseId(state.awaiting_ids, e.tool_use_id),
						asked_calls: state.asked_calls + 1,
					}
				: state,
		"agent.mcp_tool_result": (state) => state,
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
			state._tag === "Running" && e.stop_reason.type !== "requires_action"
				? { _tag: "Idle" as const, turn: e.turn }
				: state,
		"session.error": (state) => state,
		"turn.abandoned": (state) => state,
		"session.status_terminated": (state) =>
			state._tag === "Terminated" ? state : { _tag: "Terminated" as const, archived: false },
		"session.archived": (state) =>
			state._tag === "Terminated" ? { _tag: "Terminated" as const, archived: true } : state,
		"idempotency_key.claimed": (state) => state,
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
