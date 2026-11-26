import { describe, expect, it } from "@effect/vitest"
import * as fc from "fast-check"
import type { JsonSessionEvent } from "../src/Checkfu.ts"
import {
	emptySessionFold,
	foldSessionEvent,
	foldSessionEvents,
	outstandingCalls,
} from "../src/SessionFold.ts"
import type { SessionFold, SessionFoldEvent, SessionFoldRetention } from "../src/SessionFold.ts"

const RETENTIONS: ReadonlyArray<SessionFoldRetention> = ["all", "waiting", "none"]
const IDS = ["tu_1", "tu_2", "tu_3"] as const

const id = fc.constantFrom(...IDS)
const text = (value: string) => [{ type: "text" as const, text: value }]

const anEvent: fc.Arbitrary<SessionFoldEvent> = fc.oneof(
	fc.record(
		{
			type: fc.constant("agent.tool_use" as const),
			tool_use_id: id,
			name: fc.constant("read"),
			input: fc.constant({}),
		},
		{ requiredKeys: ["type", "tool_use_id", "name", "input"] },
	),
	fc.record({
		type: fc.constant("agent.mcp_tool_use" as const),
		tool_use_id: id,
		mcp_server_name: fc.constant("docs"),
		name: fc.constant("search"),
		input: fc.constant({ query: "q" }),
		evaluated_permission: fc.constantFrom("ask" as const, "allow" as const),
	}),
	fc.record({
		type: fc.constant("agent.custom_tool_use" as const),
		tool_use_id: id,
		name: fc.constant("refund"),
		input: fc.constant({ order: 7 }),
	}),
	fc.record({
		type: fc.constantFrom("agent.tool_result" as const, "agent.mcp_tool_result" as const),
		tool_use_id: id,
		content: fc.constant(text("out")),
		is_error: fc.boolean(),
	}),
	fc.record({
		type: fc.constant("user.tool_confirmation" as const),
		tool_use_id: id,
		result: fc.constantFrom("allow" as const, "deny" as const),
	}),
	fc.record({
		type: fc.constant("user.custom_tool_result" as const),
		custom_tool_use_id: id,
		content: fc.constant(text("done")),
	}),
	fc.record({
		type: fc.constant("session.status_running" as const),
		turn: fc.integer({ min: 1, max: 4 }),
	}),
	fc.record({
		type: fc.constant("session.status_idle" as const),
		turn: fc.integer({ min: 1, max: 4 }),
		stop_reason: fc.record({
			type: fc.constant("requires_action" as const),
			event_ids: fc.uniqueArray(id, { maxLength: 3 }),
		}),
	}),
	fc.record({
		type: fc.constant("session.status_idle" as const),
		turn: fc.integer({ min: 1, max: 4 }),
		stop_reason: fc.record({ type: fc.constantFrom("end_turn" as const, "interrupted" as const) }),
		cancelled_event_ids: fc.uniqueArray(id, { maxLength: 2 }),
	}),
	fc.constant({ type: "session.status_terminated" as const }),
	fc.constant({ type: "session.archived" as const }),
	fc.constant({ type: "user.interrupt" as const }),
)

const someEvents = fc
	.array(anEvent, { maxLength: 40, size: "max" })
	.map((events) => events.map((event, index) => ({ ...event, seq: index + 1 })))

const fold = (events: Iterable<SessionFoldEvent>, retain: SessionFoldRetention = "all") =>
	foldSessionEvents(emptySessionFold(retain), events)

const endsTurn = (event: SessionFoldEvent): boolean =>
	(event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") ||
	event.type === "session.status_terminated" ||
	event.type === "session.archived"

describe("the session fold", () => {
	it("reads the API's own events, decoded or as JSON", () => {
		const accepts = (event: SessionFoldEvent) => event
		const json = (event: JsonSessionEvent) => accepts(event)
		expect(json).toBeTypeOf("function")
	})

	it("folds a history and then what follows to the same state as folding it all at once", () => {
		fc.assert(
			fc.property(someEvents, fc.nat(40), fc.constantFrom(...RETENTIONS), (events, at, retain) => {
				const cut = Math.min(at, events.length)
				const resumed = foldSessionEvents(fold(events.slice(0, cut), retain), events.slice(cut))
				expect(resumed).toEqual(fold(events, retain))
				const stepped = events.reduce(foldSessionEvent, emptySessionFold(retain))
				expect(stepped).toEqual(fold(events, retain))
			}),
		)
	})

	it("waits only on calls its pause named that nothing has answered or ended", () => {
		fc.assert(
			fc.property(someEvents, (events) => {
				let requested = new Set<string>()
				let answered = new Set<string>()
				let state: SessionFold = emptySessionFold("none")
				for (const event of events) {
					state = foldSessionEvent(state, event)
					if (
						event.type === "session.status_idle" &&
						event.stop_reason.type === "requires_action"
					) {
						requested = new Set(event.stop_reason.event_ids)
					} else if (event.type === "session.status_running" || endsTurn(event)) {
						requested = new Set()
					}
					if (endsTurn(event)) {
						answered = new Set()
					} else if (
						event.type === "user.tool_confirmation" ||
						event.type === "agent.tool_result" ||
						event.type === "agent.mcp_tool_result"
					) {
						answered.add(event.tool_use_id)
					} else if (event.type === "user.custom_tool_result") {
						answered.add(event.custom_tool_use_id)
					}
					expect([...outstandingCalls(state)]).toEqual(
						[...requested].filter((call) => !answered.has(call)),
					)
				}
			}),
		)
	})

	it("never calls a denied call failed, whatever arrives after the denial", () => {
		fc.assert(
			fc.property(someEvents, (events) => {
				const first = new Map<string, string>()
				const denied = new Set<string>()
				let state = emptySessionFold()
				for (const event of events) {
					state = foldSessionEvent(state, event)
					const answer =
						event.type === "user.tool_confirmation"
							? ([event.tool_use_id, event.result] as const)
							: event.type === "user.custom_tool_result"
								? ([event.custom_tool_use_id, "result"] as const)
								: undefined
					if (answer !== undefined && !first.has(answer[0])) {
						first.set(answer[0], answer[1])
						if (answer[1] === "deny") {
							denied.add(answer[0])
						}
					}
					for (const call of denied) {
						expect(state.calls.get(call)?.status ?? "denied").toBe("denied")
					}
				}
			}),
		)
	})

	it("agrees on the turn however much it keeps, and keeps only what still may wait", () => {
		fc.assert(
			fc.property(someEvents, (events) => {
				const [all, waiting, none] = RETENTIONS.map((retain) => fold(events, retain))
				expect(waiting?.turn).toEqual(all?.turn)
				expect(none?.turn).toEqual(all?.turn)
				expect(none?.calls.size).toBe(0)
				const waits = outstandingCalls(waiting ?? emptySessionFold())
				for (const [call, kept] of waiting?.calls ?? []) {
					expect(kept.status).toBe(waits.has(call) ? "waiting" : "running")
					expect(kept.kind).not.toBe("tool")
					expect(waiting?.closed.has(call)).toBe(false)
				}
				const lastEnd = events.findLastIndex(endsTurn)
				const seen = new Set(
					events
						.slice(lastEnd + 1)
						.flatMap((event) =>
							event.type === "agent.custom_tool_use" ||
							(event.type === "agent.mcp_tool_use" && event.evaluated_permission === "ask")
								? [event.tool_use_id]
								: [],
						),
				)
				for (const call of outstandingCalls(waiting ?? emptySessionFold())) {
					expect(waiting?.calls.has(call)).toBe(seen.has(call))
				}
			}),
		)
	})

	it("knows the last settled turn: one that runs or pauses settles the one before it, and termination settles nothing", () => {
		const after = (events: ReadonlyArray<SessionFoldEvent>) =>
			foldSessionEvents(emptySessionFold("none"), events).settled
		const idle = (turn: number, type: "end_turn" | "refusal") => ({
			type: "session.status_idle" as const,
			turn,
			stop_reason: { type },
		})
		expect(after([{ type: "session.status_running", turn: 3 }])).toEqual({
			turn: 2,
			stopReason: undefined,
		})
		expect(after([idle(3, "refusal")])).toEqual({ turn: 3, stopReason: "refusal" })
		expect(
			after([
				idle(3, "end_turn"),
				{ type: "session.status_running", turn: 4 },
				{ type: "session.status_terminated" },
			]),
		).toEqual({ turn: 3, stopReason: "end_turn" })
		expect(
			after([
				{ type: "session.status_running", turn: 2 },
				{
					type: "session.status_idle",
					turn: 2,
					stop_reason: { type: "requires_action", event_ids: ["tu_1"] },
				},
			]),
		).toEqual({ turn: 1, stopReason: undefined })
	})

	it("needs nothing from before the last turn that ended to follow the open one", () => {
		fc.assert(
			fc.property(
				someEvents,
				fc.constantFrom("waiting" as const, "none" as const),
				(events, retain) => {
					const lastEnd = events.findLastIndex(
						(event) => event.type === "session.status_idle" && endsTurn(event),
					)
					fc.pre(lastEnd >= 0)
					const whole = fold(events, retain)
					const tail = fold(events.slice(lastEnd), retain)
					expect(tail.turn).toEqual(whole.turn)
					expect(tail.calls).toEqual(whole.calls)
				},
			),
		)
	})

	it("keeps a denied call denied when the error that reports the block arrives", () => {
		const events: ReadonlyArray<SessionFoldEvent> = [
			{ type: "session.status_running", turn: 1 },
			{
				type: "agent.mcp_tool_use",
				tool_use_id: "tu_1",
				mcp_server_name: "github",
				name: "delete_repo",
				input: { repo: "a" },
				evaluated_permission: "ask",
			},
			{
				type: "session.status_idle",
				turn: 1,
				seq: 7,
				stop_reason: { type: "requires_action", event_ids: ["tu_1"] },
			},
			{ type: "user.tool_confirmation", tool_use_id: "tu_1", result: "deny", deny_message: "no" },
			{ type: "session.status_running", turn: 1 },
			{
				type: "agent.mcp_tool_result",
				tool_use_id: "tu_1",
				content: text("Blocked: no"),
				is_error: true,
				rejected: "blocked",
			},
		]
		const call = fold(events).calls.get("tu_1")
		expect(call?.status).toBe("denied")
		expect(call?.outcome?.text).toBe("Blocked: no")
		expect(call?.answer).toEqual({ kind: "deny", message: "no" })
	})

	it("says a call did not run when its result is a rejection, never that it ran or failed", () => {
		const calls = fold([
			{ type: "session.status_running", turn: 1 },
			{ type: "agent.tool_use", tool_use_id: "tu_1", name: "missing", input: {} },
			{
				type: "agent.tool_result",
				tool_use_id: "tu_1",
				content: text("Tool missing is not available"),
				is_error: true,
				rejected: "unavailable",
			},
			{ type: "agent.tool_use", tool_use_id: "tu_2", name: "lookup", input: {} },
			{ type: "agent.tool_result", tool_use_id: "tu_2", content: text("exit 1"), is_error: true },
		]).calls
		expect(calls.get("tu_1")?.status).toBe("rejected")
		expect(calls.get("tu_1")?.outcome?.rejected).toBe("unavailable")
		expect(calls.get("tu_2")?.status).toBe("error")
	})

	it("subtracts each answer from a pause, and lets go of what it kept for the call", () => {
		const paused: ReadonlyArray<SessionFoldEvent> = [
			{ type: "session.status_running", turn: 2 },
			{
				type: "agent.mcp_tool_use",
				tool_use_id: "tu_1",
				mcp_server_name: "github",
				name: "merge",
				input: { pr: 4 },
				evaluated_permission: "ask",
			},
			{ type: "agent.custom_tool_use", tool_use_id: "tu_2", name: "refund", input: { order: 7 } },
			{
				type: "session.status_idle",
				turn: 2,
				seq: 12,
				stop_reason: { type: "requires_action", event_ids: ["tu_1", "tu_2"] },
			},
		]
		const waiting = fold(paused, "waiting")
		expect(waiting.turn).toEqual({
			status: "paused",
			turn: 2,
			seq: 12,
			outstanding: new Set(["tu_1", "tu_2"]),
		})
		expect(waiting.calls.get("tu_1")).toMatchObject({
			server: "github",
			name: "merge",
			input: { pr: 4 },
			awaits: "confirmation",
			status: "waiting",
		})
		const one = foldSessionEvent(waiting, {
			type: "user.tool_confirmation",
			tool_use_id: "tu_1",
			result: "allow",
		})
		expect([...outstandingCalls(one)]).toEqual(["tu_2"])
		expect([...one.calls.keys()]).toEqual(["tu_2"])
		const both = foldSessionEvent(one, {
			type: "user.custom_tool_result",
			custom_tool_use_id: "tu_2",
			content: text("refunded"),
		})
		expect(both.turn.status).toBe("paused")
		expect(outstandingCalls(both).size).toBe(0)
		expect(both.calls.size).toBe(0)
		const resumed = foldSessionEvent(both, { type: "session.status_running", turn: 2 })
		expect(resumed.turn).toEqual({ status: "running", turn: 2 })
	})

	it("cancels what a turn or a session ended without", () => {
		const events: ReadonlyArray<SessionFoldEvent> = [
			{ type: "agent.tool_use", tool_use_id: "tu_1", name: "codemode", input: {} },
			{
				type: "agent.tool_use",
				tool_use_id: "tu_2",
				name: "read",
				input: {},
			},
			{
				type: "agent.mcp_tool_use",
				tool_use_id: "tu_3",
				mcp_server_name: "docs",
				name: "search",
				input: {},
				evaluated_permission: "ask",
			},
			{ type: "user.tool_confirmation", tool_use_id: "tu_3", result: "allow" },
			{
				type: "session.status_idle",
				turn: 1,
				stop_reason: { type: "interrupted" },
				cancelled_event_ids: ["tu_9"],
			},
			{ type: "agent.tool_result", tool_use_id: "tu_2", content: text("late"), is_error: false },
		]
		const state = fold(events)
		expect(state.calls.get("tu_1")?.status).toBe("cancelled")
		expect(state.calls.get("tu_2")?.status).toBe("done")
		expect(state.calls.get("tu_3")?.status).toBe("cancelled")
		expect(state.turn).toEqual({ status: "settled", turn: 1, stopReason: "interrupted" })
		expect(fold(events, "waiting").calls.size).toBe(0)
	})
})
