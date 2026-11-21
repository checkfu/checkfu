import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, expect, it } from "@effect/vitest"
import * as HashSet from "effect/HashSet"
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
	it("is well defined", () => {
		expect(Domain.verify(Sessions)).toEqual([])
	})

	it.effect("runs a full turn from user.message to session.status_idle", () => {
		const session = Session.ref("sess_001")
		return story(
			Story.when(
				session,
				new CreateSession({
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
			Story.when(session, new SendUserMessage({ content: [{ type: "text", text: "Hi" }] })),
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
				open_model_request_ids: HashSet.empty(),
				started_model_request_ids: HashSet.empty(),
			}),
			Story.when(
				session,
				new RecordModelRequestStart({ turn: 1, model_request_start_id: "evt_001" }),
			),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "evt_001" })),
			Story.when(session, new RecordAgentThinking({ turn: 1, thinking: "Thinking..." })),
			Story.then(session, new AgentThinking({ thinking: "Thinking..." })),
			Story.when(
				session,
				new RecordAgentMessage({ turn: 1, content: [{ type: "text", text: "Hello!" }] }),
			),
			Story.then(session, new AgentMessage({ content: [{ type: "text", text: "Hello!" }] })),
			Story.when(
				session,
				new RecordModelRequestEnd({
					turn: 1,
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
			Story.when(session, new CompleteTurn({ turn: 1, stop_reason: { type: "end_turn" } })),
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
			Story.when(session, new SendUserMessage({ content: [{ type: "text", text: "Turn 2" }] })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Turn 2" }] }),
				new SessionStatusRunning(),
			),
			Story.replied({ turn: 2 }),
			Story.when(
				session,
				new RecordModelRequestStart({ turn: 2, model_request_start_id: "evt_req" }),
			),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "evt_req" })),
			Story.when(
				session,
				new RecordModelRequestStart({ turn: 1, model_request_start_id: "evt_stale" }),
			),
			Story.rejected(stale),
			Story.when(session, new RecordAgentThinking({ turn: 1, thinking: "Stale thinking" })),
			Story.rejected(stale),
			Story.when(
				session,
				new RecordAgentMessage({ turn: 1, content: [{ type: "text", text: "Stale message" }] }),
			),
			Story.rejected(stale),
			Story.when(
				session,
				new RecordModelRequestEnd({
					turn: 1,
					model_request_start_id: "evt_req",
					model_usage: usage,
					is_error: false,
				}),
			),
			Story.rejected(stale),
			Story.when(
				session,
				new RecordSessionError({
					turn: 1,
					error: {
						type: "model_request_failed_error",
						message: "Stale exhausted error",
						retry_status: { type: "exhausted" },
					},
				}),
			),
			Story.rejected(stale),
			Story.when(session, new CompleteTurn({ turn: 1, stop_reason: { type: "end_turn" } })),
			Story.rejected(stale),
			Story.when(session, new CompleteTurn({ turn: 2, stop_reason: { type: "end_turn" } })),
			Story.rejected(
				new OpenModelRequests({
					session_id: session.id,
					open_model_request_ids: ["evt_req"],
				}),
			),
			Story.when(
				session,
				new RecordAgentMessage({
					turn: 2,
					content: [{ type: "text", text: "Still running turn 2" }],
				}),
			),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Still running turn 2" }] }),
			),
			Story.when(
				session,
				new RecordModelRequestEnd({
					turn: 2,
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
			Story.when(session, new CompleteTurn({ turn: 2, stop_reason: { type: "end_turn" } })),
			Story.then(session, new SessionStatusIdle({ stop_reason: { type: "end_turn" } })),
			Story.state(session, { _tag: "Idle", turn: 2 }),
		)
	})

	it.effect("enforces open model-request accounting before completing a turn", () => {
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
				session,
				new RecordModelRequestEnd({
					turn: 1,
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
				session,
				new RecordModelRequestStart({ turn: 1, model_request_start_id: "evt_1" }),
			),
			Story.then(session, new SpanModelRequestStart({ model_request_start_id: "evt_1" })),
			Story.when(
				session,
				new RecordModelRequestStart({ turn: 1, model_request_start_id: "evt_1" }),
			),
			Story.rejected(
				new DuplicateModelRequest({
					session_id: session.id,
					model_request_start_id: "evt_1",
				}),
			),
			Story.when(session, new CompleteTurn({ turn: 1, stop_reason: { type: "end_turn" } })),
			Story.rejected(
				new OpenModelRequests({
					session_id: session.id,
					open_model_request_ids: ["evt_1"],
				}),
			),
			Story.when(
				session,
				new RecordSessionError({
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
					open_model_request_ids: ["evt_1"],
				}),
			),
			Story.when(
				session,
				new RecordModelRequestEnd({
					turn: 1,
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
				session,
				new RecordModelRequestEnd({
					turn: 1,
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
				session,
				new RecordModelRequestStart({ turn: 1, model_request_start_id: "evt_1" }),
			),
			Story.rejected(
				new DuplicateModelRequest({
					session_id: session.id,
					model_request_start_id: "evt_1",
				}),
			),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				interrupt_requested: false,
				open_model_request_ids: HashSet.empty(),
				started_model_request_ids: HashSet.make("evt_1"),
			}),
			Story.when(session, new CompleteTurn({ turn: 1, stop_reason: { type: "end_turn" } })),
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
			Story.when(session, new SendUserMessage({ content: [{ type: "text", text: "Second" }] })),
			Story.then(session, new UserMessage({ content: [{ type: "text", text: "Second" }] })),
			Story.replied({ turn: 1 }),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				interrupt_requested: false,
				open_model_request_ids: HashSet.empty(),
				started_model_request_ids: HashSet.empty(),
			}),
		)
	})

	it.effect("handles idempotent user.interrupt while running and refuses it when idle", () => {
		const session = Session.ref("sess_003")
		return story(
			Story.given(session, createdEvent),
			Story.when(session, new SendUserInterrupt()),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(session, new SendUserMessage({ content: [{ type: "text", text: "Run" }] })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Run" }] }),
				new SessionStatusRunning(),
			),
			Story.replied({ turn: 1 }),
			Story.when(session, new SendUserInterrupt()),
			Story.then(session, new UserInterrupt()),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				interrupt_requested: true,
				open_model_request_ids: HashSet.empty(),
				started_model_request_ids: HashSet.empty(),
			}),
			Story.when(session, new SendUserInterrupt()),
			Story.then(session),
			Story.when(session, new CompleteTurn({ turn: 1, stop_reason: { type: "end_turn" } })),
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
			Story.when(session, new RecordSessionError({ turn: 1, error: retryingError })),
			Story.then(session, new SessionErrorEvent({ error: retryingError })),
			Story.state(session, {
				_tag: "Running",
				turn: 1,
				interrupt_requested: false,
				open_model_request_ids: HashSet.empty(),
				started_model_request_ids: HashSet.empty(),
			}),
			Story.when(session, new RecordSessionError({ turn: 1, error: exhaustedError })),
			Story.then(
				session,
				new SessionErrorEvent({ error: exhaustedError }),
				new SessionStatusIdle({ stop_reason: { type: "retries_exhausted" } }),
			),
			Story.state(session, { _tag: "Idle", turn: 1 }),
			Story.when(session, new RecordSessionError({ turn: 1, error: exhaustedError })),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(session, new SendUserMessage({ content: [{ type: "text", text: "Retry" }] })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Retry" }] }),
				new SessionStatusRunning(),
			),
			Story.replied({ turn: 2 }),
			Story.when(session, new RecordSessionError({ turn: 2, error: terminalError })),
			Story.then(
				session,
				new SessionErrorEvent({ error: terminalError }),
				new SessionStatusTerminated(),
			),
			Story.state(session, { _tag: "Terminated" }),
			Story.when(session, new SendUserMessage({ content: [{ type: "text", text: "After" }] })),
			Story.rejected(new SessionTerminated({ session_id: session.id })),
		)
	})

	it.effect("rejects turn-recording commands when idle and archives running sessions", () => {
		const session = Session.ref("sess_005")
		return story(
			Story.given(session, createdEvent),
			Story.when(
				session,
				new RecordModelRequestStart({ turn: 1, model_request_start_id: "evt_0" }),
			),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(session, new CompleteTurn({ turn: 1, stop_reason: { type: "end_turn" } })),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(session, new SendUserMessage({ content: [{ type: "text", text: "Work" }] })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Work" }] }),
				new SessionStatusRunning(),
			),
			Story.replied({ turn: 1 }),
			Story.when(session, new ArchiveSession()),
			Story.then(session, new SessionStatusTerminated()),
			Story.state(session, { _tag: "Terminated" }),
			Story.when(
				session,
				new RecordAgentMessage({ turn: 1, content: [{ type: "text", text: "Late" }] }),
			),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "terminated" })),
		)
	})

	it.effect("rejects unknown sessions, duplicate creation, and commands after termination", () => {
		const missing = Session.ref("sess_missing")
		const session = Session.ref("sess_006")
		return story(
			Story.when(missing, new SendUserMessage({ content: [{ type: "text", text: "Hi" }] })),
			Story.rejected(new SessionNotFound({ session_id: missing.id })),
			Story.when(missing, new ArchiveSession()),
			Story.rejected(new SessionNotFound({ session_id: missing.id })),
			Story.given(session, createdEvent),
			Story.when(
				session,
				new CreateSession({
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: null,
				}),
			),
			Story.rejected(new SessionAlreadyExists({ session_id: session.id })),
			Story.when(session, new ArchiveSession()),
			Story.then(session, new SessionStatusTerminated()),
			Story.when(session, new ArchiveSession()),
			Story.then(session),
			Story.when(session, new SendUserMessage({ content: [{ type: "text", text: "After" }] })),
			Story.rejected(new SessionTerminated({ session_id: session.id })),
			Story.when(
				session,
				new RecordSessionError({
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
})
