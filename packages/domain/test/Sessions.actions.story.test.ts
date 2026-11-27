import { SessionOutputs } from "../src/Session/SessionOutputs.external.ts"
import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import {
	AbandonTurn,
	SessionErrorEvent,
	TurnAbandoned,
} from "../src/Session/AbandonTurn.command.ts"
import {
	ArchiveSession,
	SessionArchived,
	SessionStatusTerminated,
} from "../src/Session/ArchiveSession.command.ts"
import {
	AgentMessage,
	SessionStatusIdle,
	SpanModelRequestEnd,
} from "../src/Session/CommitModelReply.command.ts"
import { ConfirmTool, UserToolConfirmation } from "../src/Session/ConfirmTool.command.ts"
import { CreateSession, SessionCreated } from "../src/Session/CreateSession.command.ts"
import {
	HARNESS_UNAVAILABLE,
	HARNESS_UNAVAILABLE_MESSAGE,
	Harness,
} from "../src/Session/Harness.external.ts"
import { TurnAwaiting, TurnContinued } from "../src/Session/PauseTurn.command.ts"
import { SpanModelRequestStart } from "../src/Session/RecordModelRequestStart.command.ts"
import { AgentCustomToolUse, AgentMcpToolUse } from "../src/Session/RecordToolCall.command.ts"
import { RequestToolAction } from "../src/Session/RequestToolAction.command.ts"
import {
	ReturnCustomToolResult,
	UserCustomToolResult,
} from "../src/Session/ReturnCustomToolResult.command.ts"
import { RunTurn, segmentKey, turnKey } from "../src/Session/RunTurn.saga.ts"
import { SendUserInterrupt, UserInterrupt } from "../src/Session/SendUserInterrupt.command.ts"
import {
	SendUserMessage,
	SessionStatusRunning,
	UserMessage,
} from "../src/Session/SendUserMessage.command.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import type { SessionId } from "../src/Session/Session.id.ts"
import { SessionAwaitingAction } from "../src/Session/SessionAwaitingAction.rejection.ts"
import { encodeToolUseIds } from "../src/Session/SessionTypes.ts"
import {
	ToolConfirmation,
	ToolConfirmationAnswered,
	ToolConfirmationRequested,
	ToolResultReturned,
} from "../src/Session/ToolConfirmation.aggregate.ts"
import { toolConfirmationId } from "../src/Session/ToolConfirmation.id.ts"
import { ToolConfirmationNotPending } from "../src/Session/ToolConfirmationNotPending.rejection.ts"
import { Sessions, SessionsHandlersLive } from "../src/Sessions.model.ts"

const story = Story.make(Sessions, {
	layer: SessionsHandlersLive,
	stub: [Harness, SessionOutputs],
})
const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")

const reply = (text: string) => ({
	thinking: null,
	text,
	input_tokens: 5,
	output_tokens: 2,
	stop_reason: { type: "end_turn" as const },
})

const started = (id: string) => {
	const session = Session.ref(id)
	const key = turnKey(session.id, 1)
	return {
		session,
		key,
		req1: `${key}:req:1`,
		steps: [
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
			Story.then(
				session,
				new SessionCreated({
					agent_id: "agent_001",
					agent_version: 1,
					environment_id: "env_001",
					title: null,
				}),
			),
			Story.when(new SendUserMessage({ session_id: session.id, text: "Go" })),
			Story.then(
				session,
				new UserMessage({ content: [{ type: "text", text: "Go" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: `${key}:req:1` }),
			),
			Story.call(Harness.runTurn, { session_id: session.id, turn: 1 }),
		] as const,
	}
}

const ask = (session_id: SessionId, tool_use_id: string, request: string) =>
	new RequestToolAction({
		session_id,
		confirmation_id: toolConfirmationId(session_id, tool_use_id),
		turn: 1,
		model_request_start_id: request,
		tool_use_id,
		name: "search",
		input: { query: "kiwi" },
		awaits: "confirmation",
		mcp_server_name: "docs",
	})

describe("Sessions: a turn that waits on its calls", () => {
	it.effect(
		"pauses inside the turn, refuses a message, and goes on in the same turn once allowed",
		() => {
			const { session, key, req1, steps } = started("sess_pause")
			const call = ToolConfirmation.ref(toolConfirmationId(session.id, "tu_7"))
			const req2 = `${segmentKey(session.id, 1, 2)}:req:2`
			return story(
				...steps,
				Story.when(ask(session.id, "tu_7", req1)),
				Story.then(
					call,
					new ToolConfirmationRequested({
						session_id: session.id,
						tool_use_id: "tu_7",
						turn: 1,
						awaits: "confirmation",
					}),
				),
				Story.then(
					session,
					new AgentMcpToolUse({
						tool_use_id: "tu_7",
						mcp_server_name: "docs",
						name: "search",
						input: { query: "kiwi" },
						evaluated_permission: "ask",
					}),
				),
				Story.fail(Harness.runTurn, {
					_tag: "TurnPaused",
					model_usage: { input_tokens: 4, output_tokens: 1 },
				}),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 4, output_tokens: 1 },
						is_error: false,
					}),
					new TurnAwaiting({ turn: 1 }),
					new SessionStatusIdle({
						stop_reason: { type: "requires_action" },
						event_ids: encodeToolUseIds(["tu_7"]),
						turn: 1,
					}),
				),
				Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
				Story.state(session, {
					_tag: "Running",
					turn: 1,
					open_model_request_id: null,
					model_requests_started: 1,
					pending_user_messages: 0,
					awaiting_calls: 1,
					awaiting_ids: encodeToolUseIds(["tu_7"]),
					paused: true,
					asked_calls: 1,
					interrupted: false,
				}),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Hurry" })),
				Story.rejected(new SessionAwaitingAction({ session_id: session.id })),
				Story.when(
					new AbandonTurn({
						session_id: session.id,
						turn: 1,
						segment: 1,
						error_type: "model_request_timeout",
						message: "Model request timed out.",
					}),
				),
				Story.then(session),
				Story.when(
					new ConfirmTool({
						session_id: session.id,
						confirmation_id: call.id,
						tool_use_id: "tu_7",
						result: "allow",
						deny_message: "",
					}),
				),
				Story.then(call, new ToolConfirmationAnswered({ result: "allow", deny_message: "" })),
				Story.then(
					session,
					new UserToolConfirmation({ processed_at: t0, tool_use_id: "tu_7", result: "allow" }),
					new SessionStatusRunning({ turn: 1 }),
					new TurnContinued({ turn: 1, segment: 2 }),
					new SpanModelRequestStart({ model_request_start_id: req2 }),
				),
				Story.call(Harness.runTurn, { session_id: session.id, turn: 1, segment: 2 }),
				Story.succeed(Harness.runTurn, reply("Found it")),
				Story.then(
					session,
					new AgentMessage({ content: [{ type: "text", text: "Found it" }] }),
					new SpanModelRequestEnd({
						model_request_start_id: req2,
						model_usage: { input_tokens: 5, output_tokens: 2 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
				),
				Story.call(SessionOutputs.publish, { session_id: session.id, turn: 1 }),
				Story.succeed(SessionOutputs.publish, undefined),
				Story.saga(RunTurn, segmentKey(session.id, 1, 2), {
					_tag: "Completed",
					result: { status: "completed" },
				}),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.when(
					new ConfirmTool({
						session_id: session.id,
						confirmation_id: call.id,
						tool_use_id: "tu_7",
						result: "deny",
						deny_message: "",
					}),
				),
				Story.rejected(
					new ToolConfirmationNotPending({ session_id: session.id, tool_use_id: "tu_7" }),
				),
			)
		},
	)

	it.effect("goes on at once when every call was answered before the segment ended", () => {
		const { session, key, req1, steps } = started("sess_answered_early")
		const call = ToolConfirmation.ref(toolConfirmationId(session.id, "tu_1"))
		const req2 = `${segmentKey(session.id, 1, 2)}:req:2`
		return story(
			...steps,
			Story.when(ask(session.id, "tu_1", req1)),
			Story.then(
				call,
				new ToolConfirmationRequested({
					session_id: session.id,
					tool_use_id: "tu_1",
					turn: 1,
					awaits: "confirmation",
				}),
			),
			Story.then(
				session,
				new AgentMcpToolUse({
					tool_use_id: "tu_1",
					mcp_server_name: "docs",
					name: "search",
					input: { query: "kiwi" },
					evaluated_permission: "ask",
				}),
			),
			Story.when(
				new ConfirmTool({
					session_id: session.id,
					confirmation_id: call.id,
					tool_use_id: "tu_1",
					result: "deny",
					deny_message: "Not now",
				}),
			),
			Story.then(call, new ToolConfirmationAnswered({ result: "deny", deny_message: "Not now" })),
			Story.then(
				session,
				new UserToolConfirmation({
					processed_at: t0,
					tool_use_id: "tu_1",
					result: "deny",
					deny_message: "Not now",
				}),
			),
			Story.fail(Harness.runTurn, {
				_tag: "TurnPaused",
				model_usage: { input_tokens: 3, output_tokens: 1 },
			}),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 3, output_tokens: 1 },
					is_error: false,
				}),
				new TurnContinued({ turn: 1, segment: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
			Story.call(Harness.runTurn, { session_id: session.id, turn: 1, segment: 2 }),
			Story.succeed(Harness.runTurn, reply("Skipped it")),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Skipped it" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 5, output_tokens: 2 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
			Story.call(SessionOutputs.publish, { session_id: session.id, turn: 1 }),
			Story.succeed(SessionOutputs.publish, undefined),
			Story.saga(RunTurn, segmentKey(session.id, 1, 2), {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect(
		"ends a paused turn on interrupt, and its waiting call can no longer be answered",
		() => {
			const { session, key, req1, steps } = started("sess_pause_interrupt")
			const call = ToolConfirmation.ref(toolConfirmationId(session.id, "tu_9"))
			return story(
				...steps,
				Story.when(ask(session.id, "tu_9", req1)),
				Story.then(
					call,
					new ToolConfirmationRequested({
						session_id: session.id,
						tool_use_id: "tu_9",
						turn: 1,
						awaits: "confirmation",
					}),
				),
				Story.then(
					session,
					new AgentMcpToolUse({
						tool_use_id: "tu_9",
						mcp_server_name: "docs",
						name: "search",
						input: { query: "kiwi" },
						evaluated_permission: "ask",
					}),
				),
				Story.fail(Harness.runTurn, {
					_tag: "TurnPaused",
					model_usage: { input_tokens: 2, output_tokens: 1 },
				}),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 2, output_tokens: 1 },
						is_error: false,
					}),
					new TurnAwaiting({ turn: 1 }),
					new SessionStatusIdle({
						stop_reason: { type: "requires_action" },
						event_ids: encodeToolUseIds(["tu_9"]),
						turn: 1,
					}),
				),
				Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(
					session,
					new UserInterrupt({ segment: 1, turn: 1 }),
					new SessionStatusIdle({
						stop_reason: { type: "interrupted" },
						turn: 1,
						event_ids: encodeToolUseIds(["tu_9"]),
					}),
				),
				Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
				Story.succeed(Harness.interrupt, undefined),
				Story.state(session, { _tag: "Idle", turn: 1 }),
				Story.when(
					new ConfirmTool({
						session_id: session.id,
						confirmation_id: call.id,
						tool_use_id: "tu_9",
						result: "allow",
						deny_message: "",
					}),
				),
				Story.rejected(
					new ToolConfirmationNotPending({ session_id: session.id, tool_use_id: "tu_9" }),
				),
			)
		},
	)

	it.effect("waits on a custom tool's result and takes it once", () => {
		const { session, key, req1, steps } = started("sess_custom")
		const call = ToolConfirmation.ref(toolConfirmationId(session.id, "tu_c"))
		const req2 = `${segmentKey(session.id, 1, 2)}:req:2`
		return story(
			...steps,
			Story.when(
				new RequestToolAction({
					session_id: session.id,
					confirmation_id: call.id,
					turn: 1,
					model_request_start_id: req1,
					tool_use_id: "tu_c",
					name: "lookup_order",
					input: { order: 42 },
					awaits: "result",
					mcp_server_name: "",
				}),
			),
			Story.then(
				call,
				new ToolConfirmationRequested({
					session_id: session.id,
					tool_use_id: "tu_c",
					turn: 1,
					awaits: "result",
				}),
			),
			Story.then(
				session,
				new AgentCustomToolUse({ tool_use_id: "tu_c", name: "lookup_order", input: { order: 42 } }),
			),
			Story.fail(Harness.runTurn, {
				_tag: "TurnPaused",
				model_usage: { input_tokens: 1, output_tokens: 1 },
			}),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 1, output_tokens: 1 },
					is_error: false,
				}),
				new TurnAwaiting({ turn: 1 }),
				new SessionStatusIdle({
					stop_reason: { type: "requires_action" },
					event_ids: encodeToolUseIds(["tu_c"]),
					turn: 1,
				}),
			),
			Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
			Story.when(
				new ConfirmTool({
					session_id: session.id,
					confirmation_id: call.id,
					tool_use_id: "tu_c",
					result: "allow",
					deny_message: "",
				}),
			),
			Story.rejected(
				new ToolConfirmationNotPending({ session_id: session.id, tool_use_id: "tu_c" }),
			),
			Story.when(
				new ReturnCustomToolResult({
					session_id: session.id,
					confirmation_id: call.id,
					custom_tool_use_id: "tu_c",
					text: "shipped",
					is_error: false,
				}),
			),
			Story.then(call, new ToolResultReturned({ text: "shipped", is_error: false })),
			Story.then(
				session,
				new UserCustomToolResult({
					processed_at: t0,
					custom_tool_use_id: "tu_c",
					content: [{ type: "text", text: "shipped" }],
				}),
				new SessionStatusRunning({ turn: 1 }),
				new TurnContinued({ turn: 1, segment: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.call(Harness.runTurn, { session_id: session.id, turn: 1, segment: 2 }),
			Story.succeed(Harness.runTurn, reply("It shipped")),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "It shipped" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 5, output_tokens: 2 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
			),
			Story.call(SessionOutputs.publish, { session_id: session.id, turn: 1 }),
			Story.succeed(SessionOutputs.publish, undefined),
			Story.saga(RunTurn, segmentKey(session.id, 1, 2), {
				_tag: "Completed",
				result: { status: "completed" },
			}),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect(
		"ends a turn whose harness paused without asking anything, so a pause never repeats",
		() => {
			const { session, key, req1, steps } = started("sess_pause_nothing")
			return story(
				...steps,
				Story.fail(Harness.runTurn, {
					_tag: "TurnPaused",
					model_usage: { input_tokens: 1, output_tokens: 1 },
				}),
				Story.then(
					session,
					new SpanModelRequestEnd({
						model_request_start_id: req1,
						model_usage: { input_tokens: 1, output_tokens: 1 },
						is_error: true,
					}),
					new SessionErrorEvent({
						error: {
							type: "harness_paused_without_calls",
							message: "The harness paused a turn that asked for no answer.",
							retry_status: { type: "exhausted" },
						},
					}),
					new SessionStatusIdle({
						stop_reason: { type: "retries_exhausted" },
						turn: 1,
						event_ids: "[]",
					}),
				),
				Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
				Story.state(session, { _tag: "Idle", turn: 1 }),
			)
		},
	)

	const pausedOn = (session_id: SessionId, tool_use_id: string, req1: string) => {
		const call = ToolConfirmation.ref(toolConfirmationId(session_id, tool_use_id))
		const session = Session.ref(session_id)
		return [
			Story.when(ask(session_id, tool_use_id, req1)),
			Story.then(
				call,
				new ToolConfirmationRequested({
					session_id,
					tool_use_id,
					turn: 1,
					awaits: "confirmation",
				}),
			),
			Story.then(
				session,
				new AgentMcpToolUse({
					tool_use_id,
					mcp_server_name: "docs",
					name: "search",
					input: { query: "kiwi" },
					evaluated_permission: "ask",
				}),
			),
			Story.fail(Harness.runTurn, {
				_tag: "TurnPaused",
				model_usage: { input_tokens: 2, output_tokens: 1 },
			}),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 2, output_tokens: 1 },
					is_error: false,
				}),
				new TurnAwaiting({ turn: 1 }),
				new SessionStatusIdle({
					stop_reason: { type: "requires_action" },
					turn: 1,
					event_ids: encodeToolUseIds([tool_use_id]),
				}),
			),
		] as const
	}

	it.effect("ends the turn when its harness pauses after a person interrupted it", () => {
		const { session, key, req1, steps } = started("sess_interrupt_then_pause")
		const call = ToolConfirmation.ref(toolConfirmationId(session.id, "tu_3"))
		return story(
			...steps,
			Story.when(ask(session.id, "tu_3", req1)),
			Story.then(
				call,
				new ToolConfirmationRequested({
					session_id: session.id,
					tool_use_id: "tu_3",
					turn: 1,
					awaits: "confirmation",
				}),
			),
			Story.then(
				session,
				new AgentMcpToolUse({
					tool_use_id: "tu_3",
					mcp_server_name: "docs",
					name: "search",
					input: { query: "kiwi" },
					evaluated_permission: "ask",
				}),
			),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.then(session, new UserInterrupt({ segment: 1, turn: 1 })),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.fail(Harness.runTurn, {
				_tag: "TurnPaused",
				model_usage: { input_tokens: 2, output_tokens: 1 },
			}),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req1,
					model_usage: { input_tokens: 2, output_tokens: 1 },
					is_error: true,
				}),
				new SessionStatusIdle({
					stop_reason: { type: "interrupted" },
					turn: 1,
					event_ids: encodeToolUseIds(["tu_3"]),
				}),
			),
			Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
			Story.state(session, { _tag: "Idle", turn: 1 }),
			Story.when(
				new ConfirmTool({
					session_id: session.id,
					confirmation_id: call.id,
					tool_use_id: "tu_3",
					result: "allow",
					deny_message: "",
				}),
			),
			Story.rejected(
				new ToolConfirmationNotPending({ session_id: session.id, tool_use_id: "tu_3" }),
			),
		)
	})

	it.effect("starts the queued turn when a turn that waits is interrupted", () => {
		const { session, key, req1, steps } = started("sess_pause_interrupt_drain")
		const req2 = `${turnKey(session.id, 2)}:req:1`
		return story(
			...steps,
			Story.when(new SendUserMessage({ session_id: session.id, text: "Then this" })),
			Story.then(session, new UserMessage({ content: [{ type: "text", text: "Then this" }] })),
			...pausedOn(session.id, "tu_4", req1),
			Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.then(
				session,
				new UserInterrupt({ segment: 1, turn: 1 }),
				new SessionStatusIdle({
					stop_reason: { type: "interrupted" },
					turn: 1,
					event_ids: encodeToolUseIds(["tu_4"]),
				}),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.call(Harness.runTurn, { session_id: session.id, turn: 2, input: ["Then this"] }),
			Story.succeed(Harness.runTurn, reply("Done")),
			Story.then(
				session,
				new AgentMessage({ content: [{ type: "text", text: "Done" }] }),
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 5, output_tokens: 2 },
					is_error: false,
				}),
				new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2, event_ids: "[]" }),
			),
			Story.call(SessionOutputs.publish, { session_id: session.id, turn: 2 }),
			Story.succeed(SessionOutputs.publish, undefined),
			Story.state(session, { _tag: "Idle", turn: 2 }),
		)
	})

	it.effect("says to answer the calls even when the queue behind a waiting turn is full", () => {
		const { session, key, req1, steps } = started("sess_pause_queue_full")
		const queued = Array.from({ length: 8 }, (_, index) => `Queued ${index + 1}`)
		return story(
			...steps,
			...queued.flatMap((text) => [
				Story.when(new SendUserMessage({ session_id: session.id, text })),
				Story.then(session, new UserMessage({ content: [{ type: "text", text }] })),
			]),
			...pausedOn(session.id, "tu_6", req1),
			Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
			Story.when(new SendUserMessage({ session_id: session.id, text: "One more" })),
			Story.rejected(new SessionAwaitingAction({ session_id: session.id })),
		)
	})

	it.effect("keeps stopping the harness of a waiting turn until the interrupt reaches it", () => {
		const { session, key, req1, steps } = started("sess_pause_interrupt_unreachable")
		return story(
			...steps,
			...pausedOn(session.id, "tu_8", req1),
			Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.then(
				session,
				new UserInterrupt({ segment: 1, turn: 1 }),
				new SessionStatusIdle({
					stop_reason: { type: "interrupted" },
					turn: 1,
					event_ids: encodeToolUseIds(["tu_8"]),
				}),
			),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.fail(Harness.interrupt, { _tag: "HarnessUnavailable" }),
			Story.then(session),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect("ignores the deadline of a segment the turn has left", () => {
		const { session, key, req1, steps } = started("sess_old_deadline")
		const call = ToolConfirmation.ref(toolConfirmationId(session.id, "tu_5"))
		const req2 = `${segmentKey(session.id, 1, 2)}:req:2`
		const deadline = (segment: number) =>
			new AbandonTurn({
				session_id: session.id,
				turn: 1,
				segment,
				error_type: "model_request_timeout",
				message: "Model request timed out.",
			})
		return story(
			...steps,
			...pausedOn(session.id, "tu_5", req1),
			Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
			Story.when(
				new ConfirmTool({
					session_id: session.id,
					confirmation_id: call.id,
					tool_use_id: "tu_5",
					result: "allow",
					deny_message: "",
				}),
			),
			Story.then(call, new ToolConfirmationAnswered({ result: "allow", deny_message: "" })),
			Story.then(
				session,
				new UserToolConfirmation({ processed_at: t0, tool_use_id: "tu_5", result: "allow" }),
				new SessionStatusRunning({ turn: 1 }),
				new TurnContinued({ turn: 1, segment: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.call(Harness.runTurn, { session_id: session.id, turn: 1, segment: 2 }),
			Story.when(deadline(1)),
			Story.then(session),
			Story.when(
				new AbandonTurn({
					segment: 1,
					session_id: session.id,
					turn: 1,
					error_type: "model_request_timeout",
					message: "Model request timed out.",
				}),
			),
			Story.then(session),
			Story.state(session, { _tag: "Running", turn: 1, open_model_request_id: req2 }),
			Story.when(deadline(2)),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req2,
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
			Story.succeed(Harness.interrupt, undefined),
			Story.fail(Harness.runTurn, { _tag: "TurnInterrupted" }),
			Story.then(session),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect("abandons the running segment when an interrupt cannot reach the harness", () => {
		const { session, key, req1, steps } = started("sess_interrupt_segment_two")
		const call = ToolConfirmation.ref(toolConfirmationId(session.id, "tu_7"))
		const req2 = `${segmentKey(session.id, 1, 2)}:req:2`
		return story(
			...steps,
			...pausedOn(session.id, "tu_7", req1),
			Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
			Story.when(
				new ConfirmTool({
					session_id: session.id,
					confirmation_id: call.id,
					tool_use_id: "tu_7",
					result: "allow",
					deny_message: "",
				}),
			),
			Story.then(call, new ToolConfirmationAnswered({ result: "allow", deny_message: "" })),
			Story.then(
				session,
				new UserToolConfirmation({ processed_at: t0, tool_use_id: "tu_7", result: "allow" }),
				new SessionStatusRunning({ turn: 1 }),
				new TurnContinued({ turn: 1, segment: 2 }),
				new SpanModelRequestStart({ model_request_start_id: req2 }),
			),
			Story.call(Harness.runTurn, { session_id: session.id, turn: 1, segment: 2 }),
			Story.when(new SendUserInterrupt({ session_id: session.id })),
			Story.then(session, new UserInterrupt({ turn: 1, segment: 2 })),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.fail(Harness.interrupt, { _tag: "HarnessUnavailable" }),
			Story.then(
				session,
				new SpanModelRequestEnd({
					model_request_start_id: req2,
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: true,
				}),
				new SessionErrorEvent({
					error: {
						type: HARNESS_UNAVAILABLE,
						message: HARNESS_UNAVAILABLE_MESSAGE,
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
			Story.succeed(Harness.interrupt, undefined),
			Story.fail(Harness.runTurn, { _tag: "TurnInterrupted" }),
			Story.then(session),
			Story.state(session, { _tag: "Idle", turn: 1 }),
		)
	})

	it.effect("names the calls a session ends with when it is archived while it waits", () => {
		const { session, key, req1, steps } = started("sess_pause_archive")
		return story(
			...steps,
			...pausedOn(session.id, "tu_6", req1),
			Story.saga(RunTurn, key, { _tag: "Completed", result: { status: "paused" } }),
			Story.when(new ArchiveSession({ session_id: session.id })),
			Story.then(
				session,
				new SessionStatusTerminated({ running_turn: 1, event_ids: encodeToolUseIds(["tu_6"]) }),
				new SessionArchived(),
			),
			Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
			Story.succeed(Harness.interrupt, undefined),
			Story.call(Harness.discardWorkspace, { session_id: session.id }),
			Story.succeed(Harness.discardWorkspace, undefined),
			Story.state(session, { _tag: "Terminated", archived: true }),
		)
	})
})
