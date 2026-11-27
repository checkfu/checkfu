import {
	AbandonTurn,
	SessionErrorEvent,
	TurnAbandoned,
} from "../src/Session/AbandonTurn.command.ts"
import * as Domain from "@alchemy.run/domain"
import * as InMemory from "@alchemy.run/domain/InMemory"
import { Story } from "@alchemy.run/domain/Story"
import { describe, expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import {
	ArchiveSession,
	SessionArchived,
	SessionStatusTerminated,
} from "../src/Session/ArchiveSession.command.ts"
import {
	AgentMessage,
	AgentThinking,
	CommitModelReply,
	SessionStatusIdle,
	SpanModelRequestEnd,
} from "../src/Session/CommitModelReply.command.ts"
import {
	ClaimIdempotencyKey,
	IdempotencyKeyClaimed,
} from "../src/Session/ClaimIdempotencyKey.command.ts"
import {
	CreateSession,
	SessionAlreadyExists,
	SessionCreated,
} from "../src/Session/CreateSession.command.ts"
import {
	EnsureTurnStopped,
	EnsureTurnStoppedLive,
} from "../src/Session/EnsureTurnStopped.policy.ts"
import {
	SaveSessionOutputs,
	SaveSessionOutputsLive,
} from "../src/Session/SaveSessionOutputs.policy.ts"
import { OutputsSaver, OutputsUnsaved } from "../src/Session/OutputsSaver.external.ts"
import { Harness, boundedHarness, clampHarnessReply } from "../src/Session/Harness.external.ts"
import { FailModelRequest } from "../src/Session/FailModelRequest.command.ts"
import { InterruptModelRequest } from "../src/Session/InterruptModelRequest.command.ts"
import {
	DuplicateModelRequest,
	OutOfOrderModelRequest,
	RecordModelRequestStart,
	SpanModelRequestStart,
} from "../src/Session/RecordModelRequestStart.command.ts"
import {
	AgentMcpToolResult,
	AgentToolResult,
	AgentToolUse,
	RecordToolCall,
	RecordToolResult,
} from "../src/Session/RecordToolCall.command.ts"
import { boundToolEvents, recordToolEvents, toolUseId } from "../src/Session/RecordToolEvents.ts"
import { RunTurn, RunTurnLive, turnKey } from "../src/Session/RunTurn.saga.ts"
import { SendUserInterrupt, UserInterrupt } from "../src/Session/SendUserInterrupt.command.ts"
import {
	PendingMessageQueueFull,
	SendUserMessage,
	SessionStatusRunning,
	UserMessage,
} from "../src/Session/SendUserMessage.command.ts"
import {
	SESSION_STATE_SCHEMA_VERSION,
	Session,
	SessionStateSnapshot,
} from "../src/Session/Session.aggregate.ts"
import { SessionNotFound } from "../src/Session/SessionNotFound.rejection.ts"
import { SessionNotRunning } from "../src/Session/SessionNotRunning.rejection.ts"
import { SessionTerminated } from "../src/Session/SessionTerminated.rejection.ts"
import {
	MAX_ERROR_MESSAGE_LENGTH,
	MAX_ERROR_TYPE_LENGTH,
	MAX_IDENTIFIER_LENGTH,
	MAX_MESSAGE_TEXT_LENGTH,
	MAX_THINKING_TEXT_LENGTH,
} from "../src/Session/SessionTypes.ts"
import type { SessionId } from "../src/Session/Session.id.ts"
import type { ToolCall } from "../src/Session/SessionTypes.ts"
import { SessionView } from "../src/Session/SessionView.view.ts"
import { StaleTurn } from "../src/Session/StaleTurn.rejection.ts"
import { StartTurn, StartTurnLive } from "../src/Session/StartTurn.policy.ts"
import { TurnInput } from "../src/Session/TurnInput.view.ts"
import { UnknownModelRequest } from "../src/Session/UnknownModelRequest.rejection.ts"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import { Sessions, SessionsHandlersLive } from "../src/Sessions.model.ts"

const StartTurnNoopLayer = Layer.mergeAll(
	StartTurn.toLayer(Effect.succeed(() => Effect.void)),
	EnsureTurnStopped.toLayer(Effect.succeed(() => Effect.void)),
	SaveSessionOutputs.toLayer(Effect.succeed(() => Effect.void)),
)
const aggregateStory = Story.make(Sessions, {
	layer: Layer.mergeAll(StartTurnNoopLayer, RunTurnLive),
	stub: [Harness],
})
const story = aggregateStory

const fullStory = Story.make(Sessions, {
	layer: SessionsHandlersLive,
	stub: [Harness, OutputsSaver],
})

const retryCleanup = EnsureTurnStopped.toLayer(EnsureTurnStopped, {
	retry: Schedule.recurs(1),
}).pipe(Layer.provide(EnsureTurnStoppedLive))
const redeliveryStory = Story.make(Sessions, {
	layer: Layer.mergeAll(StartTurnLive, RunTurnLive, retryCleanup, SaveSessionOutputsLive),
	stub: [Harness, OutputsSaver],
})

const retryDiscard = SaveSessionOutputs.toLayer(SaveSessionOutputs, {
	retry: Schedule.recurs(1),
}).pipe(Layer.provide(SaveSessionOutputsLive))
const discardStory = Story.make(Sessions, {
	layer: Layer.mergeAll(StartTurnLive, RunTurnLive, EnsureTurnStoppedLive, retryDiscard),
	stub: [Harness, OutputsSaver],
})

const HarnessNoopLayer = Harness.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
		discardWorkspace: () => Effect.void,
		storeRepositoryToken: () => Effect.void,
		runTurn: () =>
			Effect.succeed({
				thinking: null,
				text: "ok",
				input_tokens: 1,
				output_tokens: 1,
				stop_reason: { type: "end_turn" as const },
			}),
	}),
)

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
const t1 = DateTime.makeUnsafe("2026-01-01T00:01:00.000Z")
const t2 = DateTime.makeUnsafe("2026-01-01T00:02:00.000Z")

const createdEvent = new SessionCreated({
	agent_id: "agent_001",
	agent_version: 1,
	environment_id: "env_001",
	title: null,
})

describe("Sessions", () => {
	it.effect("is well defined", () =>
		Effect.scoped(Layer.build(Sessions.layer(SessionsHandlersLive))).pipe(
			Effect.provide([Domain.InMemory, HarnessNoopLayer, OutputsUnsaved]),
		),
	)

	it.effect("runs a full turn from user.message to session.status_idle", () => {
		const session = Session.ref("sess_001")
		return story(
			Story.when(
				new CreateSession({
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: "Hello",
				}),
			),
			Story.then(
				session,
				new SessionCreated({
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: "Hello",
				}),
			),
			Story.state(session, { _tag: "Idle", turn: 0 }),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Hi" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
				new SessionStatusRunning({ turn: 1 }),
			),
			Story.replied({ turn: 1 }),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				open_model_request_id: null,
				model_requests_started: 0,
				pending_user_messages: 0,
			}),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_001",
				}),
			),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "evt_001" })),
			Story.when(
				new CommitModelReply({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_001",
					thinking: "Thinking...",
					text: "Hello!",
					model_usage: { input_tokens: 12, output_tokens: 5 },
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.then(
				session,
				new AgentThinking({ thinking: "Thinking..." }),
				new AgentMessage({ content: [{ type: "text", text: "Hello!" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: "evt_001",
					model_usage: { input_tokens: 12, output_tokens: 5 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect("rejects all stale turn-1 worker commands while turn 2 is running", () => {
		const session = Session.ref("sess_stale_turn")
		const stale = new StaleTurn({ session_id: session.id, active_turn: 2, received_turn: 1 })
		const usage = { input_tokens: 10, output_tokens: 4 }
		return story(
			Story.given(
				session,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "Turn 1" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: "evt_req" }),
				new SpanModelRequestEnd({
					model_request_start_id: "evt_req",
					model_usage: usage,
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Turn 2" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Turn 2" }] }),
				new SessionStatusRunning({ turn: 2 }),
			),
			Story.replied({ turn: 2 }),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 2,
					request_seq: 1,
					model_request_start_id: "evt_req",
				}),
			),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "evt_req" })),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 1,
					request_seq: 2,
					model_request_start_id: "evt_stale",
				}),
			),
			Story.rejected(stale),
			Story.when(
				new CommitModelReply({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_req",
					thinking: "Stale thinking",
					text: "Stale message",
					model_usage: usage,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.rejected(stale),
			Story.when(
				new FailModelRequest({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_req",
					model_usage: usage,
					error_type: "model_request_failed_error",
					message: "Stale exhausted error",
					disposition: "exhausted",
				}),
			),
			Story.rejected(stale),
			Story.when(
				new InterruptModelRequest({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_req",
					model_usage: usage,
				}),
			),
			Story.rejected(stale),
			Story.when(
				new CommitModelReply({
					session_id: session.id,
					turn: 2,
					request_seq: 1,
					model_request_start_id: "evt_req",
					thinking: null,
					text: "Still running turn 2",
					model_usage: usage,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Still running turn 2" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: "evt_req",
					model_usage: usage,
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
			),
			Story.state(session, { _tag: "Idle", turn: 2 }),
		)
	})

	it.effect("enforces sequential model-request accounting before completing a turn", () => {
		const session = Session.ref("sess_model_req")
		const usage = { input_tokens: 10, output_tokens: 4 }
		const commit = (request_seq: number, model_request_start_id: string) =>
			new CommitModelReply({
				session_id: session.id,
				turn: 1,
				request_seq,
				model_request_start_id,
				thinking: null,
				text: "Done",
				model_usage: usage,
				stop_reason: { type: "end_turn" },
			})
		return story(
			Story.given(
				session,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
				new SessionStatusRunning({ turn: 1 }),
			),
			Story.when(commit(1, "evt_unknown")),
			Story.rejected(
				new UnknownModelRequest({
					session_id: session.id,
					model_request_start_id: "evt_unknown",
				}),
			),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 1,
					request_seq: 2,
					model_request_start_id: "evt_skip",
				}),
			),
			Story.rejected(
				new OutOfOrderModelRequest({
					session_id: session.id,
					expected_request_seq: 1,
					received_request_seq: 2,
				}),
			),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_1",
				}),
			),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "evt_1" })),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_1",
				}),
			),
			Story.rejected(
				new DuplicateModelRequest({
					session_id: session.id,
					model_request_start_id: "evt_1",
					open_model_request_id: "evt_1",
					model_requests_started: 1,
				}),
			),
			Story.given(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: "evt_1",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				open_model_request_id: null,
				model_requests_started: 1,
				pending_user_messages: 0,
			}),
			Story.when(commit(1, "evt_1")),
			Story.rejected(
				new UnknownModelRequest({
					session_id: session.id,
					model_request_start_id: "evt_1",
				}),
			),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_1",
				}),
			),
			Story.rejected(
				new DuplicateModelRequest({
					session_id: session.id,
					model_request_start_id: "evt_1",
					open_model_request_id: null,
					model_requests_started: 1,
				}),
			),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 1,
					request_seq: 2,
					model_request_start_id: "evt_1",
				}),
			),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "evt_1" })),
			Story.when(commit(1, "evt_1")),
			Story.rejected(
				new UnknownModelRequest({
					session_id: session.id,
					model_request_start_id: "evt_1",
				}),
			),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				open_model_request_id: "evt_1",
				model_requests_started: 2,
				pending_user_messages: 0,
			}),
			Story.when(commit(2, "evt_1")),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Done" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: "evt_1",
					model_usage: usage,
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect("queues a second user.message while running without duplicating status_running", () => {
		const session = Session.ref("sess_002")
		return story(
			Story.given(
				session,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "First" }] }),
				new SessionStatusRunning({ turn: 1 }),
			),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Second" })),
			Story.then(session, new UserMessage({ content: [{ type: "text", text: "Second" }] })),
			Story.replied({ turn: 2 }),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				open_model_request_id: null,
				model_requests_started: 0,
				pending_user_messages: 1,
			}),
		)
	})

	it.effect(
		"records an interrupt request without ending the turn, and ends it when the harness reports it",
		() => {
			const session = Session.ref("sess_003")
			const req1 = "sess_003:turn:1:req:1"
			return story(
				Story.given(session, createdEvent),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Run" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Run" }] }),
					new SessionStatusRunning({ turn: 1 }),
				),
				Story.replied({ turn: 1 }),
				Story.when(
					new RecordModelRequestStart({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: req1,
					}),
				),
				Story.then(session, new SpanModelRequestStart({ model_request_start_id: req1 })),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt({ segment: 1, turn: 1 })),
				Story.state(session, {
					_tag: "Running",
					turn: 1,
					open_model_request_id: req1,
					model_requests_started: 1,
					pending_user_messages: 0,
				}),
				Story.when(
					new InterruptModelRequest({
						session_id: session.id,
						turn: 1,
						model_usage: { input_tokens: 3, output_tokens: 2 },
						request_seq: 1,
						model_request_start_id: req1,
					}),
				),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 3, output_tokens: 2 },
						is_error: true,
					}),
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 1, event_ids: "[]" }),
				),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			)
		},
	)

	it.effect("distinguishes exhausted and terminal session.error transitions", () => {
		const session = Session.ref("sess_004")
		const usage = { input_tokens: 0, output_tokens: 0 }
		const exhaustedError = {
			type: "model_request_failed_error",
			message: "429 rate limit",
			retry_status: { type: "exhausted" as const },
		}
		const terminalError = {
			type: "invalid_api_key_error",
			message: "401 unauthorized",
			retry_status: { type: "terminal" as const },
		}
		const failExhausted = new FailModelRequest({
			session_id: session.id,
			turn: 1,
			request_seq: 1,
			model_request_start_id: "req_1",
			model_usage: usage,
			error_type: exhaustedError.type,
			message: exhaustedError.message,
			disposition: "exhausted",
		})
		return story(
			Story.given(
				session,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: "req_1" }),
			),
			Story.when(failExhausted),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: "req_1",
					model_usage: usage,
					is_error: true,
				}),
				new SessionErrorEvent({ error: exhaustedError }),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					event_ids: "[]",
				}),
			),
			Story.state(session, { _tag: "Idle", turn: 1 }),
			Story.when(failExhausted),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Retry" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Retry" }] }),
				new SessionStatusRunning({ turn: 2 }),
			),
			Story.replied({ turn: 2 }),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 2,
					request_seq: 1,
					model_request_start_id: "req_2",
				}),
			),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "req_2" })),
			Story.when(
				new FailModelRequest({
					session_id: session.id,
					turn: 2,
					request_seq: 1,
					model_request_start_id: "req_2",
					model_usage: usage,
					error_type: terminalError.type,
					message: terminalError.message,
					disposition: "terminal",
				}),
			),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: "req_2",
					model_usage: usage,
					is_error: true,
				}),
				new SessionErrorEvent({ error: terminalError }),
				new SessionStatusTerminated({ running_turn: 2, event_ids: "[]" }),
			),
			Story.state(session, { _tag: "Terminated", archived: false }),
			Story.when(new SendUserMessage({ session_id: session.id, text: "After" })),
			Story.rejected(new SessionTerminated({ session_id: session.id })),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(session, new SessionArchived()),
			Story.state(session, { _tag: "Terminated", archived: true }),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(session),
		)
	})

	it.effect("rejects turn-recording commands when idle and archives running sessions", () => {
		const session = Session.ref("sess_005")
		const commit = (model_request_start_id: string, text: string) =>
			new CommitModelReply({
				session_id: session.id,
				turn: 1,
				request_seq: 1,
				model_request_start_id,
				thinking: null,
				text,
				model_usage: { input_tokens: 1, output_tokens: 1 },
				stop_reason: { type: "end_turn" },
			})
		return story(
			Story.given(session, createdEvent),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_0",
				}),
			),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(commit("evt_0", "Early")),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Work" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Work" }] }),
				new SessionStatusRunning({ turn: 1 }),
			),
			Story.replied({ turn: 1 }),
			Story.when(
				new RecordModelRequestStart({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_open",
				}),
			),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "evt_open" })),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: "evt_open",
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionStatusTerminated({ running_turn: 1, event_ids: "[]" }),
				new SessionArchived(),
			),
			Story.state(session, { _tag: "Terminated", archived: true }),
			Story.when(commit("evt_open", "Late")),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "terminated" })),
		)
	})

	it.effect("rejects unknown sessions, duplicate creation, and commands after termination", () => {
		const missing = Session.ref("sess_missing")
		const session = Session.ref("tenant:session")
		return story(
			Story.when(new SendUserMessage({ session_id: missing.id, text: "Hi" })),
			Story.rejected(new SessionNotFound({ session_id: missing.id })),
			Story.when(new ArchiveSession({ session_id: missing.id })),
			Story.rejected(new SessionNotFound({ session_id: missing.id })),
			Story.given(session, createdEvent),
			Story.when(
				new CreateSession({
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: null,
				}),
			),
			Story.rejected(new SessionAlreadyExists({ session_id: session.id })),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(
				session,
				new SessionStatusTerminated({ running_turn: null, event_ids: "[]" }),
				new SessionArchived(),
			),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(session),
			Story.when(new SendUserMessage({ session_id: session.id, text: "After" })),
			Story.rejected(new SessionTerminated({ session_id: session.id })),
		)
	})

	it.effect(
		"records the first fingerprint claimed under a command id, replays it for every later claim, and claims on an ended session",
		() => {
			const missing = Session.ref("sess_missing")
			const session = Session.ref("sess_claims")
			const claim = (fingerprint: string) =>
				new ClaimIdempotencyKey({ session_id: session.id, fingerprint })
			return story(
				Story.when(new ClaimIdempotencyKey({ session_id: missing.id, fingerprint: "fp_alpha" })),
				Story.rejected(new SessionNotFound({ session_id: missing.id })),
				Story.given(session, createdEvent),
				Story.when(claim("fp_alpha"), { commandId: "batch:key-1" }),
				Story.then(session, new IdempotencyKeyClaimed({ fingerprint: "fp_alpha" })),
				Story.state(session, { _tag: "Idle", turn: 0 }),
				Story.when(claim("fp_beta"), { commandId: "batch:key-1" }),
				Story.then(session),
				Story.when(claim("fp_alpha"), { commandId: "batch:key-1" }),
				Story.then(session),
				Story.when(claim("fp_beta"), { commandId: "batch:key-2" }),
				Story.then(session, new IdempotencyKeyClaimed({ fingerprint: "fp_beta" })),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Hi" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
					new SessionStatusRunning({ turn: 1 }),
				),
				Story.when(claim("fp_gamma"), { commandId: "batch:key-3" }),
				Story.then(session, new IdempotencyKeyClaimed({ fingerprint: "fp_gamma" })),
				Story.when(new ArchiveSession({ session_id: session.id })),
				Story.then(
					session,
					new SessionStatusTerminated({ running_turn: 1, event_ids: "[]" }),
					new SessionArchived(),
				),
				Story.when(claim("fp_alpha"), { commandId: "batch:key-1" }),
				Story.then(session),

				Story.when(claim("fp_delta"), { commandId: "batch:key-4" }),
				Story.then(session, new IdempotencyKeyClaimed({ fingerprint: "fp_delta" })),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Late" })),
				Story.rejected(new SessionTerminated({ session_id: session.id })),
			)
		},
	)

	it.effect("replays in-flight requests from Session events and supports colon session IDs", () => {
		const sessionA = Session.ref("s")
		const sessionB = Session.ref("s:1:x")
		const usage = { input_tokens: 4, output_tokens: 2 }
		const commit = (session_id: typeof sessionA.id, model_request_start_id: string) =>
			new CommitModelReply({
				session_id,
				turn: 1,
				request_seq: 1,
				model_request_start_id,
				thinking: null,
				text: "Done",
				model_usage: usage,
				stop_reason: { type: "end_turn" },
			})
		return story(
			Story.given(
				sessionA,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "A" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: "x:1:y" }),
			),
			Story.given(
				sessionB,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "B" }] }),
				new SessionStatusRunning({ turn: 1 }),
			),
			Story.when(
				new RecordModelRequestStart({
					session_id: sessionB.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "y",
				}),
			),
			Story.then(sessionB, new SpanModelRequestStart({ model_request_start_id: "y" })),
			Story.when(commit(sessionB.id, "y")),
			Story.then(
				sessionB,
				new AgentMessage({ content: [{ type: "text", text: "Done" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: "y",
					model_usage: usage,
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
			Story.when(commit(sessionA.id, "x:1:y")),
			Story.then(
				sessionA,
				new AgentMessage({ content: [{ type: "text", text: "Done" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: "x:1:y",
					model_usage: usage,
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
		)
	})

	it.effect(
		"executes multi-turn replies via StartTurn and RunTurn and projects SessionView and public events",
		() => {
			const session = Session.ref("sess_e2e_1")
			const turn1Key = turnKey(session.id, 1)
			const turn2Key = turnKey(session.id, 2)
			const req1 = `${turn1Key}:req:1`
			const req2 = `${turn2Key}:req:1`
			return fullStory(
				Story.clock(t0),
				Story.when(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 2,
						environment_id: "env_001",
						title: "Quickstart",
					}),
				),
				Story.then(
					session,
					new SessionCreated({
						agent_id: "agent_001",
						agent_version: 2,
						environment_id: "env_001",
						title: "Quickstart",
					}),
				),
				Story.view(SessionView, session, {
					id: session.id,
					type: "session",
					status: "idle",
					agent_id: "agent_001",
					agent_version: 2,
					environment_id: "env_001",
					title: "Quickstart",
					turn: 0,
					usage: { input_tokens: 0, output_tokens: 0 },
					created_at: t0,
					updated_at: t0,
					archived_at: null,
				}),
				Story.clock(t1),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Hi" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
					new SessionStatusRunning({ turn: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.replied({ turn: 1 }),
				Story.call(Harness.runTurn, {
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 2,
					environment_id: "env_001",
					turn: 1,
				}),
				Story.succeed(Harness.runTurn, {
					thinking: "Greeting the user",
					text: "Hello!",
					input_tokens: 10,
					output_tokens: 4,
					stop_reason: { type: "end_turn" },
				}),
				Story.then(
					session,
					new AgentThinking({ thinking: "Greeting the user" }),
					new AgentMessage({ content: [{ type: "text", text: "Hello!" }] }),
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 10, output_tokens: 4 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
				),
				Story.call(OutputsSaver.save, { session_id: session.id, turn: 1 }),
				Story.succeed(OutputsSaver.save, undefined),
				Story.saga(RunTurn, turn1Key, {
					_tag: "Completed",
					result: { status: "completed" },
				}),
				Story.view(SessionView, session, {
					id: session.id,
					type: "session",
					status: "idle",
					agent_id: "agent_001",
					agent_version: 2,
					environment_id: "env_001",
					title: "Quickstart",
					turn: 1,
					usage: { input_tokens: 10, output_tokens: 4 },
					created_at: t0,
					updated_at: t1,
					archived_at: null,
				}),
				Story.emitted(SessionView, session, [
					new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
					new SessionStatusRunning({ turn: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
					new AgentThinking({ thinking: "Greeting the user" }),
					new AgentMessage({ content: [{ type: "text", text: "Hello!" }] }),
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 10, output_tokens: 4 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
				]),
				Story.clock(t2),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Follow up" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Follow up" }] }),
					new SessionStatusRunning({ turn: 2 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.replied({ turn: 2 }),
				Story.call(Harness.runTurn, {
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 2,
					environment_id: "env_001",
					turn: 2,
				}),
				Story.succeed(Harness.runTurn, {
					thinking: null,
					text: "Got it.",
					input_tokens: 20,
					output_tokens: 6,
					stop_reason: { type: "end_turn" },
				}),
				Story.then(
					session,
					new AgentMessage({ content: [{ type: "text", text: "Got it." }] }),
					new SpanModelRequestEnd({
						model_request_start_id: req2,
						model_usage: { input_tokens: 20, output_tokens: 6 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
				),
				Story.call(OutputsSaver.save, { session_id: session.id, turn: 2 }),
				Story.succeed(OutputsSaver.save, undefined),
				Story.saga(RunTurn, turn2Key, {
					_tag: "Completed",
					result: { status: "completed" },
				}),
				Story.view(SessionView, session, {
					id: session.id,
					type: "session",
					status: "idle",
					agent_id: "agent_001",
					agent_version: 2,
					environment_id: "env_001",
					title: "Quickstart",
					turn: 2,
					usage: { input_tokens: 30, output_tokens: 10 },
					created_at: t0,
					updated_at: t2,
					archived_at: null,
				}),
			)
		},
	)

	it.effect("closes open model requests and records exhausted and terminal provider errors", () => {
		const session = Session.ref("sess_e2e_err")
		const turn1Key = turnKey(session.id, 1)
		const turn2Key = turnKey(session.id, 2)
		const req1 = `${turn1Key}:req:1`
		const req2 = `${turn2Key}:req:1`
		return fullStory(
			Story.clock(t0),
			Story.when(
				new CreateSession({
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: null,
				}),
			),
			Story.then(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "First" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "First" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
			}),
			Story.fail(Harness.runTurn, {
				_tag: "TurnFailed",
				error_type: "model_request_failed_error",
				message: "429 rate limited",
				terminal: false,
			}),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionErrorEvent({
					error: {
						type: "model_request_failed_error",
						message: "429 rate limited",
						retry_status: { type: "exhausted" },
					},
				}),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					event_ids: "[]",
				}),
			),
			Story.saga(RunTurn, turn1Key, {
				_tag: "Completed",
				result: { status: "failed" },
			}),
			Story.state(session, { _tag: "Idle", turn: 1 }),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Second" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Second" }] }),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 2,
			}),
			Story.fail(Harness.runTurn, {
				_tag: "TurnFailed",
				error_type: "invalid_api_key_error",
				message: "401 unauthorized",
				terminal: true,
			}),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionErrorEvent({
					error: {
						type: "invalid_api_key_error",
						message: "401 unauthorized",
						retry_status: { type: "terminal" },
					},
				}),
				new SessionStatusTerminated({ running_turn: 2, event_ids: "[]" }),
			),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 2 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.call(Harness.discardWorkspace, { session_id: session.id }),
			Story.succeed(Harness.discardWorkspace, undefined),
			Story.saga(RunTurn, turn2Key, {
				_tag: "Completed",
				result: { status: "failed" },
			}),
			Story.state(session, { _tag: "Terminated", archived: false }),
			Story.view(SessionView, session, {
				id: session.id,
				type: "session",
				status: "terminated",
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				title: null,
				turn: 2,
				usage: { input_tokens: 0, output_tokens: 0 },
				created_at: t0,
				updated_at: t0,
				archived_at: null,
			}),
			Story.clock(t1),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(session, new SessionArchived()),
			Story.state(session, { _tag: "Terminated", archived: true }),
			Story.emitted(SessionView, session, [
				new UserMessage({ content: [{ type: "text", text: "First" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionErrorEvent({
					error: {
						type: "model_request_failed_error",
						message: "429 rate limited",
						retry_status: { type: "exhausted" },
					},
				}),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					event_ids: "[]",
				}),
				new UserMessage({ content: [{ type: "text", text: "Second" }] }),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionErrorEvent({
					error: {
						type: "invalid_api_key_error",
						message: "401 unauthorized",
						retry_status: { type: "terminal" },
					},
				}),
				new SessionStatusTerminated({ running_turn: 2, event_ids: "[]" }),
				new SessionArchived(),
			]),
			Story.view(SessionView, session, {
				id: session.id,
				type: "session",
				status: "terminated",
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				title: null,
				turn: 2,
				usage: { input_tokens: 0, output_tokens: 0 },
				created_at: t0,
				updated_at: t1,
				archived_at: t1,
			}),
		)
	})

	it.effect("drains a follow-up user.message accepted while turn 1 is still running", () => {
		const session = Session.ref("sess_e2e_drain")
		const turn1Key = turnKey(session.id, 1)
		const turn2Key = turnKey(session.id, 2)
		const req1 = `${turn1Key}:req:1`
		const req2 = `${turn2Key}:req:1`
		return fullStory(
			Story.clock(t0),
			Story.when(
				new CreateSession({
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: null,
				}),
			),
			Story.then(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "First" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "First" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
			}),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Second" })),
			Story.then(session, new UserMessage({ content: [{ type: "text", text: "Second" }] })),
			Story.replied({ turn: 2 }),
			Story.succeed(Harness.runTurn, {
				thinking: null,
				text: "Reply 1",
				input_tokens: 5,
				output_tokens: 2,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Reply 1" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 5, output_tokens: 2 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 1 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.saga(RunTurn, turn1Key, {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 2,
			}),
			Story.succeed(Harness.runTurn, {
				thinking: null,
				text: "Reply 2",
				input_tokens: 8,
				output_tokens: 3,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Reply 2" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 8, output_tokens: 3 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 2 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.saga(RunTurn, turn2Key, {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.state(session, { _tag: "Idle", turn: 2 }),
		)
	})

	it.effect(
		"forwards user.interrupt to the harness and ends the turn only when the harness reports it",
		() => {
			const session = Session.ref("sess_e2e_interrupt")
			const turn1Key = turnKey(session.id, 1)
			const req1 = `${turn1Key}:req:1`
			return fullStory(
				Story.clock(t0),
				Story.when(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				),
				Story.then(session, createdEvent),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Long task" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Long task" }] }),
					new SessionStatusRunning({ turn: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(Harness.runTurn, {
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					turn: 1,
				}),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt({ segment: 1, turn: 1 })),
				Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
				Story.succeed(Harness.interrupt, undefined),
				Story.state(session, {
					_tag: "Running",
					turn: 1,
					open_model_request_id: req1,
					model_requests_started: 1,
					pending_user_messages: 0,
				}),
				Story.fail(Harness.runTurn, { _tag: "TurnInterrupted" }),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 1, event_ids: "[]" }),
				),
				Story.saga(RunTurn, turn1Key, {
					_tag: "Completed",
					result: { status: "interrupted" },
				}),
				Story.state(session, { _tag: "Idle", turn: 1 }),
			)
		},
	)

	it.effect("runs queued prompts once the harness reports the interrupted turn", () => {
		const session = Session.ref("sess_e2e_replace_after_interrupt")
		const turn1Key = turnKey(session.id, 1)
		const req1 = `${turn1Key}:req:1`
		const turn2Key = turnKey(session.id, 2)
		const req2 = `${turn2Key}:req:1`
		return fullStory(
			Story.clock(t0),
			Story.when(
				new CreateSession({
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: null,
				}),
			),
			Story.then(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Wrong prompt" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Wrong prompt" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call("turn-1", Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
				input: ["Wrong prompt"],
			}),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Actual prompt" })),
			Story.then(session, new UserMessage({ content: [{ type: "text", text: "Actual prompt" }] })),
			Story.replied({ turn: 2 }),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.then(session, new UserInterrupt({ segment: 1, turn: 1 })),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.fail("turn-1", Harness.runTurn, { _tag: "TurnInterrupted" }),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 1, event_ids: "[]" }),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.saga(RunTurn, turn1Key, {
				_tag: "Completed",
				result: { status: "interrupted" },
			}),
			Story.call("turn-2", Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 2,
				input: ["Actual prompt"],
			}),
			Story.succeed("turn-2", Harness.runTurn, {
				thinking: null,
				text: "Answer to actual prompt",
				input_tokens: 9,
				output_tokens: 5,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Answer to actual prompt" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 9, output_tokens: 5 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 2 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.saga(RunTurn, turn2Key, {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.state(session, { _tag: "Idle", turn: 2 }),
		)
	})

	it.effect(
		"abandons a turn whose harness cannot be reached and runs the next turn while that interrupt is still retried",
		() => {
			const session = Session.ref("sess_e2e_unreachable")
			const turn1Key = turnKey(session.id, 1)
			const turn2Key = turnKey(session.id, 2)
			const req1 = `${turn1Key}:req:1`
			const req2 = `${turn2Key}:req:1`
			return redeliveryStory(
				Story.clock(t0),
				Story.when(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				),
				Story.then(session, createdEvent),
				Story.when(new SendUserMessage({ session_id: session.id, text: "First" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "First" }] }),
					new SessionStatusRunning({ turn: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(Harness.runTurn, { session_id: session.id, turn: 1 }),
				Story.fail(Harness.runTurn, { _tag: "HarnessUnavailable" }),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionErrorEvent({
						error: {
							type: "harness_unavailable",
							message: "The agent runtime could not be reached.",
							retry_status: { type: "exhausted" },
						},
					}),
					new TurnAbandoned({ turn: 1 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 1,
						event_ids: "[]",
					}),
				),
				Story.saga(RunTurn, turn1Key, { _tag: "Completed", result: { status: "failed" } }),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
				Story.fail(Harness.interrupt, { _tag: "HarnessUnavailable" }),
				Story.call("cleanup", Harness.interrupt, {
					session_id: session.id,
					turn: 1,
				}),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Second" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Second" }] }),
					new SessionStatusRunning({ turn: 2 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.call(Harness.runTurn, {
					session_id: session.id,
					turn: 2,
					input: ["Second"],
				}),
				Story.succeed("cleanup", Harness.interrupt, undefined),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt({ segment: 1, turn: 2 })),
				Story.call(Harness.interrupt, { session_id: session.id, turn: 2 }),
				Story.succeed(Harness.interrupt, undefined),
				Story.fail(Harness.runTurn, { _tag: "TurnInterrupted" }),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req2,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 2, event_ids: "[]" }),
				),
				Story.saga(RunTurn, turn2Key, { _tag: "Completed", result: { status: "interrupted" } }),
				Story.state(session, { _tag: "Idle", turn: 2 }),
			)
		},
	)

	it.each(["defect", "self-interrupt", "synchronous throw"] as const)(
		"fails the turn with a generic message when the provider ends in a %s, without exposing the cause",
		async (mode) => {
			const error = await Effect.runPromise(
				Effect.gen(function* () {
					const sessions = yield* Session
					const runs = yield* RunTurn
					const views = yield* SessionView
					const session = Session.ref(`sess_provider_${mode}`)
					yield* sessions.send(
						new CreateSession({
							session_id: session.id,
							agent_id: "agent_001",
							agent_version: 1,
							environment_id: "env_001",
							title: null,
						}),
					)
					yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Go" }))
					yield* runs.get(turnKey(session.id, 1)).result
					yield* views.waitFor(session, { status: "idle", turn: 1 }, { timeout: "5 seconds" })
					const page = yield* views.list(session)
					const failed = page.entries.find((entry) => entry.event._tag === "session.error")
					return failed?.event._tag === "session.error" ? failed.event.error : null
				}).pipe(
					Effect.provide(
						Sessions.layer(SessionsHandlersLive).pipe(
							Layer.provide(
								Layer.mergeAll(
									Domain.InMemory,
									OutputsUnsaved,
									boundedHarness(
										Effect.succeed({
											interrupt: () => Effect.void,
											discardWorkspace: () => Effect.void,
											storeRepositoryToken: () => Effect.void,
											runTurn: () => {
												if (mode === "synchronous throw") {
													throw new Error("secret adapter failure")
												}
												return mode === "defect"
													? Effect.die(new Error("secret internal sdk failure"))
													: Effect.interrupt
											},
										}),
									),
								),
							),
						),
					),
				),
			)
			expect(error).toEqual({
				type: "provider_internal_error",
				message: "Model provider failed unexpectedly.",
				retry_status: { type: "exhausted" },
			})
		},
	)

	it.effect(
		"ends the turn as unreachable when an interrupt cannot be delivered to the harness",
		() => {
			const session = Session.ref("sess_e2e_interrupt_undelivered")
			const turn1Key = turnKey(session.id, 1)
			const req1 = `${turn1Key}:req:1`
			return fullStory(
				Story.clock(t0),
				Story.when(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				),
				Story.then(session, createdEvent),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Long task" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Long task" }] }),
					new SessionStatusRunning({ turn: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(Harness.runTurn, { session_id: session.id, turn: 1 }),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt({ segment: 1, turn: 1 })),
				Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
				Story.fail(Harness.interrupt, { _tag: "HarnessUnavailable" }),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionErrorEvent({
						error: {
							type: "harness_unavailable",
							message: "The agent runtime could not be reached.",
							retry_status: { type: "exhausted" },
						},
					}),
					new TurnAbandoned({ turn: 1 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 1,
						event_ids: "[]",
					}),
				),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
				Story.succeed(Harness.interrupt, undefined),
				Story.succeed(Harness.runTurn, {
					thinking: null,
					text: "Too late to publish",
					input_tokens: 4,
					output_tokens: 2,
					stop_reason: { type: "end_turn" },
				}),
				Story.then(session),
				Story.saga(RunTurn, turn1Key, { _tag: "Completed", result: { status: "aborted" } }),
				Story.state(session, { _tag: "Idle", turn: 1 }),
			)
		},
	)

	it.effect("leaves the turn running when a retrying diagnostic is recorded", () => {
		const session = Session.ref("sess_retry_diagnostic")
		const request = new SpanModelRequestStart({
			model_request_start_id: turnKey(session.id, 1) + ":req:1",
		})
		const diagnostic = {
			type: "harness_unavailable",
			message: "Retrying the connection.",
			retry_status: { type: "retrying" as const },
		}
		return fullStory(
			Story.given(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "First" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "First" }] }),
				new SessionStatusRunning({ turn: 1 }),
				request,
			),
			Story.call(Harness.runTurn, { turn: 1 }),
			Story.given(session, new SessionErrorEvent({ error: diagnostic })),
			Story.view(TurnInput, session, {
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
				input: ["First"],
				unsent: [],
			}),
			Story.succeed(Harness.runTurn, {
				thinking: null,
				text: "Done",
				input_tokens: 1,
				output_tokens: 1,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Done" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: request.model_request_start_id,
					model_usage: { input_tokens: 1, output_tokens: 1 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 1 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect(
		"runs turn after turn whether each completes, is interrupted or exhausts its retries",
		() => {
			const session = Session.ref("sess_turns_kept")
			const usage = { input_tokens: 1, output_tokens: 1 }
			const text = (value: string) => new UserMessage({ content: [{ type: "text", text: value }] })
			const start = (turn: number) =>
				new RecordModelRequestStart({
					session_id: session.id,
					turn,
					request_seq: 1,
					model_request_start_id: `req_${turn}`,
				})
			const end = (turn: number, is_error: boolean) =>
				new SpanModelRequestEnd({
					model_request_start_id: `req_${turn}`,
					model_usage: usage,
					is_error,
				})
			return story(
				Story.given(session, createdEvent),
				Story.state(session, { _tag: "Idle", turn: 0 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "One" })),
				Story.then(session, text("One"), new SessionStatusRunning({ turn: 1 })),
				Story.when(start(1)),
				Story.then(session, new SpanModelRequestStart({ model_request_start_id: "req_1" })),
				Story.when(
					new CommitModelReply({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: "req_1",
						thinking: null,
						text: "Done",
						model_usage: usage,
						stop_reason: { type: "end_turn" },
					}),
				),
				Story.then(
					session,
					new AgentMessage({ content: [{ type: "text", text: "Done" }] }),
					end(1, false),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
				),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Two" })),
				Story.then(session, text("Two"), new SessionStatusRunning({ turn: 2 })),
				Story.when(start(2)),
				Story.then(session, new SpanModelRequestStart({ model_request_start_id: "req_2" })),
				Story.when(
					new InterruptModelRequest({
						session_id: session.id,
						turn: 2,
						request_seq: 1,
						model_request_start_id: "req_2",
						model_usage: usage,
					}),
				),
				Story.then(
					session,
					end(2, true),
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 2, event_ids: "[]" }),
				),
				Story.state(session, { _tag: "Idle", turn: 2 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Three" })),
				Story.then(session, text("Three"), new SessionStatusRunning({ turn: 3 })),
				Story.when(start(3)),
				Story.then(session, new SpanModelRequestStart({ model_request_start_id: "req_3" })),
				Story.when(
					new FailModelRequest({
						session_id: session.id,
						turn: 3,
						request_seq: 1,
						model_request_start_id: "req_3",
						model_usage: usage,
						error_type: "model_request_failed_error",
						message: "429 rate limit",
						disposition: "exhausted",
					}),
				),
				Story.then(
					session,
					end(3, true),
					new SessionErrorEvent({
						error: {
							type: "model_request_failed_error",
							message: "429 rate limit",
							retry_status: { type: "exhausted" },
						},
					}),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 3,
						event_ids: "[]",
					}),
				),
				Story.state(session, { _tag: "Idle", turn: 3 }),
				Story.view(TurnInput, session, { turn: 3 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Four" })),
				Story.then(session, text("Four"), new SessionStatusRunning({ turn: 4 })),
				Story.state(session, { _tag: "Running", turn: 4 }),
				Story.view(TurnInput, session, {
					turn: 4,
					input: ["Four"],
					last_reply_turn: 1,
				}),
			)
		},
	)

	it.effect("ends a turn whose reply was truncated and runs the next one", () => {
		const session = Session.ref("sess_turns_truncated")
		const req1 = `${turnKey(session.id, 1)}:req:1`
		const req2 = `${turnKey(session.id, 2)}:req:1`
		return fullStory(
			Story.clock(t0),
			Story.given(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Long" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Long" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(Harness.runTurn, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.runTurn, {
				thinking: null,
				text: "Cut short",
				truncated: true,
				input_tokens: 5,
				output_tokens: 2,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Cut short" }], truncated: true }),
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 5, output_tokens: 2 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 1 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.state(session, { _tag: "Idle", turn: 1 }),
			Story.view(TurnInput, session, { turn: 1, input: [] }),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Continue" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Continue" }] }),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.state(session, { _tag: "Running", turn: 2 }),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				turn: 2,
				input: ["Continue"],
			}),
			Story.succeed(Harness.runTurn, {
				thinking: null,
				text: "The rest",
				input_tokens: 6,
				output_tokens: 3,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "The rest" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 6, output_tokens: 3 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 2 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.state(session, { _tag: "Idle", turn: 2 }),
			Story.view(TurnInput, session, { turn: 2 }),
		)
	})

	it.effect("starts the next turn in the same commit when a queued message drains", () => {
		const session = Session.ref("sess_turns_drain")
		const usage = { input_tokens: 1, output_tokens: 1 }
		const text = (value: string) => new UserMessage({ content: [{ type: "text", text: value }] })
		const start = (turn: number) =>
			new RecordModelRequestStart({
				session_id: session.id,
				turn,
				request_seq: 1,
				model_request_start_id: `req_${turn}`,
			})
		const commit = (turn: number, truncated: boolean) =>
			new CommitModelReply({
				session_id: session.id,
				turn,
				request_seq: 1,
				model_request_start_id: `req_${turn}`,
				thinking: null,
				text: "Reply",
				...(truncated ? { truncated: true as const } : {}),
				model_usage: usage,
				stop_reason: { type: "end_turn" },
			})
		const end = (turn: number) =>
			new SpanModelRequestEnd({
				model_request_start_id: `req_${turn}`,
				model_usage: usage,
				is_error: false,
			})
		return story(
			Story.given(
				session,
				createdEvent,
				text("One"),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: "req_1" }),
				text("Two"),
			),
			Story.when(commit(1, false)),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Reply" }] }),
				end(1),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
				new SessionStatusRunning({ turn: 2 }),
			),
			Story.state(session, { _tag: "Running", turn: 2 }),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Three" })),
			Story.then(session, text("Three")),
			Story.when(start(2)),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "req_2" })),
			Story.when(commit(2, true)),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Reply" }], truncated: true }),
				end(2),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
				new SessionStatusRunning({ turn: 3 }),
			),
			Story.state(session, { _tag: "Running", turn: 3 }),
			Story.view(TurnInput, session, { turn: 3, input: ["Three"] }),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Four" })),
			Story.then(session, text("Four")),
			Story.when(
				new AbandonTurn({
					segment: 1,
					session_id: session.id,
					turn: 3,
					error_type: "model_request_timeout",
					message: "Model request timed out.",
				}),
			),
			Story.then(
				session,
				new SessionErrorEvent({
					error: {
						type: "model_request_timeout",
						message: "Model request timed out.",
						retry_status: { type: "exhausted" },
					},
				}),
				new TurnAbandoned({ turn: 3 }),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 3,
					event_ids: "[]",
				}),
				new SessionStatusRunning({ turn: 4 }),
			),
			Story.state(session, { _tag: "Running", turn: 4 }),
			Story.view(TurnInput, session, { turn: 4, input: ["Four"] }),
		)
	})

	it.effect("abandons a turn that passes its deadline and runs the next one", () => {
		const session = Session.ref("sess_turns_deadline")
		const turn1Key = turnKey(session.id, 1)
		const req1 = `${turn1Key}:req:1`
		const req2 = `${turnKey(session.id, 2)}:req:1`
		return fullStory(
			Story.clock(t0),
			Story.given(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Slow" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Slow" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call("slow", Harness.runTurn, {
				session_id: session.id,
				turn: 1,
				last_reply_turn: 0,
			}),
			Story.advance("10 minutes"),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionErrorEvent({
					error: {
						type: "model_request_timeout",
						message: "Model request timed out.",
						retry_status: { type: "exhausted" },
					},
				}),
				new TurnAbandoned({ turn: 1 }),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					event_ids: "[]",
				}),
			),
			Story.state(session, { _tag: "Idle", turn: 1 }),
			Story.view(TurnInput, session, {
				turn: 1,
				input: [],
				last_reply_turn: 0,
			}),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.fail("slow", Harness.runTurn, { _tag: "TurnInterrupted" }),
			Story.then(session),
			Story.saga(RunTurn, turn1Key, { _tag: "Completed", result: { status: "aborted" } }),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Next" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Next" }] }),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				turn: 2,
				input: ["Next"],
				last_reply_turn: 0,
			}),
			Story.succeed(Harness.runTurn, {
				thinking: null,
				text: "Fresh",
				input_tokens: 3,
				output_tokens: 1,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Fresh" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 3, output_tokens: 1 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 2 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.state(session, { _tag: "Idle", turn: 2 }),
			Story.view(TurnInput, session, { last_reply_turn: 2 }),
		)
	})

	it.effect("interrupts an unreachable turn that drains straight into its successor", () => {
		const session = Session.ref("sess_turns_unreachable_drain")
		const turn1Key = turnKey(session.id, 1)
		const req1 = `${turn1Key}:req:1`
		const req2 = `${turnKey(session.id, 2)}:req:1`
		return fullStory(
			Story.clock(t0),
			Story.given(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "First" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "First" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call("first", Harness.runTurn, {
				session_id: session.id,
				turn: 1,
			}),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Queued" })),
			Story.then(session, new UserMessage({ content: [{ type: "text", text: "Queued" }] })),
			Story.replied({ turn: 2 }),
			Story.fail("first", Harness.runTurn, { _tag: "HarnessUnavailable" }),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionErrorEvent({
					error: {
						type: "harness_unavailable",
						message: "The agent runtime could not be reached.",
						retry_status: { type: "exhausted" },
					},
				}),
				new TurnAbandoned({ turn: 1 }),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					event_ids: "[]",
				}),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.saga(RunTurn, turn1Key, { _tag: "Completed", result: { status: "failed" } }),
			Story.state(session, { _tag: "Running", turn: 2 }),
			Story.view(TurnInput, session, { turn: 2, input: ["Queued"] }),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.call("second", Harness.runTurn, {
				session_id: session.id,
				turn: 2,
				input: ["Queued"],
			}),
			Story.succeed("second", Harness.runTurn, {
				thinking: null,
				text: "Fresh",
				input_tokens: 3,
				output_tokens: 1,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Fresh" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 3, output_tokens: 1 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 2 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.state(session, { _tag: "Idle", turn: 2 }),
			Story.view(TurnInput, session, { turn: 2 }),
		)
	})

	it.effect(
		"starts the successor and fires its deadline while an older interrupt is outstanding",
		() => {
			const session = Session.ref("sess_blocked_interrupt")
			const firstRequest = turnKey(session.id, 1) + ":req:1"
			const secondRequest = turnKey(session.id, 2) + ":req:1"
			return fullStory(
				Story.clock(t0),
				Story.given(session, createdEvent),
				Story.when(new SendUserMessage({ session_id: session.id, text: "First" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "First" }] }),
					new SessionStatusRunning({ turn: 1 }),
					new SpanModelRequestStart({ model_request_start_id: firstRequest }),
				),
				Story.call("first", Harness.runTurn, { turn: 1 }),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt({ segment: 1, turn: 1 })),
				Story.call("slow-interrupt", Harness.interrupt, { turn: 1 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Next" })),
				Story.then(session, new UserMessage({ content: [{ type: "text", text: "Next" }] })),
				Story.fail("first", Harness.runTurn, { _tag: "TurnInterrupted" }),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: firstRequest,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 1, event_ids: "[]" }),
					new SessionStatusRunning({ turn: 2 }),
					new SpanModelRequestStart({ model_request_start_id: secondRequest }),
				),
				Story.call("second", Harness.runTurn, { turn: 2, input: ["Next"] }),
				Story.advance("10 minutes"),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: secondRequest,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionErrorEvent({
						error: {
							type: "model_request_timeout",
							message: "Model request timed out.",
							retry_status: { type: "exhausted" },
						},
					}),
					new TurnAbandoned({ turn: 2 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 2,
						event_ids: "[]",
					}),
				),
				Story.state(session, { _tag: "Idle", turn: 2 }),
				Story.call("deadline", Harness.interrupt, { turn: 2 }),
				Story.succeed("deadline", Harness.interrupt, undefined),
				Story.fail("slow-interrupt", Harness.interrupt, { _tag: "HarnessUnavailable" }),
				Story.call("again", Harness.interrupt, { turn: 1 }),
				Story.succeed("again", Harness.interrupt, undefined),
				Story.fail("second", Harness.runTurn, { _tag: "TurnInterrupted" }),
				Story.state(session, { _tag: "Idle", turn: 2 }),
			)
		},
	)

	it.effect("abandons a running turn whether or not its model request has opened", () => {
		const unopened = Session.ref("sess_abandon_unopened")
		const opened = Session.ref("sess_abandon_opened")
		const req1 = "sess_abandon_opened:turn:1:req:1"
		const error = new SessionErrorEvent({
			error: {
				type: "operator_abandonment",
				message: "The agent runtime could not be reached.",
				retry_status: { type: "exhausted" },
			},
		})
		const abandon = (session_id: typeof unopened.id) =>
			new AbandonTurn({
				segment: 1,
				session_id,
				turn: 1,
				error_type: "operator_abandonment",
				message: "The agent runtime could not be reached.",
			})
		return story(
			Story.given(unopened, createdEvent),
			Story.when(new SendUserMessage({ session_id: unopened.id, text: "Run" })),
			Story.then(
				unopened,
				new UserMessage({ content: [{ type: "text", text: "Run" }] }),
				new SessionStatusRunning({ turn: 1 }),
			),
			Story.when(abandon(unopened.id)),
			Story.then(
				unopened,
				error,
				new TurnAbandoned({ turn: 1 }),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					event_ids: "[]",
				}),
			),
			Story.when(
				new RecordModelRequestStart({
					session_id: unopened.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "late",
				}),
			),
			Story.rejected(new SessionNotRunning({ session_id: unopened.id, status: "idle" })),

			Story.given(opened, createdEvent),
			Story.when(new SendUserMessage({ session_id: opened.id, text: "Run" })),
			Story.then(
				opened,
				new UserMessage({ content: [{ type: "text", text: "Run" }] }),
				new SessionStatusRunning({ turn: 1 }),
			),
			Story.when(
				new RecordModelRequestStart({
					session_id: opened.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: req1,
				}),
			),
			Story.then(opened, new SpanModelRequestStart({ model_request_start_id: req1 })),
			Story.when(abandon(opened.id)),
			Story.then(
				opened,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				error,
				new TurnAbandoned({ turn: 1 }),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					event_ids: "[]",
				}),
			),
			Story.state(opened, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect(
		"settles a timed-out turn, runs its successor during the outage, and retries the original abort",
		() => {
			const session = Session.ref("sess_e2e_deadline")
			const turn1Key = turnKey(session.id, 1)
			const turn2Key = turnKey(session.id, 2)
			const req1 = `${turn1Key}:req:1`
			const req2 = `${turn2Key}:req:1`
			return redeliveryStory(
				Story.clock(t0),
				Story.when(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				),
				Story.then(session, createdEvent),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Slow" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Slow" }] }),
					new SessionStatusRunning({ turn: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call("turn-1", Harness.runTurn, {
					session_id: session.id,
					turn: 1,
				}),
				Story.advance("10 minutes"),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionErrorEvent({
						error: {
							type: "model_request_timeout",
							message: "Model request timed out.",
							retry_status: { type: "exhausted" },
						},
					}),
					new TurnAbandoned({ turn: 1 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 1,
						event_ids: "[]",
					}),
				),
				Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
				Story.fail(Harness.interrupt, { _tag: "HarnessUnavailable" }),
				Story.call("redelivery", Harness.interrupt, {
					session_id: session.id,
					turn: 1,
				}),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Next" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Next" }] }),
					new SessionStatusRunning({ turn: 2 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.call("turn-2", Harness.runTurn, {
					session_id: session.id,
					turn: 2,
				}),
				Story.succeed("turn-2", Harness.runTurn, {
					thinking: null,
					text: "Fresh",
					input_tokens: 3,
					output_tokens: 1,
					stop_reason: { type: "end_turn" },
				}),
				Story.then(
					session,
					new AgentMessage({ content: [{ type: "text", text: "Fresh" }] }),
					new SpanModelRequestEnd({
						model_request_start_id: req2,
						model_usage: { input_tokens: 3, output_tokens: 1 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
				),
				Story.call(OutputsSaver.save, { session_id: session.id, turn: 2 }),
				Story.succeed(OutputsSaver.save, undefined),
				Story.state(session, { _tag: "Idle", turn: 2 }),
				Story.succeed("redelivery", Harness.interrupt, undefined),
				Story.succeed("turn-1", Harness.runTurn, {
					thinking: null,
					text: "Too late",
					input_tokens: 4,
					output_tokens: 2,
					stop_reason: { type: "end_turn" },
				}),
				Story.then(session),
				Story.saga(RunTurn, turn1Key, { _tag: "Completed", result: { status: "aborted" } }),
				Story.state(session, { _tag: "Idle", turn: 2 }),
			)
		},
	)

	it("cancels the active deadline on completion and archive before it fires", async () => {
		const memory = InMemory.make({ manual: true })
		const handlers = Layer.mergeAll(
			StartTurnLive,
			EnsureTurnStoppedLive,
			SaveSessionOutputsLive,
			RunTurn.toLayer(Effect.succeed(() => Effect.succeed({ status: "completed" as const }))),
		)
		const state = await Effect.runPromise(
			Effect.gen(function* () {
				const sessions = yield* Session
				const session = Session.ref("sess_deadline_cleanup")
				yield* sessions.send(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				)
				yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Quick" }))
				yield* memory.control.drain
				yield* sessions.send(
					new RecordModelRequestStart({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: "req_1",
					}),
				)
				yield* sessions.send(
					new CommitModelReply({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: "req_1",
						thinking: null,
						text: "Done",
						model_usage: { input_tokens: 1, output_tokens: 1 },
						stop_reason: { type: "end_turn" },
					}),
				)
				yield* memory.control.drain
				const completed = yield* sessions.get(session)
				const afterCompletion = yield* Effect.match(sessions.unschedule(session, "turn-deadline"), {
					onSuccess: () => "WasPending",
					onFailure: (err) => err._tag,
				})
				yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Another" }))
				yield* sessions.send(new ArchiveSession({ session_id: session.id }))
				yield* memory.control.drain
				const archived = yield* sessions.get(session)
				const afterArchive = yield* Effect.match(sessions.unschedule(session, "turn-deadline"), {
					onSuccess: () => "WasPending",
					onFailure: (err) => err._tag,
				})
				return {
					completed,
					archived,
					afterCompletion,
					afterArchive,
				}
			}).pipe(
				Effect.provide(
					Sessions.layer(handlers).pipe(
						Layer.provide(Layer.mergeAll(memory.layer, HarnessNoopLayer, OutputsUnsaved)),
					),
				),
			),
		)
		expect(state).toEqual({
			completed: { _tag: "Idle", turn: 1 },
			archived: { _tag: "Terminated", archived: true },
			afterCompletion: "AlreadyCancelled",
			afterArchive: "AlreadyCancelled",
		})
	})

	it.effect("publishes a reply the harness finished before the interrupt took effect", () => {
		const session = Session.ref("sess_e2e_interrupt_late")
		const turn1Key = turnKey(session.id, 1)
		const req1 = `${turn1Key}:req:1`
		return fullStory(
			Story.clock(t0),
			Story.when(
				new CreateSession({
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: null,
				}),
			),
			Story.then(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Almost done" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Almost done" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
			}),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.then(session, new UserInterrupt({ segment: 1, turn: 1 })),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.succeed(Harness.runTurn, {
				thinking: null,
				text: "Finished anyway",
				input_tokens: 12,
				output_tokens: 6,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Finished anyway" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 12, output_tokens: 6 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 1 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.saga(RunTurn, turn1Key, {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect("rejects queued user messages beyond the 8-message pending queue limit", () => {
		const session = Session.ref("sess_queue_limit")
		const queued = Array.from(
			{ length: 8 },
			(_, idx) => new UserMessage({ content: [{ type: "text", text: `Queued ${idx + 1}` }] }),
		)
		return story(
			Story.given(
				session,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "Initial" }] }),
				new SessionStatusRunning({ turn: 1 }),
				...queued,
			),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Overflow" })),
			Story.rejected(new PendingMessageQueueFull({ session_id: session.id, limit: 8 })),
		)
	})

	it.effect("drains a queued follow-up message after a nonterminal provider failure", () => {
		const session = Session.ref("sess_e2e_drain_after_error")
		const turn1Key = turnKey(session.id, 1)
		const turn2Key = turnKey(session.id, 2)
		const req1 = `${turn1Key}:req:1`
		const req2 = `${turn2Key}:req:1`
		return fullStory(
			Story.clock(t0),
			Story.when(
				new CreateSession({
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: null,
				}),
			),
			Story.then(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "First" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "First" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
			}),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Queued during error" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Queued during error" }] }),
			),
			Story.fail(Harness.runTurn, {
				_tag: "TurnFailed",
				error_type: "model_request_failed_error",
				message: "429 rate limited",
				terminal: false,
			}),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionErrorEvent({
					error: {
						type: "model_request_failed_error",
						message: "429 rate limited",
						retry_status: { type: "exhausted" },
					},
				}),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					event_ids: "[]",
				}),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.saga(RunTurn, turn1Key, {
				_tag: "Completed",
				result: { status: "failed" },
			}),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 2,
			}),
			Story.succeed(Harness.runTurn, {
				thinking: null,
				text: "Recovered reply",
				input_tokens: 6,
				output_tokens: 3,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Recovered reply" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 6, output_tokens: 3 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
			),
			Story.call(OutputsSaver.save, { session_id: session.id, turn: 2 }),
			Story.succeed(OutputsSaver.save, undefined),
			Story.saga(RunTurn, turn2Key, {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.state(session, { _tag: "Idle", turn: 2 }),
		)
	})

	it("aborts RunTurn without calling Harness when another caller owns request 1 even with the same request ID", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sessions = yield* Session
				const runs = yield* RunTurn
				const session = Session.ref("sess_e2e_conflict")
				const deterministicReqId = `${turnKey(session.id, 1)}:req:1`
				yield* sessions.send(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				)
				yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Hello" }))
				yield* sessions.send(
					new RecordModelRequestStart({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: deterministicReqId,
					}),
				)
				const run = yield* runs.start(turnKey(session.id, 1), {
					last_reply_turn: 0,
					segment: 1,
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					resources: [],
					turn: 1,
					input: ["Hello"],
				})
				return yield* run.result
			}).pipe(
				Effect.provide(
					Sessions.layer(Layer.mergeAll(StartTurnNoopLayer, RunTurnLive)).pipe(
						Layer.provide(
							Layer.mergeAll(
								Domain.InMemory,
								Harness.toLayer(
									Effect.succeed({
										interrupt: () => Effect.void,
										discardWorkspace: () => Effect.void,
										storeRepositoryToken: () => Effect.void,
										runTurn: () => Effect.die("Harness.runTurn must not be called"),
									}),
								),
							),
						),
					),
				),
			),
		)
		expect(result).toEqual({ status: "aborted" })
	})

	it("aborts RunTurn without calling Harness when another worker owns the same request ID at sequence 2", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sessions = yield* Session
				const runs = yield* RunTurn
				const session = Session.ref("sess_e2e_reused_id_seq2")
				const expectedReqId = `${turnKey(session.id, 1)}:req:1`
				yield* sessions.send(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				)
				yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Hello" }))
				const foreign = yield* sessions.send(
					new RecordModelRequestStart({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: "foreign_req_1",
					}),
				)
				yield* sessions.import(
					session,
					[
						new SpanModelRequestEnd({
							model_request_start_id: "foreign_req_1",
							model_usage: { input_tokens: 1, output_tokens: 1 },
							is_error: false,
						}),
					],
					{ commandId: "foreign_req_1:end", expectedVersion: foreign.version },
				)
				yield* sessions.send(
					new RecordModelRequestStart({
						session_id: session.id,
						turn: 1,
						request_seq: 2,
						model_request_start_id: expectedReqId,
					}),
				)
				const run = yield* runs.start(turnKey(session.id, 1), {
					last_reply_turn: 0,
					segment: 1,
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					resources: [],
					turn: 1,
					input: ["Hello"],
				})
				return yield* run.result
			}).pipe(
				Effect.provide(
					Sessions.layer(Layer.mergeAll(StartTurnNoopLayer, RunTurnLive)).pipe(
						Layer.provide(
							Layer.mergeAll(
								Domain.InMemory,
								Harness.toLayer(
									Effect.succeed({
										interrupt: () => Effect.void,
										discardWorkspace: () => Effect.void,
										storeRepositoryToken: () => Effect.void,
										runTurn: () => Effect.die("Harness.runTurn must not be called"),
									}),
								),
							),
						),
					),
				),
			),
		)
		expect(result).toEqual({ status: "aborted" })
	})

	it.effect(
		"discards the workspace of a terminated session, asking again until the harness answers",
		() => {
			const session = Session.ref("sess_discard_workspace")
			return discardStory(
				Story.clock(t0),
				Story.when(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				),
				Story.then(session, createdEvent),
				Story.when(new ArchiveSession({ session_id: session.id })),
				Story.then(
					session,
					new SessionStatusTerminated({ running_turn: null, event_ids: "[]" }),
					new SessionArchived(),
				),
				Story.call(Harness.discardWorkspace, { session_id: session.id }),
				Story.die(Harness.discardWorkspace, new Error("harness unreachable")),
				Story.call(Harness.discardWorkspace, { session_id: session.id }),
				Story.succeed(Harness.discardWorkspace, undefined),
				Story.when(new ArchiveSession({ session_id: session.id })),
				Story.then(session),
				Story.state(session, { _tag: "Terminated", archived: true }),
			)
		},
	)

	it.effect("retries cancellation of the archived request when the harness is unavailable", () => {
		const session = Session.ref("sess_e2e_archive")
		const turn1Key = turnKey(session.id, 1)
		const req1 = `${turn1Key}:req:1`
		return redeliveryStory(
			Story.clock(t0),
			Story.when(
				new CreateSession({
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: null,
				}),
			),
			Story.then(session, createdEvent),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Work" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Work" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(Harness.runTurn, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
			}),
			Story.clock(t1),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionStatusTerminated({ running_turn: 1, event_ids: "[]" }),
				new SessionArchived(),
			),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.fail(Harness.interrupt, { _tag: "HarnessUnavailable" }),
			Story.call(Harness.discardWorkspace, { session_id: session.id }),
			Story.succeed(Harness.discardWorkspace, undefined),
			Story.state(session, { _tag: "Terminated", archived: true }),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.succeed(Harness.runTurn, {
				thinking: null,
				text: "Late reply",
				input_tokens: 5,
				output_tokens: 3,
				stop_reason: { type: "end_turn" },
			}),
			Story.then(session),
			Story.saga(RunTurn, turn1Key, {
				_tag: "Completed",
				result: { status: "aborted" },
			}),
			Story.emitted(SessionView, session, [
				new UserMessage({ content: [{ type: "text", text: "Work" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionStatusTerminated({ running_turn: 1, event_ids: "[]" }),
				new SessionArchived(),
			]),
			Story.view(SessionView, session, {
				id: session.id,
				type: "session",
				status: "terminated",
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				title: null,
				turn: 1,
				usage: { input_tokens: 0, output_tokens: 0 },
				created_at: t0,
				updated_at: t1,
				archived_at: t1,
			}),
		)
	})

	it.effect(
		"aborts a stale terminal failure when another request replaced request 1 in the same turn",
		() => {
			const session = Session.ref("sess_e2e_stale_failure")
			const turn1Key = turnKey(session.id, 1)
			const req1 = `${turn1Key}:req:1`
			return fullStory(
				Story.clock(t0),
				Story.when(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				),
				Story.then(session, createdEvent),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Race" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Race" }] }),
					new SessionStatusRunning({ turn: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(Harness.runTurn, {
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					turn: 1,
				}),
				Story.given(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 1, output_tokens: 1 },
						is_error: false,
					}),
				),
				Story.when(
					new RecordModelRequestStart({
						session_id: session.id,
						turn: 1,
						request_seq: 2,
						model_request_start_id: "other_req_2",
					}),
				),
				Story.then(session, new SpanModelRequestStart({ model_request_start_id: "other_req_2" })),
				Story.fail(Harness.runTurn, {
					_tag: "TurnFailed",
					error_type: "invalid_api_key_error",
					message: "stale terminal failure",
					terminal: true,
				}),
				Story.then(session),
				Story.saga(RunTurn, turn1Key, {
					_tag: "Completed",
					result: { status: "aborted" },
				}),
				Story.state(session, {
					_tag: "Running",
					turn: 1,
					open_model_request_id: "other_req_2",
					model_requests_started: 2,
					pending_user_messages: 0,
				}),
			)
		},
	)

	it.effect(
		"preserves non-end_turn provider stop reasons like refusal without auto-draining queued messages",
		() => {
			const session = Session.ref("sess_e2e_refusal")
			const turn1Key = turnKey(session.id, 1)
			const req1 = `${turn1Key}:req:1`
			return fullStory(
				Story.clock(t0),
				Story.when(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				),
				Story.then(session, createdEvent),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Disallowed" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Disallowed" }] }),
					new SessionStatusRunning({ turn: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(Harness.runTurn, {
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					turn: 1,
				}),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Queued after refusal" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Queued after refusal" }] }),
				),
				Story.succeed(Harness.runTurn, {
					thinking: null,
					text: "I cannot assist with that.",
					input_tokens: 4,
					output_tokens: 6,
					stop_reason: { type: "refusal" },
				}),
				Story.then(
					session,
					new AgentMessage({ content: [{ type: "text", text: "I cannot assist with that." }] }),
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 4, output_tokens: 6 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "refusal" }, turn: 1, event_ids: "[]" }),
				),
				Story.call(OutputsSaver.save, { session_id: session.id, turn: 1 }),
				Story.succeed(OutputsSaver.save, undefined),
				Story.saga(RunTurn, turn1Key, {
					_tag: "Completed",
					result: { status: "completed" },
				}),
				Story.state(session, { _tag: "Idle", turn: 1 }),
			)
		},
	)

	it("round-trips current session snapshots and rejects unknown versions", () => {
		const encode = Schema.encodeSync(SessionStateSnapshot)
		const decode = Schema.decodeUnknownSync(SessionStateSnapshot)
		const running = {
			_tag: "Running" as const,
			turn: 1,
			open_model_request_id: "req_1",
			model_requests_started: 1,
			pending_user_messages: 2,
			awaiting_calls: 1,
			awaiting_ids: '["tu_1"]',
			paused: false,
			asked_calls: 1,
			interrupted: false,
		}
		const wire = encode(running)
		expect(wire).toEqual({ schema_version: SESSION_STATE_SCHEMA_VERSION, state: running })
		expect(decode(wire)).toEqual(running)
		expect(
			Exit.isFailure(
				Schema.decodeExit(SessionStateSnapshot)({
					schema_version: SESSION_STATE_SCHEMA_VERSION + 1,
					state: { _tag: "Idle", turn: 0 },
				}),
			),
		).toBe(true)
	})

	it.effect("hands each turn the user messages no earlier turn was given", () => {
		const session = Session.ref("sess_turn_input")
		const text = (value: string) => new UserMessage({ content: [{ type: "text", text: value }] })
		return story(
			Story.clock(t0),
			Story.given(session, createdEvent, text("First"), new SessionStatusRunning({ turn: 1 })),
			Story.view(TurnInput, session, {
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
				input: ["First"],
				unsent: [],
			}),
			Story.given(session, text("Queued A"), text("Queued B")),
			Story.view(TurnInput, session, {
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
				input: ["First"],
				unsent: ["Queued A", "Queued B"],
			}),
			Story.given(
				session,
				new SessionStatusIdle({ stop_reason: { type: "refusal" }, turn: 1, event_ids: "[]" }),
				text("After refusal"),
				new SessionStatusRunning({ turn: 2 }),
			),
			Story.view(TurnInput, session, {
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 2,
				input: ["Queued A", "Queued B", "After refusal"],
				unsent: [],
			}),
		)
	})

	it("round-trips transforming fields like Schema.FiniteFromString once in versionedSnapshot", () => {
		const TransformedSnapshot = versionedSnapshot({
			current: 1,
			schema: Schema.Struct({ count: Schema.FiniteFromString }),
		})
		const encode = Schema.encodeSync(TransformedSnapshot)
		const decode = Schema.decodeUnknownSync(TransformedSnapshot)

		expect(encode({ count: 3 })).toEqual({
			schema_version: 1,
			state: { count: "3" },
		})
		expect(decode({ schema_version: 1, state: { count: "3" } })).toEqual({ count: 3 })
	})

	it("clamps oversized raw provider thinking and failure metadata before external schema validation so RunTurn checkpoints cleanly", async () => {
		let callCount = 0
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const sessions = yield* Session
				const runs = yield* RunTurn
				const views = yield* SessionView
				const session = Session.ref("sess_clamp_provider")
				yield* sessions.send(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				)
				yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Think big" }))
				const turn1 = yield* runs.get(turnKey(session.id, 1)).result
				yield* views.waitFor(session, { status: "idle", turn: 1 }, { timeout: "5 seconds" })

				yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Fail big" }))
				const turn2 = yield* runs.get(turnKey(session.id, 2)).result
				yield* views.waitFor(session, { status: "idle", turn: 2 }, { timeout: "5 seconds" })

				yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Empty reply" }))
				const turn3 = yield* runs.get(turnKey(session.id, 3)).result
				yield* views.waitFor(session, { status: "idle", turn: 3 }, { timeout: "5 seconds" })

				const page = yield* views.list(session)
				const thinkingEvent = page.entries.find((e) => e.event._tag === "agent.thinking")
				const agentMessages = page.entries.filter((e) => e.event._tag === "agent.message")
				const errorEvents = page.entries.filter((e) => e.event._tag === "session.error")
				const firstError = errorEvents[0]
				const secondError = errorEvents[1]
				return {
					turn1,
					turn2,
					turn3,
					agentMessageCount: agentMessages.length,
					usage: page.entries.at(-1)?.state?.usage,
					thinkingLength:
						thinkingEvent?.event._tag === "agent.thinking"
							? thinkingEvent.event.thinking.length
							: 0,
					errorTypeLength:
						firstError?.event._tag === "session.error" ? firstError.event.error.type.length : 0,
					errorMessageLength:
						firstError?.event._tag === "session.error" ? firstError.event.error.message.length : 0,
					emptyReplyErrorType:
						secondError?.event._tag === "session.error" ? secondError.event.error.type : null,
				}
			}).pipe(
				Effect.provide(
					Sessions.layer(SessionsHandlersLive).pipe(
						Layer.provide(
							Layer.mergeAll(
								Domain.InMemory,
								OutputsUnsaved,
								boundedHarness(
									Effect.succeed({
										interrupt: () => Effect.void,
										discardWorkspace: () => Effect.void,
										storeRepositoryToken: () => Effect.void,
										runTurn: () => {
											callCount += 1
											if (callCount === 1) {
												return Effect.succeed({
													thinking: "t".repeat(MAX_THINKING_TEXT_LENGTH + 2000),
													text: "Bounded reply",
													input_tokens: 10,
													output_tokens: 5,
													stop_reason: { type: "end_turn" as const },
												})
											}
											if (callCount === 2) {
												return Effect.fail({
													_tag: "TurnFailed" as const,
													error_type: "e".repeat(MAX_ERROR_TYPE_LENGTH + 100),
													message: "m".repeat(MAX_ERROR_MESSAGE_LENGTH + 1000),
													terminal: false,
												})
											}
											return Effect.succeed({
												thinking: null,
												text: "",
												input_tokens: 4,
												output_tokens: 0,
												stop_reason: { type: "end_turn" as const },
											})
										},
									}),
								),
							),
						),
					),
				),
			),
		)
		expect(outcome).toEqual({
			turn1: { status: "completed" },
			turn2: { status: "failed" },
			turn3: { status: "failed" },
			agentMessageCount: 1,
			usage: { input_tokens: 14, output_tokens: 5 },
			thinkingLength: MAX_THINKING_TEXT_LENGTH,
			errorTypeLength: MAX_ERROR_TYPE_LENGTH,
			errorMessageLength: MAX_ERROR_MESSAGE_LENGTH,
			emptyReplyErrorType: "empty_model_reply",
		})
	})

	it("keeps the worst-case JSON-escaped turn input row, workflow input, and activity checkpoints below 2 MiB", () => {
		const DO_ROW_LIMIT_BYTES = 2 * 1024 * 1024
		const WORKFLOW_ENVELOPE_HEADROOM_BYTES = 64 * 1024
		const MAX_CHECKPOINT_BYTES = DO_ROW_LIMIT_BYTES - WORKFLOW_ENVELOPE_HEADROOM_BYTES
		const utf8Bytes = (value: string): number => {
			let bytes = 0
			for (let i = 0; i < value.length; i++) {
				const code = value.charCodeAt(i)
				if (code < 0x80) {
					bytes += 1
				} else if (code < 0x8_00) {
					bytes += 2
				} else if (code >= 0xd8_00 && code <= 0xdb_ff) {
					bytes += 4
					i++
				} else {
					bytes += 3
				}
			}
			return bytes
		}
		const worstCaseId = "\u0000".repeat(MAX_IDENTIFIER_LENGTH)
		const worstCaseText = "\u0000".repeat(MAX_MESSAGE_TEXT_LENGTH)
		const queued = Array.from({ length: 8 }, () => worstCaseText)
		const turnInput = [...queued, worstCaseText]
		const runTurnPayloadBytes = utf8Bytes(
			JSON.stringify({
				session_id: worstCaseId,
				agent_id: worstCaseId,
				agent_version: 1,
				environment_id: worstCaseId,
				turn: 1,
				input: turnInput,
			}),
		)
		const turnInputRowBytes = utf8Bytes(
			JSON.stringify({
				agent_id: worstCaseId,
				agent_version: 1,
				environment_id: worstCaseId,
				turn: 1,
				input: turnInput,
				unsent: queued,
			}),
		)
		const successCheckpointBytes = utf8Bytes(
			JSON.stringify({
				_tag: "Success",
				value: {
					ok: true,
					thinking: "\u0000".repeat(MAX_THINKING_TEXT_LENGTH),
					text: "\u0000".repeat(MAX_MESSAGE_TEXT_LENGTH),
					input_tokens: 999_999,
					output_tokens: 999_999,
					stop_reason: { type: "end_turn" },
				},
			}),
		)
		const failureCheckpointBytes = utf8Bytes(
			JSON.stringify({
				_tag: "Success",
				value: {
					ok: false,
					error_type: "\u0000".repeat(MAX_ERROR_TYPE_LENGTH),
					message: "\u0000".repeat(MAX_ERROR_MESSAGE_LENGTH),
					terminal: true,
				},
			}),
		)
		expect(runTurnPayloadBytes).toBeLessThan(MAX_CHECKPOINT_BYTES)
		expect(turnInputRowBytes).toBeLessThan(MAX_CHECKPOINT_BYTES)
		expect(successCheckpointBytes).toBeLessThan(MAX_CHECKPOINT_BYTES)
		expect(failureCheckpointBytes).toBeLessThan(MAX_CHECKPOINT_BYTES)
	})

	it.effect(
		"records a call's use and result together, and only while the turn's model request is open",
		() => {
			const session = Session.ref("sess_tools_1")
			const call: ToolCall = {
				tool_use_id: toolUseId(1, 1),
				name: "read",
				input: { path: "/workspace/a.md" },
				content: [{ type: "text", text: "# A" }],
				is_error: false,
				result_truncated: true,
			}
			const record = (model_request_start_id: string) =>
				new RecordToolCall({ session_id: session.id, turn: 1, model_request_start_id, call })
			return story(
				Story.given(
					session,
					createdEvent,
					new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
					new SessionStatusRunning({ turn: 1 }),
				),
				Story.when(record("req_1")),
				Story.rejected(
					new UnknownModelRequest({ session_id: session.id, model_request_start_id: "req_1" }),
				),
				Story.when(
					new RecordModelRequestStart({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: "req_1",
					}),
				),
				Story.then(session, new SpanModelRequestStart({ model_request_start_id: "req_1" })),
				Story.when(record("req_1")),
				Story.then(
					session,
					new AgentToolUse({
						tool_use_id: toolUseId(1, 1),
						name: "read",
						input: { path: "/workspace/a.md" },
					}),
					new AgentToolResult({
						tool_use_id: toolUseId(1, 1),
						content: [{ type: "text", text: "# A" }],
						is_error: false,
						truncated: true,
					}),
				),
				Story.when(record("req_other")),
				Story.rejected(
					new UnknownModelRequest({ session_id: session.id, model_request_start_id: "req_other" }),
				),
				Story.when(
					new CommitModelReply({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: "req_1",
						thinking: null,
						text: "Done",
						model_usage: { input_tokens: 1, output_tokens: 1 },
						stop_reason: { type: "end_turn" },
					}),
				),
				Story.then(
					session,
					new AgentMessage({ content: [{ type: "text", text: "Done" }] }),
					new SpanModelRequestEnd({
						model_request_start_id: "req_1",
						model_usage: { input_tokens: 1, output_tokens: 1 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
				),
				Story.when(record("req_1")),
				Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			)
		},
	)

	it.effect(
		"records the result of a call whose use is already on the log, only while a model request is open",
		() => {
			const session = Session.ref("sess_tools_result_1")
			const record = (model_request_start_id: string, mcp: boolean) =>
				new RecordToolResult({
					session_id: session.id,
					turn: 1,
					model_request_start_id,
					result: {
						type: "tool_result",
						tool_use_id: toolUseId(1, 4),
						content: [{ type: "text", text: "deployed" }],
						is_error: false,
						truncated: true,
						...(mcp ? { mcp: true as const } : {}),
					},
				})
			const recorded = {
				tool_use_id: toolUseId(1, 4),
				content: [{ type: "text" as const, text: "deployed" }],
				is_error: false,
				truncated: true as const,
			}
			return story(
				Story.given(
					session,
					createdEvent,
					new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
					new SessionStatusRunning({ turn: 1 }),
				),
				Story.when(record("req_1", true)),
				Story.rejected(
					new UnknownModelRequest({ session_id: session.id, model_request_start_id: "req_1" }),
				),
				Story.when(
					new RecordModelRequestStart({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: "req_1",
					}),
				),
				Story.then(session, new SpanModelRequestStart({ model_request_start_id: "req_1" })),
				Story.when(record("req_1", true)),
				Story.then(session, new AgentMcpToolResult(recorded)),
				Story.when(record("req_1", false)),
				Story.then(session, new AgentToolResult(recorded)),
				Story.when(record("req_other", true)),
				Story.rejected(
					new UnknownModelRequest({ session_id: session.id, model_request_start_id: "req_other" }),
				),
			)
		},
	)

	it("publishes a turn's tool events once each, ahead of its reply, and nothing after the turn has ended", async () => {
		const memory = InMemory.make({ manual: true })
		const handlers = Layer.mergeAll(
			StartTurnNoopLayer,
			RunTurn.toLayer(Effect.succeed(() => Effect.succeed({ status: "completed" as const }))),
		)
		const session = Session.ref("sess_tools_2")
		const bounds = boundToolEvents(1)
		bounds.use({ id: "call_1", name: "read", input: { path: "/a" } })
		bounds.result({
			id: "call_1",
			task_id: 4,
			content: [{ type: "text", text: "A" }],
			is_error: false,
		})
		bounds.use({ id: "call_1", name: "read", input: { path: "/b" } })
		bounds.result({
			id: "call_1",
			task_id: 6,
			content: [{ type: "text", text: "B" }],
			is_error: false,
		})
		const events = bounds.events()
		const logged = await Effect.runPromise(
			Effect.gen(function* () {
				const sessions = yield* Session
				const views = yield* SessionView
				yield* sessions.send(
					new CreateSession({
						session_id: session.id,
						agent_id: "agent_001",
						agent_version: 1,
						environment_id: "env_001",
						title: null,
					}),
				)
				yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Go" }))
				const requestId = `${turnKey(session.id, 1)}:req:1`
				yield* sessions.send(
					new RecordModelRequestStart({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: requestId,
					}),
				)
				yield* recordToolEvents({
					segment: 1,
					session_id: session.id,
					turn: 1,
					events: events.slice(0, 2),
				})
				yield* recordToolEvents({ segment: 1, session_id: session.id, turn: 1, events })
				yield* sessions.send(
					new CommitModelReply({
						session_id: session.id,
						turn: 1,
						request_seq: 1,
						model_request_start_id: requestId,
						thinking: null,
						text: "Done",
						model_usage: { input_tokens: 1, output_tokens: 1 },
						stop_reason: { type: "end_turn" },
					}),
				)
				yield* recordToolEvents({
					segment: 1,
					session_id: session.id,
					turn: 1,
					events: [
						{ type: "tool_use", tool_use_id: toolUseId(1, 99), name: "late", input: {} },
						{ type: "tool_result", tool_use_id: toolUseId(1, 99), content: [], is_error: false },
					],
				})
				yield* memory.control.drain
				const page = yield* views.list(session)
				return page.entries.map(({ event }) =>
					"tool_use_id" in event ? `${event._tag}:${event.tool_use_id}` : event._tag,
				)
			}).pipe(
				Effect.provide(
					Sessions.layer(handlers).pipe(
						Layer.provide(Layer.mergeAll(memory.layer, HarnessNoopLayer)),
					),
				),
			),
		)
		expect(logged).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"agent.tool_use:tu_1_4",
			"agent.tool_result:tu_1_4",
			"agent.tool_use:tu_1_6",
			"agent.tool_result:tu_1_6",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
		])
	})

	it("keeps every recorded call whole when the request closes at any point of a settlement", async () => {
		const bounds = boundToolEvents(1)
		for (const task of [1, 2, 3]) {
			bounds.use({ id: `call_${task}`, name: "read", input: { path: `/${task}` } })
			bounds.result({
				id: `call_${task}`,
				task_id: task,
				content: [{ type: "text", text: `${task}` }],
				is_error: false,
			})
		}
		const events = bounds.events()
		const closings = {
			archive: (session_id: SessionId) => new ArchiveSession({ session_id }),
			deadline: (session_id: SessionId) =>
				new AbandonTurn({
					segment: 1,
					session_id,
					turn: 1,
					error_type: "model_request_timeout",
					message: "Model request timed out.",
				}),
		}
		const settle = (closing: keyof typeof closings, recorded: number) => {
			const memory = InMemory.make({ manual: true })
			const handlers = Layer.mergeAll(
				StartTurnNoopLayer,
				RunTurn.toLayer(Effect.succeed(() => Effect.succeed({ status: "completed" as const }))),
			)
			const session = Session.ref(`sess_tools_close_${closing}_${recorded}`)
			return Effect.runPromise(
				Effect.gen(function* () {
					const sessions = yield* Session
					const views = yield* SessionView
					yield* sessions.send(
						new CreateSession({
							session_id: session.id,
							agent_id: "agent_001",
							agent_version: 1,
							environment_id: "env_001",
							title: null,
						}),
					)
					yield* sessions.send(new SendUserMessage({ session_id: session.id, text: "Go" }))
					const requestId = `${turnKey(session.id, 1)}:req:1`
					yield* sessions.send(
						new RecordModelRequestStart({
							session_id: session.id,
							turn: 1,
							request_seq: 1,
							model_request_start_id: requestId,
						}),
					)
					yield* recordToolEvents({
						segment: 1,
						session_id: session.id,
						turn: 1,
						events: events.slice(0, 2 * recorded),
					})
					yield* sessions.send(closings[closing](session.id))
					yield* recordToolEvents({ segment: 1, session_id: session.id, turn: 1, events })
					const reply = yield* Effect.exit(
						sessions.send(
							new CommitModelReply({
								session_id: session.id,
								turn: 1,
								request_seq: 1,
								model_request_start_id: requestId,
								thinking: null,
								text: "Done",
								model_usage: { input_tokens: 1, output_tokens: 1 },
								stop_reason: { type: "end_turn" },
							}),
						),
					)
					yield* memory.control.drain
					const page = yield* views.list(session)
					return {
						replied: reply._tag === "Success",
						log: page.entries.map(({ event }) =>
							"tool_use_id" in event ? `${event._tag}:${event.tool_use_id}` : event._tag,
						),
					}
				}).pipe(
					Effect.provide(
						Sessions.layer(handlers).pipe(
							Layer.provide(Layer.mergeAll(memory.layer, HarnessNoopLayer)),
						),
					),
				),
			)
		}
		for (const closing of ["archive", "deadline"] as const) {
			for (const recorded of [0, 1, 2, 3]) {
				const { replied, log } = await settle(closing, recorded)
				const uses = log.filter((entry) => entry.startsWith("agent.tool_use:"))
				expect(replied).toBe(false)
				expect(log).not.toContain("agent.message")
				expect(uses).toEqual(
					[1, 2, 3].slice(0, recorded).map((task) => `agent.tool_use:${toolUseId(1, task)}`),
				)
				for (const [index, entry] of log.entries()) {
					if (entry.startsWith("agent.tool_use:")) {
						expect(log[index + 1]).toBe(entry.replace("agent.tool_use:", "agent.tool_result:"))
					}
					if (entry.startsWith("agent.tool_result:")) {
						expect(log[index - 1]).toBe(entry.replace("agent.tool_result:", "agent.tool_use:"))
					}
				}
				const closed = log.indexOf("span.model_request_end")
				expect(closed).toBeGreaterThan(-1)
				expect(log.slice(closed).some((entry) => entry.startsWith("agent.tool_"))).toBe(false)
			}
		}
	})

	it("reports a reply cut to the message limit as budget_reached, never as a clean end_turn", async () => {
		const oversized = {
			thinking: null,
			text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1),
			input_tokens: 1,
			output_tokens: 1,
		}
		const cut = await Effect.runPromise(
			clampHarnessReply({ ...oversized, stop_reason: { type: "end_turn" } }),
		)
		expect(cut.text.length).toBe(MAX_MESSAGE_TEXT_LENGTH)
		expect(cut.stop_reason).toEqual({ type: "budget_reached" })

		const refusal = await Effect.runPromise(
			clampHarnessReply({ ...oversized, stop_reason: { type: "refusal" } }),
		)
		expect(refusal.stop_reason).toEqual({ type: "refusal" })

		const whole = await Effect.runPromise(
			clampHarnessReply({ ...oversized, text: "short", stop_reason: { type: "end_turn" } }),
		)
		expect(whole.stop_reason).toEqual({ type: "end_turn" })
	})
})
