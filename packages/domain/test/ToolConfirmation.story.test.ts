import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import {
	AgentMessage,
	SessionStatusIdle,
	SpanModelRequestEnd,
} from "../src/Session/CommitModelReply.command.ts"
import { ConfirmTool, UserToolConfirmation } from "../src/Session/ConfirmTool.command.ts"
import { CreateSession, SessionCreated } from "../src/Session/CreateSession.command.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { PauseTurn, UserMessagesQueued } from "../src/Session/PauseTurn.command.ts"
import { SpanModelRequestStart } from "../src/Session/RecordModelRequestStart.command.ts"
import { ResumeTurn } from "../src/Session/ResumeTurn.command.ts"
import { RunTurn, turnKey } from "../src/Session/RunTurn.saga.ts"
import { SendUserInterrupt, UserInterrupt } from "../src/Session/SendUserInterrupt.command.ts"
import {
	SendUserMessage,
	SessionAwaitingAction,
	SessionStatusRunning,
	UserMessage,
} from "../src/Session/SendUserMessage.command.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import { ToolUseIds } from "../src/Session/SessionTypes.ts"
import {
	CancelToolConfirmation,
	RequestToolConfirmation,
	ToolConfirmation,
	ToolConfirmationAnswered,
	ToolConfirmationCancelled,
	ToolConfirmationRequested,
} from "../src/Session/ToolConfirmation.aggregate.ts"
import { toolConfirmationId } from "../src/Session/ToolConfirmation.id.ts"
import { ToolConfirmationNotPending } from "../src/Session/ToolConfirmationNotPending.rejection.ts"
import { RESUME_INPUT } from "../src/Session/TurnInput.view.ts"
import { Sessions, SessionsHandlersLive } from "../src/Sessions.model.ts"

const story = Story.make(Sessions, {
	layer: SessionsHandlersLive,
	stub: [Harness],
})

const created = new SessionCreated({
	agent_id: "agent_001",
	agent_version: 1,
	environment_id: "env_001",
	title: null,
})

const NO_USAGE = { input_tokens: 0, output_tokens: 0 }

const world = (id: string) => {
	const session = Session.ref(id)
	const call = (toolUseId: string) =>
		ToolConfirmation.ref(toolConfirmationId(session.id, toolUseId))
	const request = (turn: number) => `${turnKey(session.id, turn)}:req:1`
	const turnArgs = (turn: number, input: ReadonlyArray<string>) => ({
		session_id: session.id,
		agent_id: "agent_001",
		agent_version: 1,
		environment_id: "env_001",
		turn,
		input,
		...(input.length === 1 && input[0] === RESUME_INPUT ? { resume: true as const } : {}),
	})
	// A session whose first turn the harness has just reported as paused on `waiting`.
	const pausedOn = (...waiting: ReadonlyArray<string>) => [
		Story.when(
			new CreateSession({
				session_id: session.id,
				agent_id: "agent_001",
				agent_version: 1,
				environment_id: "env_001",
				title: null,
			}),
		),
		Story.then(session, created),
		Story.when(new SendUserMessage({ session_id: session.id, text: "Post it" })),
		Story.then(
			session,
			new UserMessage({ content: [{ type: "text", text: "Post it" }] }),
			new SessionStatusRunning({ turn: 1 }),
			new SpanModelRequestStart({ model_request_start_id: request(1) }),
		),
		Story.call("turn-1", Harness.runTurn, turnArgs(1, ["Post it"])),
		...waiting.flatMap((toolUseId) => [
			Story.when(
				new RequestToolConfirmation({
					confirmation_id: call(toolUseId).id,
					session_id: session.id,
					tool_use_id: toolUseId,
				}),
			),
			Story.then(
				call(toolUseId),
				new ToolConfirmationRequested({ session_id: session.id, tool_use_id: toolUseId }),
			),
		]),
		Story.when(
			new PauseTurn({
				session_id: session.id,
				turn: 1,
				request_seq: 1,
				model_request_start_id: request(1),
				event_ids: ToolUseIds.encode(waiting),
			}),
		),
		Story.then(
			session,
			new SpanModelRequestEnd({
				model_request_start_id: request(1),
				model_usage: NO_USAGE,
				is_error: false,
			}),
			new SessionStatusIdle({
				stop_reason: { type: "requires_action" },
				event_ids: ToolUseIds.encode(waiting),
				turn: 1,
			}),
		),
		Story.fail("turn-1", Harness.runTurn, { _tag: "TurnPaused" }),
		Story.saga(RunTurn, turnKey(session.id, 1), {
			_tag: "Completed",
			result: { status: "paused" },
		}),
		Story.state(session, { _tag: "Idle", turn: 1, awaiting: true }),
	]
	const confirm = (toolUseId: string, result: "allow" | "deny", deny_message = "") =>
		new ConfirmTool({
			session_id: session.id,
			confirmation_id: call(toolUseId).id,
			tool_use_id: toolUseId,
			result,
			deny_message,
		})
	// Ends a turn the story has no more to say about, leaving nothing unanswered.
	const leave = (turn: number, input: ReadonlyArray<string>, asked = false) => [
		...(asked ? [] : [Story.call(`turn-${turn}`, Harness.runTurn, turnArgs(turn, input))]),
		Story.fail(`turn-${turn}`, Harness.runTurn, { _tag: "TurnPaused" }),
	]
	return { session, call, request, turnArgs, pausedOn, confirm, leave }
}

describe("Tool calls that wait for a person", () => {
	it.effect(
		"pauses a turn, takes no message meanwhile, and carries on in a new turn from the first answer",
		() => {
			const { session, call, request, turnArgs, pausedOn, confirm } = world("sess_confirm_allow")
			return story(
				...pausedOn("call-1"),
				Story.when(new SendUserMessage({ session_id: session.id, text: "Hurry up" })),
				Story.rejected(new SessionAwaitingAction({ session_id: session.id })),
				Story.when(confirm("call-1", "allow")),
				Story.then(
					call("call-1"),
					new ToolConfirmationAnswered({ result: "allow", deny_message: "" }),
				),
				Story.then(
					session,
					new UserToolConfirmation({ tool_use_id: "call-1", result: "allow" }),
					new SessionStatusRunning({ turn: 2 }),
					new SpanModelRequestStart({ model_request_start_id: request(2) }),
				),
				Story.state(call("call-1"), { status: "allowed" }),
				// Nobody typed anything: the turn that carries the paused one on is told so.
				Story.call("turn-2", Harness.runTurn, turnArgs(2, [RESUME_INPUT])),
				// The answer stands: a second one is refused, and so is one for another session's call.
				Story.when(confirm("call-1", "deny", "Changed my mind")),
				Story.rejected(
					new ToolConfirmationNotPending({ session_id: session.id, tool_use_id: "call-1" }),
				),
				Story.succeed("turn-2", Harness.runTurn, {
					thinking: null,
					text: "Posted.",
					input_tokens: 9,
					output_tokens: 5,
					stop_reason: { type: "end_turn" },
				}),
				Story.then(
					session,
					new AgentMessage({ content: [{ type: "text", text: "Posted." }] }),
					new SpanModelRequestEnd({
						model_request_start_id: request(2),
						model_usage: { input_tokens: 9, output_tokens: 5 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 2 }),
				),
				Story.state(session, { _tag: "Idle", turn: 2, awaiting: false }),
			)
		},
	)

	it.effect("keeps a denial's reason for the harness and for the session's events", () => {
		const { session, call, request, pausedOn, confirm, leave } = world("sess_confirm_deny")
		return story(
			...pausedOn("call-1"),
			Story.when(confirm("call-1", "deny", "Not on a Friday.")),
			Story.then(
				call("call-1"),
				new ToolConfirmationAnswered({ result: "deny", deny_message: "Not on a Friday." }),
			),
			Story.then(
				session,
				new UserToolConfirmation({
					tool_use_id: "call-1",
					result: "deny",
					deny_message: "Not on a Friday.",
				}),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: request(2) }),
			),
			Story.state(call("call-1"), { status: "denied", deny_message: "Not on a Friday." }),
			...leave(2, [RESUME_INPUT]),
		)
	})

	it.effect("refuses an answer for a call nobody asked about", () => {
		const { session, pausedOn, confirm } = world("sess_confirm_unknown")
		return story(
			...pausedOn("call-1"),
			Story.when(confirm("call-other", "allow")),
			Story.rejected(
				new ToolConfirmationNotPending({ session_id: session.id, tool_use_id: "call-other" }),
			),
			Story.state(session, { _tag: "Idle", turn: 1, awaiting: true }),
		)
	})

	it.effect("takes an answer for a second call while the first answer's turn runs", () => {
		const { session, call, request, turnArgs, pausedOn, confirm, leave } = world("sess_confirm_two")
		return story(
			...pausedOn("call-a", "call-b"),
			Story.when(confirm("call-a", "allow")),
			Story.then(
				call("call-a"),
				new ToolConfirmationAnswered({ result: "allow", deny_message: "" }),
			),
			Story.then(
				session,
				new UserToolConfirmation({ tool_use_id: "call-a", result: "allow" }),
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: request(2) }),
			),
			Story.call("turn-2", Harness.runTurn, turnArgs(2, [RESUME_INPUT])),
			// The running turn picks this one up; the session does not start another.
			Story.when(confirm("call-b", "allow")),
			Story.then(
				call("call-b"),
				new ToolConfirmationAnswered({ result: "allow", deny_message: "" }),
			),
			Story.then(session, new UserToolConfirmation({ tool_use_id: "call-b", result: "allow" })),
			Story.state(session, { _tag: "Running", turn: 2 }),
			...leave(2, [RESUME_INPUT], true),
		)
	})

	it.effect(
		"gives up the waiting calls on an interrupt, after which their answers are refused",
		() => {
			const { session, call, pausedOn, confirm, leave, request } = world("sess_confirm_interrupt")
			return story(
				...pausedOn("call-1"),
				Story.when(new SendUserInterrupt({ session_id: session.id })),
				Story.then(session, new UserInterrupt()),
				Story.state(session, { _tag: "Idle", turn: 1, awaiting: false }),
				// The harness is told to stop, which is where the parked call ends.
				Story.call(Harness.interrupt, { session_id: session.id, turn: 1 }),
				Story.succeed(Harness.interrupt, undefined),
				Story.when(confirm("call-1", "allow")),
				Story.rejected(
					new ToolConfirmationNotPending({ session_id: session.id, tool_use_id: "call-1" }),
				),
				Story.when(new CancelToolConfirmation({ confirmation_id: call("call-1").id })),
				Story.then(call("call-1"), new ToolConfirmationCancelled()),
				Story.when(new CancelToolConfirmation({ confirmation_id: call("call-1").id })),
				Story.then(call("call-1")),
				// The session is an ordinary idle one again.
				Story.when(new SendUserMessage({ session_id: session.id, text: "Something else" })),
				Story.then(
					session,
					new UserMessage({ content: [{ type: "text", text: "Something else" }] }),
					new SessionStatusRunning({ turn: 2 }),
					new SpanModelRequestStart({ model_request_start_id: request(2) }),
				),
				...leave(2, ["Something else"]),
			)
		},
	)

	it.effect("does not pause a turn that has messages queued behind it", () => {
		const session = Session.ref("sess_pause_queued")
		const request = `${turnKey(session.id, 1)}:req:1`
		return story(
			Story.given(
				session,
				created,
				new UserMessage({ content: [{ type: "text", text: "Post it" }] }),
				new SessionStatusRunning({ turn: 1 }),
				new SpanModelRequestStart({ model_request_start_id: request }),
				new UserMessage({ content: [{ type: "text", text: "Also this" }] }),
			),
			Story.when(
				new PauseTurn({
					session_id: session.id,
					turn: 1,
					request_seq: 1,
					model_request_start_id: request,
					event_ids: ToolUseIds.encode(["call-1"]),
				}),
			),
			Story.rejected(new UserMessagesQueued({ session_id: session.id })),
			Story.state(session, { _tag: "Running", turn: 1, pending_user_messages: 1 }),
		)
	})

	it.effect("resumes a paused turn once, however often it is asked", () => {
		const { session, request, pausedOn, leave } = world("sess_resume_once")
		return story(
			...pausedOn("call-1"),
			Story.when(new ResumeTurn({ session_id: session.id, turn: 1 })),
			Story.then(
				session,
				new SessionStatusRunning({ turn: 2 }),
				new SpanModelRequestStart({ model_request_start_id: request(2) }),
			),
			Story.when(new ResumeTurn({ session_id: session.id, turn: 1 })),
			Story.then(session),
			Story.state(session, { _tag: "Running", turn: 2 }),
			...leave(2, [RESUME_INPUT]),
		)
	})
})
