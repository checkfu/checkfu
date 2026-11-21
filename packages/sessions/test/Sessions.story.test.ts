import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ArchiveSession, SessionStatusTerminated } from "../src/Session/ArchiveSession.command.ts"
import { CompleteTurn, SessionStatusIdle } from "../src/Session/CompleteTurn.command.ts"
import {
	CreateSession,
	SessionAlreadyExists,
	SessionCreated,
} from "../src/Session/CreateSession.command.ts"
import { OpenModelRequests } from "../src/Session/OpenModelRequests.rejection.ts"
import { AgentMessage, RecordAgentMessage } from "../src/Session/RecordAgentMessage.command.ts"
import { AgentThinking, RecordAgentThinking } from "../src/Session/RecordAgentThinking.command.ts"
import {
	RecordModelRequestEnd,
	SpanModelRequestEnd,
	UnknownModelRequest,
} from "../src/Session/RecordModelRequestEnd.command.ts"
import {
	DuplicateModelRequest,
	OutOfOrderModelRequest,
	RecordModelRequestStart,
	SpanModelRequestStart,
} from "../src/Session/RecordModelRequestStart.command.ts"
import { RecordSessionError, SessionErrorEvent } from "../src/Session/RecordSessionError.command.ts"
import { SendUserInterrupt, UserInterrupt } from "../src/Session/SendUserInterrupt.command.ts"
import {
	SendUserMessage,
	SessionStatusRunning,
	UserMessage,
} from "../src/Session/SendUserMessage.command.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import { SessionNotFound } from "../src/Session/SessionNotFound.rejection.ts"
import { SessionNotRunning } from "../src/Session/SessionNotRunning.rejection.ts"
import { SessionTerminated } from "../src/Session/SessionTerminated.rejection.ts"
import { StaleTurn } from "../src/Session/StaleTurn.rejection.ts"
import { Sessions } from "../src/Sessions.model.ts"

const story = Story.make(Sessions)

const createdEvent = new SessionCreated({
	agent_id: "agent_001",
	agent_version: 1,
	environment_id: "env_001",
	title: null,
})

describe("Sessions", () => {
	it.effect("is well defined", () =>
		Effect.scoped(Layer.build(Sessions.layer(Layer.empty))).pipe(Effect.provide(Domain.InMemory)),
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
				new SessionStatusRunning(),
			),
			Story.replied({ turn: 1 }),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				interrupt_requested: false,
				open_model_request_id: null,
				model_requests_started: 0,
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
				new RecordAgentThinking({ session_id: session.id, turn: 1, thinking: "Thinking..." }),
			),
			Story.then(session, new AgentThinking({ thinking: "Thinking..." })),
			Story.when(new RecordAgentMessage({ session_id: session.id, turn: 1, text: "Hello!" })),
			Story.then(session, new AgentMessage({ content: [{ type: "text", text: "Hello!" }] })),
			Story.when(
				new RecordModelRequestEnd({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_001",
					model_usage: { input_tokens: 12, output_tokens: 5 },
					is_error: false,
				}),
			),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: "evt_001",
					model_usage: { input_tokens: 12, output_tokens: 5 },
					is_error: false,
				}),
			),
			Story.when(
				new CompleteTurn({
					session_id: session.id,
					turn: 1,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.then(session, new SessionStatusIdle({ stop_reason: { type: "end_turn" } })),
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
				new SessionStatusRunning(),
				new SpanModelRequestStart({ model_request_start_id: "evt_req" }),
				new SpanModelRequestEnd({
					model_request_start_id: "evt_req",
					model_usage: usage,
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" } }),
			),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Turn 2" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Turn 2" }] }),
				new SessionStatusRunning(),
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
				new RecordAgentThinking({ session_id: session.id, turn: 1, thinking: "Stale thinking" }),
			),
			Story.rejected(stale),
			Story.when(
				new RecordAgentMessage({ session_id: session.id, turn: 1, text: "Stale message" }),
			),
			Story.rejected(stale),
			Story.when(
				new RecordModelRequestEnd({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_req",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.rejected(stale),
			Story.when(
				new RecordSessionError({
					session_id: session.id,
					turn: 1,
					error: {
						type: "model_request_failed_error",
						message: "Stale exhausted error",
						retry_status: { type: "exhausted" },
					},
				}),
			),
			Story.rejected(stale),
			Story.when(
				new CompleteTurn({
					session_id: session.id,
					turn: 1,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.rejected(stale),
			Story.when(
				new CompleteTurn({
					session_id: session.id,
					turn: 2,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.rejected(
				new OpenModelRequests({
					session_id: session.id,
					open_model_request_id: "evt_req",
				}),
			),
			Story.when(
				new RecordAgentMessage({ session_id: session.id, turn: 2, text: "Still running turn 2" }),
			),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Still running turn 2" }] }),
			),
			Story.when(
				new RecordModelRequestEnd({
					session_id: session.id,
					turn: 2,
					request_seq: 1,
					model_request_start_id: "evt_req",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: "evt_req",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.when(
				new CompleteTurn({
					session_id: session.id,
					turn: 2,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.then(session, new SessionStatusIdle({ stop_reason: { type: "end_turn" } })),
			Story.state(session, { _tag: "Idle", turn: 2 }),
		)
	})

	it.effect("enforces sequential model-request accounting before completing a turn", () => {
		const session = Session.ref("sess_model_req")
		const usage = { input_tokens: 10, output_tokens: 4 }
		return story(
			Story.given(
				session,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
				new SessionStatusRunning(),
			),
			Story.when(
				new RecordModelRequestEnd({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_unknown",
					model_usage: usage,
					is_error: false,
				}),
			),
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
				}),
			),
			Story.when(
				new CompleteTurn({
					session_id: session.id,
					turn: 1,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.rejected(
				new OpenModelRequests({
					session_id: session.id,
					open_model_request_id: "evt_1",
				}),
			),
			Story.when(
				new RecordSessionError({
					session_id: session.id,
					turn: 1,
					error: {
						type: "model_request_failed_error",
						message: "429 rate limit",
						retry_status: { type: "exhausted" },
					},
				}),
			),
			Story.rejected(
				new OpenModelRequests({
					session_id: session.id,
					open_model_request_id: "evt_1",
				}),
			),
			Story.when(
				new RecordModelRequestEnd({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_1",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: "evt_1",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.when(
				new RecordModelRequestEnd({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_1",
					model_usage: usage,
					is_error: false,
				}),
			),
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
			Story.when(
				new RecordModelRequestEnd({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "evt_1",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.rejected(
				new UnknownModelRequest({
					session_id: session.id,
					model_request_start_id: "evt_1",
				}),
			),
			Story.when(
				new CompleteTurn({
					session_id: session.id,
					turn: 1,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.rejected(
				new OpenModelRequests({
					session_id: session.id,
					open_model_request_id: "evt_1",
				}),
			),
			Story.when(
				new RecordModelRequestEnd({
					session_id: session.id,
					turn: 1,
					request_seq: 2,
					model_request_start_id: "evt_1",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.then(
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
				interrupt_requested: false,
				open_model_request_id: null,
				model_requests_started: 2,
			}),
			Story.when(
				new CompleteTurn({
					session_id: session.id,
					turn: 1,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.then(session, new SessionStatusIdle({ stop_reason: { type: "end_turn" } })),
		)
	})

	it.effect("queues a second user.message while running without duplicating status_running", () => {
		const session = Session.ref("sess_002")
		return story(
			Story.given(
				session,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "First" }] }),
				new SessionStatusRunning(),
			),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Second" })),
			Story.then(session, new UserMessage({ content: [{ type: "text", text: "Second" }] })),
			Story.replied({ turn: 1 }),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				interrupt_requested: false,
				open_model_request_id: null,
				model_requests_started: 0,
			}),
		)
	})

	it.effect("handles idempotent user.interrupt while running and refuses it when idle", () => {
		const session = Session.ref("sess_003")
		return story(
			Story.given(session, createdEvent),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Run" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Run" }] }),
				new SessionStatusRunning(),
			),
			Story.replied({ turn: 1 }),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.then(session, new UserInterrupt()),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				interrupt_requested: true,
				open_model_request_id: null,
				model_requests_started: 0,
			}),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.then(session),
			Story.when(
				new CompleteTurn({
					session_id: session.id,
					turn: 1,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.then(session, new SessionStatusIdle({ stop_reason: { type: "end_turn" } })),
		)
	})

	it.effect("distinguishes retrying, exhausted, and terminal session.error transitions", () => {
		const session = Session.ref("sess_004")
		const retryingError = {
			type: "model_request_failed_error",
			message: "429 rate limit",
			retry_status: { type: "retrying" as const },
		}
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
		return story(
			Story.given(
				session,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "Hi" }] }),
				new SessionStatusRunning(),
			),
			Story.when(new RecordSessionError({ session_id: session.id, turn: 1, error: retryingError })),
			Story.then(session, new SessionErrorEvent({ error: retryingError })),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				interrupt_requested: false,
				open_model_request_id: null,
				model_requests_started: 0,
			}),
			Story.when(
				new RecordSessionError({ session_id: session.id, turn: 1, error: exhaustedError }),
			),
			Story.then(
				session,
				new SessionErrorEvent({ error: exhaustedError }),
				new SessionStatusIdle({ stop_reason: { type: "retries_exhausted" } }),
			),
			Story.state(session, { _tag: "Idle", turn: 1 }),
			Story.when(
				new RecordSessionError({ session_id: session.id, turn: 1, error: exhaustedError }),
			),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Retry" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Retry" }] }),
				new SessionStatusRunning(),
			),
			Story.replied({ turn: 2 }),
			Story.when(new RecordSessionError({ session_id: session.id, turn: 2, error: terminalError })),
			Story.then(
				session,
				new SessionErrorEvent({ error: terminalError }),
				new SessionStatusTerminated(),
			),
			Story.state(session, { _tag: "Terminated" }),
			Story.when(new SendUserMessage({ session_id: session.id, text: "After" })),
			Story.rejected(new SessionTerminated({ session_id: session.id })),
		)
	})

	it.effect("rejects turn-recording commands when idle and archives running sessions", () => {
		const session = Session.ref("sess_005")
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
			Story.when(
				new CompleteTurn({
					session_id: session.id,
					turn: 1,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Work" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Work" }] }),
				new SessionStatusRunning(),
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
			Story.then(session, new SessionStatusTerminated()),
			Story.state(session, { _tag: "Terminated" }),
			Story.when(new RecordAgentMessage({ session_id: session.id, turn: 1, text: "Late" })),
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
			Story.then(session, new SessionStatusTerminated()),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(session),
			Story.when(new SendUserMessage({ session_id: session.id, text: "After" })),
			Story.rejected(new SessionTerminated({ session_id: session.id })),
			Story.when(
				new RecordSessionError({
					session_id: session.id,
					turn: null,
					error: {
						type: "unknown_error",
						message: "boom",
						retry_status: { type: "terminal" },
					},
				}),
			),
			Story.rejected(new SessionTerminated({ session_id: session.id })),
		)
	})

	it.effect("replays in-flight requests from Session events and supports colon session IDs", () => {
		const sessionA = Session.ref("s")
		const sessionB = Session.ref("s:1:x")
		const usage = { input_tokens: 4, output_tokens: 2 }
		return story(
			Story.given(
				sessionA,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "A" }] }),
				new SessionStatusRunning(),
				new SpanModelRequestStart({ model_request_start_id: "x:1:y" }),
			),
			Story.given(
				sessionB,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "B" }] }),
				new SessionStatusRunning(),
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
			Story.when(
				new RecordModelRequestEnd({
					session_id: sessionB.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "y",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.then(
				sessionB,
				new SpanModelRequestEnd({
					model_request_start_id: "y",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.when(
				new RecordModelRequestEnd({
					session_id: sessionA.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: "x:1:y",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.then(
				sessionA,
				new SpanModelRequestEnd({
					model_request_start_id: "x:1:y",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.when(
				new CompleteTurn({
					session_id: sessionA.id,
					turn: 1,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.then(sessionA, new SessionStatusIdle({ stop_reason: { type: "end_turn" } })),
			Story.when(
				new CompleteTurn({
					session_id: sessionB.id,
					turn: 1,
					stop_reason: { type: "end_turn" },
				}),
			),
			Story.then(sessionB, new SessionStatusIdle({ stop_reason: { type: "end_turn" } })),
		)
	})
})
