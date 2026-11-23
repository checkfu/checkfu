import {
	AbandonTurn,
	SessionErrorEvent,
	TurnAbandoned,
} from "../src/Session/AbandonTurn.command.ts"
import * as Domain from "@alchemy.run/domain"
import * as DurableObjects from "@alchemy.run/domain/DurableObjects"
import * as InMemory from "@alchemy.run/domain/InMemory"
import { Story } from "@alchemy.run/domain/Story"
import { describe, expect, it } from "@effect/vitest"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { storageCallbacks } from "alchemy/Workers/StorageCallbacks"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
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
	CreateSession,
	SessionAlreadyExists,
	SessionCreated,
} from "../src/Session/CreateSession.command.ts"
import {
	ModelProvider,
	boundedModelProvider,
	clampModelReply,
} from "../src/Session/ModelProvider.external.ts"
import { FailModelRequest } from "../src/Session/FailModelRequest.command.ts"
import { InterruptModelRequest } from "../src/Session/InterruptModelRequest.command.ts"
import {
	DuplicateModelRequest,
	OutOfOrderModelRequest,
	RecordModelRequestStart,
	SpanModelRequestStart,
} from "../src/Session/RecordModelRequestStart.command.ts"
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
import { SessionView } from "../src/Session/SessionView.view.ts"
import { StaleTurn } from "../src/Session/StaleTurn.rejection.ts"
import { StopModelRequest, StopModelRequestLive } from "../src/Session/StopModelRequest.policy.ts"
import { StartTurn, StartTurnLive } from "../src/Session/StartTurn.policy.ts"
import { TurnInput } from "../src/Session/TurnInput.view.ts"
import { UnknownModelRequest } from "../src/Session/UnknownModelRequest.rejection.ts"
import { snapshotVersion, versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import { Sessions, SessionsHandlersLive } from "../src/Sessions.model.ts"

const StartTurnNoopLayer = Layer.mergeAll(
	StartTurn.toLayer(Effect.succeed(() => Effect.void)),
	StopModelRequest.toLayer(Effect.succeed(() => Effect.void)),
)
const aggregateStory = Story.make(Sessions, {
	layer: Layer.mergeAll(StartTurnNoopLayer, RunTurnLive),
	stub: [ModelProvider],
})
const story = aggregateStory

const fullStory = Story.make(Sessions, {
	layer: SessionsHandlersLive,
	stub: [ModelProvider],
})

// The DO inbox redelivers failed rows. Request one redelivery here since
// Story's in-memory host surfaces an unhandled policy failure immediately.
const retryCleanup = StopModelRequest.toLayer(StopModelRequest, {
	retry: Schedule.recurs(1),
}).pipe(Layer.provide(StopModelRequestLive))
const redeliveryStory = Story.make(Sessions, {
	layer: Layer.mergeAll(StartTurnLive, RunTurnLive, retryCleanup),
	stub: [ModelProvider],
})

const ModelProviderNoopLayer = ModelProvider.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
		generate: () =>
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
			Effect.provide([Domain.InMemory, ModelProviderNoopLayer]),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: "evt_req" }),
				new SpanModelRequestEnd({
					model_request_start_id: "evt_req",
					model_usage: usage,
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
			),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Turn 2" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Turn 2" }] }),
				new SessionStatusRunning({ turn: 2, generation: 0 }),
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 0 }),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
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
				Story.then(session, new UserInterrupt()),
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
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 1, generation: 0 }),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
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
					generation: 0,
				}),
			),
			Story.state(session, { _tag: "Idle", turn: 1 }),
			Story.when(failExhausted),
			Story.rejected(new SessionNotRunning({ session_id: session.id, status: "idle" })),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Retry" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Retry" }] }),
				new SessionStatusRunning({ turn: 2, generation: 0 }),
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
				new SessionStatusTerminated(),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
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
				new SessionStatusTerminated(),
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
			Story.then(session, new SessionStatusTerminated(), new SessionArchived()),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(session),
			Story.when(new SendUserMessage({ session_id: session.id, text: "After" })),
			Story.rejected(new SessionTerminated({ session_id: session.id })),
		)
	})

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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: "x:1:y" }),
			),
			Story.given(
				sessionB,
				createdEvent,
				new UserMessage({ content: [{ type: "text", text: "B" }] }),
				new SessionStatusRunning({ turn: 1, generation: 0 }),
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.replied({ turn: 1 }),
				Story.call(ModelProvider.generate, {
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 2,
					environment_id: "env_001",
					turn: 1,
				}),
				Story.succeed(ModelProvider.generate, {
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
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
				),
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
					new AgentThinking({ thinking: "Greeting the user" }),
					new AgentMessage({ content: [{ type: "text", text: "Hello!" }] }),
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 10, output_tokens: 4 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
				]),
				Story.clock(t2),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Follow up" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Follow up" }] }),
					new SessionStatusRunning({ turn: 2, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.replied({ turn: 2 }),
				Story.call(ModelProvider.generate, {
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 2,
					environment_id: "env_001",
					turn: 2,
				}),
				Story.succeed(ModelProvider.generate, {
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
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 0 }),
				),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(ModelProvider.generate, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
			}),
			Story.fail(ModelProvider.generate, {
				_tag: "ModelProviderError",
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
					generation: 0,
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
				new SessionStatusRunning({ turn: 2, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.call(ModelProvider.generate, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 2,
			}),
			Story.fail(ModelProvider.generate, {
				_tag: "ModelProviderError",
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
				new SessionStatusTerminated(),
			),
			Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 2 }),
			Story.succeed(ModelProvider.interrupt, undefined),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
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
					generation: 0,
				}),
				new UserMessage({ content: [{ type: "text", text: "Second" }] }),
				new SessionStatusRunning({ turn: 2, generation: 0 }),
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
				new SessionStatusTerminated(),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(ModelProvider.generate, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
			}),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Second" })),
			Story.then(session, new UserMessage({ content: [{ type: "text", text: "Second" }] })),
			Story.replied({ turn: 2 }),
			Story.succeed(ModelProvider.generate, {
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
				new SessionStatusRunning({ turn: 2, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.saga(RunTurn, turn1Key, {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.call(ModelProvider.generate, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 2,
			}),
			Story.succeed(ModelProvider.generate, {
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 0 }),
			),
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(ModelProvider.generate, {
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					turn: 1,
				}),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt()),
				Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1 }),
				Story.succeed(ModelProvider.interrupt, undefined),
				Story.state(session, {
					_tag: "Running",
					turn: 1,
					open_model_request_id: req1,
					model_requests_started: 1,
					pending_user_messages: 0,
				}),
				Story.fail(ModelProvider.generate, { _tag: "ModelRequestInterrupted" }),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 1, generation: 0 }),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call("turn-1", ModelProvider.generate, {
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
			Story.then(session, new UserInterrupt()),
			Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(ModelProvider.interrupt, undefined),
			Story.fail("turn-1", ModelProvider.generate, { _tag: "ModelRequestInterrupted" }),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 1, generation: 0 }),
				new SessionStatusRunning({ turn: 2, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.saga(RunTurn, turn1Key, {
				_tag: "Completed",
				result: { status: "interrupted" },
			}),
			Story.call("turn-2", ModelProvider.generate, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 2,
				input: ["Actual prompt"],
			}),
			Story.succeed("turn-2", ModelProvider.generate, {
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 0 }),
			),
			Story.saga(RunTurn, turn2Key, {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.state(session, { _tag: "Idle", turn: 2 }),
		)
	})

	it.effect(
		"fails a turn whose harness cannot be reached and moves the session to a fresh conversation",
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(ModelProvider.generate, { session_id: session.id, turn: 1, generation: 0 }),
				Story.fail(ModelProvider.generate, { _tag: "HarnessUnavailable" }),
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
					new TurnAbandoned({ turn: 1, generation: 0 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 1,
						generation: 1,
					}),
				),
				Story.saga(RunTurn, turn1Key, { _tag: "Completed", result: { status: "failed" } }),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1, generation: 0 }),
				Story.fail(ModelProvider.interrupt, { _tag: "HarnessUnavailable" }),
				Story.call("cleanup", ModelProvider.interrupt, {
					session_id: session.id,
					turn: 1,
					generation: 0,
				}),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Second" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Second" }] }),
					new SessionStatusRunning({ turn: 2, generation: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.call(ModelProvider.generate, {
					session_id: session.id,
					turn: 2,
					generation: 1,
					input: ["Second"],
				}),
				Story.succeed("cleanup", ModelProvider.interrupt, undefined),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt()),
				Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 2, generation: 1 }),
				Story.succeed(ModelProvider.interrupt, undefined),
				Story.fail(ModelProvider.generate, { _tag: "ModelRequestInterrupted" }),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req2,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 2, generation: 1 }),
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
									boundedModelProvider(
										Effect.succeed({
											interrupt: () => Effect.void,
											generate: () => {
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(ModelProvider.generate, { session_id: session.id, turn: 1, generation: 0 }),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt()),
				Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1, generation: 0 }),
				Story.fail(ModelProvider.interrupt, { _tag: "HarnessUnavailable" }),
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
					new TurnAbandoned({ turn: 1, generation: 0 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 1,
						generation: 1,
					}),
				),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1, generation: 0 }),
				Story.succeed(ModelProvider.interrupt, undefined),
				Story.succeed(ModelProvider.generate, {
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

	it.effect("keeps a retrying diagnostic on the current generation", () => {
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				request,
			),
			Story.call(ModelProvider.generate, { turn: 1, generation: 0 }),
			Story.given(session, new SessionErrorEvent({ error: diagnostic })),
			Story.view(TurnInput, session, {
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
				harness_generation: 0,
				input: ["First"],
				unsent: [],
			}),
			Story.succeed(ModelProvider.generate, {
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
			),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect(
		"keeps the generation across turns that complete, are interrupted or exhaust their retries",
		() => {
			const session = Session.ref("sess_generation_kept")
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
				Story.state(session, { _tag: "Idle", turn: 0, generation: 0 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "One" })),
				Story.then(session, text("One"), new SessionStatusRunning({ turn: 1, generation: 0 })),
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
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
				),
				Story.state(session, { _tag: "Idle", turn: 1, generation: 0 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Two" })),
				Story.then(session, text("Two"), new SessionStatusRunning({ turn: 2, generation: 0 })),
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
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 2, generation: 0 }),
				),
				Story.state(session, { _tag: "Idle", turn: 2, generation: 0 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Three" })),
				Story.then(session, text("Three"), new SessionStatusRunning({ turn: 3, generation: 0 })),
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
						generation: 0,
					}),
				),
				Story.state(session, { _tag: "Idle", turn: 3, generation: 0 }),
				Story.view(TurnInput, session, { turn: 3, harness_generation: 0 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Four" })),
				Story.then(session, text("Four"), new SessionStatusRunning({ turn: 4, generation: 0 })),
				Story.state(session, { _tag: "Running", turn: 4, generation: 0 }),
				Story.view(TurnInput, session, { turn: 4, harness_generation: 0, input: ["Four"] }),
			)
		},
	)

	it.effect(
		"retires the generation after a truncated reply and runs the next turn under the new one",
		() => {
			const session = Session.ref("sess_generation_truncated")
			const req1 = `${turnKey(session.id, 1)}:req:1`
			const req2 = `${turnKey(session.id, 2)}:req:1`
			return fullStory(
				Story.clock(t0),
				Story.given(session, createdEvent),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Long" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Long" }] }),
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(ModelProvider.generate, { session_id: session.id, turn: 1, generation: 0 }),
				Story.succeed(ModelProvider.generate, {
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
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 1 }),
				),
				Story.state(session, { _tag: "Idle", turn: 1, generation: 1 }),
				Story.view(TurnInput, session, { turn: 1, harness_generation: 1, input: [] }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Continue" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Continue" }] }),
					new SessionStatusRunning({ turn: 2, generation: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.state(session, { _tag: "Running", turn: 2, generation: 1 }),
				Story.call(ModelProvider.generate, {
					session_id: session.id,
					turn: 2,
					generation: 1,
					input: ["Continue"],
				}),
				Story.succeed(ModelProvider.generate, {
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
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 1 }),
				),
				Story.state(session, { _tag: "Idle", turn: 2, generation: 1 }),
				Story.view(TurnInput, session, { turn: 2, harness_generation: 1 }),
			)
		},
	)

	it.effect(
		"stamps session.status_idle and session.status_running with one generation when a queued message drains",
		() => {
			const session = Session.ref("sess_generation_drain")
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: "req_1" }),
					text("Two"),
				),
				Story.when(commit(1, false)),
				Story.then(
					session,
					new AgentMessage({ content: [{ type: "text", text: "Reply" }] }),
					end(1),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
					new SessionStatusRunning({ turn: 2, generation: 0 }),
				),
				Story.state(session, { _tag: "Running", turn: 2, generation: 0 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Three" })),
				Story.then(session, text("Three")),
				Story.when(start(2)),
				Story.then(session, new SpanModelRequestStart({ model_request_start_id: "req_2" })),
				Story.when(commit(2, true)),
				Story.then(
					session,
					new AgentMessage({ content: [{ type: "text", text: "Reply" }], truncated: true }),
					end(2),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 1 }),
					new SessionStatusRunning({ turn: 3, generation: 1 }),
				),
				Story.state(session, { _tag: "Running", turn: 3, generation: 1 }),
				Story.view(TurnInput, session, { turn: 3, harness_generation: 1, input: ["Three"] }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Four" })),
				Story.then(session, text("Four")),
				Story.when(
					new AbandonTurn({
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
					new TurnAbandoned({ turn: 3, generation: 1 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 3,
						generation: 2,
					}),
					new SessionStatusRunning({ turn: 4, generation: 2 }),
				),
				Story.state(session, { _tag: "Running", turn: 4, generation: 2 }),
				Story.view(TurnInput, session, { turn: 4, harness_generation: 2, input: ["Four"] }),
			)
		},
	)

	it.effect(
		"retires the generation when a turn passes its deadline and runs the next turn under the new one",
		() => {
			const session = Session.ref("sess_generation_deadline")
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call("slow", ModelProvider.generate, {
					session_id: session.id,
					turn: 1,
					generation: 0,
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
					new TurnAbandoned({ turn: 1, generation: 0 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 1,
						generation: 1,
					}),
				),
				Story.state(session, { _tag: "Idle", turn: 1, generation: 1 }),
				Story.view(TurnInput, session, { turn: 1, harness_generation: 1, input: [] }),
				Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1, generation: 0 }),
				Story.succeed(ModelProvider.interrupt, undefined),
				Story.fail("slow", ModelProvider.generate, { _tag: "ModelRequestInterrupted" }),
				Story.then(session),
				Story.saga(RunTurn, turn1Key, { _tag: "Completed", result: { status: "aborted" } }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Next" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Next" }] }),
					new SessionStatusRunning({ turn: 2, generation: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.call(ModelProvider.generate, {
					session_id: session.id,
					turn: 2,
					generation: 1,
					input: ["Next"],
				}),
				Story.succeed(ModelProvider.generate, {
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
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 1 }),
				),
				Story.state(session, { _tag: "Idle", turn: 2, generation: 1 }),
			)
		},
	)

	it.effect(
		"interrupts the retired generation when an unreachable turn drains straight into its successor",
		() => {
			const session = Session.ref("sess_generation_unreachable_drain")
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call("first", ModelProvider.generate, {
					session_id: session.id,
					turn: 1,
					generation: 0,
				}),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Queued" })),
				Story.then(session, new UserMessage({ content: [{ type: "text", text: "Queued" }] })),
				Story.replied({ turn: 2 }),
				Story.fail("first", ModelProvider.generate, { _tag: "HarnessUnavailable" }),
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
					new TurnAbandoned({ turn: 1, generation: 0 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 1,
						generation: 1,
					}),
					new SessionStatusRunning({ turn: 2, generation: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.saga(RunTurn, turn1Key, { _tag: "Completed", result: { status: "failed" } }),
				Story.state(session, { _tag: "Running", turn: 2, generation: 1 }),
				Story.view(TurnInput, session, { turn: 2, harness_generation: 1, input: ["Queued"] }),
				Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1, generation: 0 }),
				Story.succeed(ModelProvider.interrupt, undefined),
				Story.call("second", ModelProvider.generate, {
					session_id: session.id,
					turn: 2,
					generation: 1,
					input: ["Queued"],
				}),
				Story.succeed("second", ModelProvider.generate, {
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
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 1 }),
				),
				Story.state(session, { _tag: "Idle", turn: 2, generation: 1 }),
				Story.view(TurnInput, session, { turn: 2, harness_generation: 1 }),
			)
		},
	)

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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: firstRequest }),
				),
				Story.call("first", ModelProvider.generate, { turn: 1, generation: 0 }),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt()),
				Story.call("slow-interrupt", ModelProvider.interrupt, { turn: 1, generation: 0 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Next" })),
				Story.then(session, new UserMessage({ content: [{ type: "text", text: "Next" }] })),
				Story.fail("first", ModelProvider.generate, { _tag: "ModelRequestInterrupted" }),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: firstRequest,
						model_usage: { input_tokens: 0, output_tokens: 0 },
						is_error: true,
					}),
					new SessionStatusIdle({ stop_reason: { type: "interrupted" }, turn: 1, generation: 0 }),
					new SessionStatusRunning({ turn: 2, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: secondRequest }),
				),
				Story.call("second", ModelProvider.generate, { turn: 2, generation: 0, input: ["Next"] }),
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
					new TurnAbandoned({ turn: 2, generation: 0 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 2,
						generation: 1,
					}),
				),
				Story.state(session, { _tag: "Idle", turn: 2 }),
				Story.call("deadline", ModelProvider.interrupt, { turn: 2, generation: 0 }),
				Story.succeed("deadline", ModelProvider.interrupt, undefined),
				Story.fail("slow-interrupt", ModelProvider.interrupt, { _tag: "HarnessUnavailable" }),
				Story.fail("second", ModelProvider.generate, { _tag: "ModelRequestInterrupted" }),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
			),
			Story.when(abandon(unopened.id)),
			Story.then(
				unopened,
				error,
				new TurnAbandoned({ turn: 1, generation: 0 }),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					generation: 1,
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
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
				new TurnAbandoned({ turn: 1, generation: 0 }),
				new SessionStatusIdle({
					stop_reason: { type: "retries_exhausted" },
					turn: 1,
					generation: 1,
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call("turn-1", ModelProvider.generate, {
					session_id: session.id,
					turn: 1,
					generation: 0,
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
					new TurnAbandoned({ turn: 1, generation: 0 }),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 1,
						generation: 1,
					}),
				),
				Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1, generation: 0 }),
				Story.fail(ModelProvider.interrupt, { _tag: "HarnessUnavailable" }),
				Story.call("redelivery", ModelProvider.interrupt, {
					session_id: session.id,
					turn: 1,
					generation: 0,
				}),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Next" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Next" }] }),
					new SessionStatusRunning({ turn: 2, generation: 1 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.call("turn-2", ModelProvider.generate, {
					session_id: session.id,
					turn: 2,
					generation: 1,
				}),
				Story.succeed("turn-2", ModelProvider.generate, {
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
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 1 }),
				),
				Story.state(session, { _tag: "Idle", turn: 2 }),
				Story.succeed("redelivery", ModelProvider.interrupt, undefined),
				Story.succeed("turn-1", ModelProvider.generate, {
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
			StopModelRequestLive,
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
						Layer.provide(Layer.mergeAll(memory.layer, ModelProviderNoopLayer)),
					),
				),
			),
		)
		expect(state).toEqual({
			completed: { _tag: "Idle", turn: 1, generation: 0 },
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(ModelProvider.generate, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 1,
			}),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.then(session, new UserInterrupt()),
			Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(ModelProvider.interrupt, undefined),
			Story.succeed(ModelProvider.generate, {
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
			),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(ModelProvider.generate, {
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
			Story.fail(ModelProvider.generate, {
				_tag: "ModelProviderError",
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
					generation: 0,
				}),
				new SessionStatusRunning({ turn: 2, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.saga(RunTurn, turn1Key, {
				_tag: "Completed",
				result: { status: "failed" },
			}),
			Story.call(ModelProvider.generate, {
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				turn: 2,
			}),
			Story.succeed(ModelProvider.generate, {
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
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, generation: 0 }),
			),
			Story.saga(RunTurn, turn2Key, {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.state(session, { _tag: "Idle", turn: 2 }),
		)
	})

	it("aborts RunTurn without calling ModelProvider when another caller owns request 1 even with the same request ID", async () => {
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
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					turn: 1,
					generation: 0,
					input: ["Hello"],
				})
				return yield* run.result
			}).pipe(
				Effect.provide(
					Sessions.layer(Layer.mergeAll(StartTurnNoopLayer, RunTurnLive)).pipe(
						Layer.provide(
							Layer.mergeAll(
								Domain.InMemory,
								ModelProvider.toLayer(
									Effect.succeed({
										interrupt: () => Effect.void,
										generate: () => Effect.die("ModelProvider.generate must not be called"),
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

	it("aborts RunTurn without calling ModelProvider when another worker owns the same request ID at sequence 2", async () => {
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
					session_id: session.id,
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					turn: 1,
					generation: 0,
					input: ["Hello"],
				})
				return yield* run.result
			}).pipe(
				Effect.provide(
					Sessions.layer(Layer.mergeAll(StartTurnNoopLayer, RunTurnLive)).pipe(
						Layer.provide(
							Layer.mergeAll(
								Domain.InMemory,
								ModelProvider.toLayer(
									Effect.succeed({
										interrupt: () => Effect.void,
										generate: () => Effect.die("ModelProvider.generate must not be called"),
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
			),
			Story.call(ModelProvider.generate, {
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
				new SessionStatusTerminated(),
				new SessionArchived(),
			),
			Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1, generation: 0 }),
			Story.fail(ModelProvider.interrupt, { _tag: "HarnessUnavailable" }),
			Story.state(session, { _tag: "Terminated", archived: true }),
			Story.call(ModelProvider.interrupt, { session_id: session.id, turn: 1, generation: 0 }),
			Story.succeed(ModelProvider.interrupt, undefined),
			Story.succeed(ModelProvider.generate, {
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
				new SessionStatusRunning({ turn: 1, generation: 0 }),
				new SpanModelRequestStart({ model_request_start_id: req1 }),
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionStatusTerminated(),
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(ModelProvider.generate, {
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
				Story.fail(ModelProvider.generate, {
					_tag: "ModelProviderError",
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
					new SessionStatusRunning({ turn: 1, generation: 0 }),
					new SpanModelRequestStart({ model_request_start_id: req1 }),
				),
				Story.call(ModelProvider.generate, {
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
				Story.succeed(ModelProvider.generate, {
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
					new SessionStatusIdle({ stop_reason: { type: "refusal" }, turn: 1, generation: 0 }),
				),
				Story.saga(RunTurn, turn1Key, {
					_tag: "Completed",
					result: { status: "completed" },
				}),
				Story.state(session, { _tag: "Idle", turn: 1 }),
			)
		},
	)

	it("encodes and decodes SessionState snapshots at explicit schema_version 1 and rejects unknown versions", () => {
		const encode = Schema.encodeSync(SessionStateSnapshot)
		const decode = Schema.decodeUnknownSync(SessionStateSnapshot)
		const wire = encode({
			_tag: "Running",
			turn: 1,
			generation: 0,
			open_model_request_id: "req_1",
			model_requests_started: 1,
			pending_user_messages: 2,
		})
		expect(wire).toEqual({
			schema_version: SESSION_STATE_SCHEMA_VERSION,
			state: {
				_tag: "Running",
				turn: 1,
				generation: 0,
				open_model_request_id: "req_1",
				model_requests_started: 1,
				pending_user_messages: 2,
			},
		})
		expect(decode(wire)).toEqual({
			_tag: "Running",
			turn: 1,
			generation: 0,
			open_model_request_id: "req_1",
			model_requests_started: 1,
			pending_user_messages: 2,
		})
		expect(
			Exit.isFailure(
				Schema.decodeExit(SessionStateSnapshot)({
					schema_version: 2,
					state: { _tag: "Idle", turn: 0, generation: 0 },
				}),
			),
		).toBe(true)
	})

	it.effect("hands each turn the user messages no earlier turn was given", () => {
		const session = Session.ref("sess_turn_input")
		const text = (value: string) => new UserMessage({ content: [{ type: "text", text: value }] })
		return story(
			Story.clock(t0),
			Story.given(
				session,
				createdEvent,
				text("First"),
				new SessionStatusRunning({ turn: 1, generation: 0 }),
			),
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
				new SessionStatusIdle({ stop_reason: { type: "refusal" }, turn: 1, generation: 0 }),
				text("After refusal"),
				new SessionStatusRunning({ turn: 2, generation: 0 }),
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

	it("lazily upgrades a v1 snapshot to v2 through the real DurableObjects storage adapter, skips migration on reopen, and rejects future versions", async () => {
		const CounterId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("CounterId"))
		const V1State = Schema.Union([
			Schema.TaggedStruct("Empty", {}),
			Schema.TaggedStruct("Active", { count: Schema.Int }),
		])
		const V2State = Schema.Union([
			Schema.TaggedStruct("Empty", {}),
			Schema.TaggedStruct("Active", {
				count: Schema.Int,
				label: Schema.String,
			}),
		])

		let migrationsRun = 0
		const CounterSnapshot = versionedSnapshot({
			current: 2 as const,
			schema: V2State,
			previous: [
				snapshotVersion({
					version: 1 as const,
					schema: V1State,
					migrate: (v1) => {
						migrationsRun += 1
						return v1._tag === "Empty"
							? { _tag: "Empty" as const }
							: { _tag: "Active" as const, count: v1.count, label: "migrated-from-v1" }
					},
				}),
			],
		})

		class CounterIncremented extends Domain.Event("counter.incremented", {}) {}
		class IncrementCounter extends Domain.Command("IncrementCounter", {
			input: { counter_id: CounterId },
			events: [CounterIncremented],
		}) {}
		class Counter extends Domain.Aggregate("Counter", {
			id: CounterId,
			state: CounterSnapshot,
			initial: { _tag: "Empty" as const },
			commands: [IncrementCounter],
			keyOf: (cmd) => cmd.counter_id,
			decide: {
				IncrementCounter: () => [new CounterIncremented()],
			},
			evolve: {
				"counter.incremented": (state) =>
					state._tag === "Empty"
						? { _tag: "Active" as const, count: 1, label: "fresh-v2" }
						: { ...state, count: state.count + 1 },
			},
		}) {}
		class Counters extends Domain.Model("Counters", {
			aggregates: [Counter],
		}) {}

		// Backing storage persists across Durable Object reopen/eviction cycles.
		const backingStores = new Map<string, Map<string, unknown>>()
		const storeFor = (storageKey: string) => {
			let data = backingStores.get(storageKey)
			if (data === undefined) {
				data = new Map<string, unknown>()
				backingStores.set(storageKey, data)
			}
			return data
		}

		const makeObjectStorage = (data: Map<string, unknown>): DurableObjects.ObjectStorage => {
			const put = ((keyOrEntries: unknown, value?: unknown) =>
				Effect.sync(() => {
					if (typeof keyOrEntries === "string") {
						data.set(keyOrEntries, value)
					} else if (typeof keyOrEntries === "object" && keyOrEntries !== null) {
						for (const [k, v] of Object.entries(keyOrEntries)) {
							data.set(k, v)
						}
					}
				})) as DurableObjects.ObjectStorage["put"]
			const del = ((keyOrKeys: string | ReadonlyArray<string>) =>
				Effect.sync(() => {
					if (typeof keyOrKeys === "string") {
						return data.delete(keyOrKeys)
					}
					let removed = 0
					for (const k of keyOrKeys) {
						if (data.delete(k)) {
							removed += 1
						}
					}
					return removed
				})) as DurableObjects.ObjectStorage["delete"]
			return {
				get: <T>(key: string) => Effect.succeed(data.get(key) as T | undefined),
				put,
				delete: del,
				list: <T>(options?: DurableObjects.ListOptions) =>
					Effect.sync(() => {
						const prefix = options?.prefix ?? ""
						let entries = [...data.entries()]
							.filter(([k]) => k.startsWith(prefix))
							.filter(([k]) => (options?.start === undefined ? true : k >= options.start))
							.filter(([k]) => (options?.startAfter === undefined ? true : k > options.startAfter))
							.filter(([k]) => (options?.end === undefined ? true : k < options.end))
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						if (options?.reverse) {
							entries = entries.reverse()
						}
						if (options?.limit !== undefined) {
							entries = entries.slice(0, options.limit)
						}
						return new Map(entries as ReadonlyArray<[string, T]>)
					}),
				transaction: (effect) => effect,
			}
		}

		const openPlatform = () => {
			const claim = {}
			const host: DurableObjects.Host = {
				claimKey: Effect.succeed(claim),
				declare: (_model, name, impl) =>
					Effect.succeed({
						getByName: (key) => {
							const data = storeFor(`${name}:${key}`)
							const storage = makeObjectStorage(data)
							const { callbacks } = storageCallbacks(storage, {
								set: () => Effect.void,
								get: Effect.succeed(null),
							})
							const objectState: DurableObjects.ObjectStateShape = {
								storage,
								exclusive: (effect) => effect,
								waitUntil: () => Effect.void,
							}
							const runtimeContext = {
								Type: "TestDurableObject",
								id: key,
								env: {},
								get: () => Effect.undefined,
								set: (id: string) => Effect.succeed(id),
							}
							let methodsPromise:
								| Promise<
										Record<string, (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>>
								  >
								| undefined
							const loadMethods = () => {
								if (methodsPromise === undefined) {
									methodsPromise = Effect.runPromise(
										Effect.gen(function* () {
											const scope = yield* Scope.make()
											return yield* impl.pipe(
												Effect.provideService(DurableObjects.ObjectState, objectState),
												Effect.provideService(RuntimeContext, runtimeContext),
												Effect.provideService(Scope.Scope, scope),
												Effect.provide(callbacks),
											)
										}),
									) as Promise<
										Record<string, (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>>
									>
								}
								return Effect.promise(() => methodsPromise!)
							}
							return new Proxy(
								{},
								{
									get:
										(_target, prop: string) =>
										(...args: ReadonlyArray<unknown>) =>
											loadMethods().pipe(
												Effect.flatMap((methods) => {
													const fn = methods[prop]
													if (typeof fn !== "function") {
														return Effect.die(new Error(`Unknown Durable Object method: ${prop}`))
													}
													return fn(...args)
												}),
											),
								},
							)
						},
					}),
			}
			return DurableObjects.makePlatform(host).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))
		}

		// 1. Seed exact v1 wire payload directly into Durable Object storage.
		const counterId = CounterId.make("cnt_1")
		const counterStore = storeFor("CounterAggregate:cnt_1")
		counterStore.set("meta", {
			version: 1,
			state: {
				schema_version: 1,
				state: { _tag: "Active", count: 3 },
			},
		})

		// 2. Send a real state-changing command through the DurableObjects kernel & storage adapter.
		await Effect.runPromise(
			Effect.gen(function* () {
				const counters = yield* Counter
				yield* counters.send(new IncrementCounter({ counter_id: counterId }))
			}).pipe(Effect.provide(Counters.layer(Layer.empty).pipe(Layer.provide(openPlatform())))),
		)
		expect(migrationsRun).toBe(1)
		expect(counterStore.get("meta")).toEqual({
			version: 2,
			state: {
				schema_version: 2,
				state: { _tag: "Active", count: 4, label: "migrated-from-v1" },
			},
		})

		// 3. Reopen the same backing storage with a brand-new platform instance; converter must not run again.
		await Effect.runPromise(
			Effect.gen(function* () {
				const counters = yield* Counter
				yield* counters.send(new IncrementCounter({ counter_id: counterId }))
			}).pipe(Effect.provide(Counters.layer(Layer.empty).pipe(Layer.provide(openPlatform())))),
		)
		expect(migrationsRun).toBe(1)
		expect(counterStore.get("meta")).toEqual({
			version: 3,
			state: {
				schema_version: 2,
				state: { _tag: "Active", count: 5, label: "migrated-from-v1" },
			},
		})

		// 4. Unknown future schema_version must fail cleanly without overwriting storage.
		const futureId = CounterId.make("cnt_future")
		const futureMeta = {
			version: 1,
			state: {
				schema_version: 99,
				state: { _tag: "Active", count: 10 },
			},
		}
		const futureStore = storeFor("CounterAggregate:cnt_future")
		futureStore.set("meta", futureMeta)

		const futureExit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const counters = yield* Counter
				yield* counters.send(new IncrementCounter({ counter_id: futureId }))
			}).pipe(Effect.provide(Counters.layer(Layer.empty).pipe(Layer.provide(openPlatform())))),
		)
		expect(Exit.isFailure(futureExit)).toBe(true)
		expect(futureStore.get("meta")).toEqual(futureMeta)
	})

	it("round-trips transforming fields like Schema.FiniteFromString once in versionedSnapshot", () => {
		const V1Transformed = Schema.Struct({ rawCount: Schema.String })
		const V2Transformed = Schema.Struct({ count: Schema.FiniteFromString })
		const TransformedSnapshot = versionedSnapshot({
			current: 2 as const,
			schema: V2Transformed,
			previous: [
				snapshotVersion({
					version: 1 as const,
					schema: V1Transformed,
					migrate: (v1) => ({ count: Number(v1.rawCount) }),
				}),
			],
		})
		const encode = Schema.encodeSync(TransformedSnapshot)
		const decode = Schema.decodeUnknownSync(TransformedSnapshot)

		// Current version encode/decode applies NumberFromString exactly once.
		expect(encode({ count: 3 })).toEqual({
			schema_version: 2,
			state: { count: "3" },
		})
		expect(decode({ schema_version: 2, state: { count: "3" } })).toEqual({ count: 3 })

		// Older version migrates to canonical v2 Type and re-encodes to v2 Encoded.
		const migrated = decode({ schema_version: 1, state: { rawCount: "42" } })
		expect(migrated).toEqual({ count: 42 })
		expect(encode(migrated)).toEqual({
			schema_version: 2,
			state: { count: "42" },
		})
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
								boundedModelProvider(
									Effect.succeed({
										interrupt: () => Effect.void,
										generate: () => {
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
													_tag: "ModelProviderError" as const,
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

	it("reports a reply cut to the message limit as budget_reached, never as a clean end_turn", async () => {
		const oversized = {
			thinking: null,
			text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1),
			input_tokens: 1,
			output_tokens: 1,
		}
		const cut = await Effect.runPromise(
			clampModelReply({ ...oversized, stop_reason: { type: "end_turn" } }),
		)
		expect(cut.text.length).toBe(MAX_MESSAGE_TEXT_LENGTH)
		expect(cut.stop_reason).toEqual({ type: "budget_reached" })

		const refusal = await Effect.runPromise(
			clampModelReply({ ...oversized, stop_reason: { type: "refusal" } }),
		)
		expect(refusal.stop_reason).toEqual({ type: "refusal" })

		const whole = await Effect.runPromise(
			clampModelReply({ ...oversized, text: "short", stop_reason: { type: "end_turn" } }),
		)
		expect(whole.stop_reason).toEqual({ type: "end_turn" })
	})
})
