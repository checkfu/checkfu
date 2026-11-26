import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ApiError } from "../src/api.ts"
import {
	answerFailure,
	NOT_WAITING,
	sendFailure,
	WAITING_REFUSES_MESSAGES,
} from "../src/pages/tool-call.tsx"
import type { SendAnswer } from "../src/pages/tool-call.tsx"
import { Transcript } from "../src/pages/transcript.tsx"
import {
	allowEvent,
	customResultEvent,
	denyEvent,
	loadUntilWaitingCallsSeen,
	sessionCallsOf,
	toolCallsOf,
} from "../src/tool-calls.ts"

const at = "2026-11-24T00:00:00.000Z"
type Of<T extends JsonSessionEvent["type"]> = Extract<JsonSessionEvent, { readonly type: T }>
type Body<T extends JsonSessionEvent["type"]> = Omit<Of<T>, "id" | "seq" | "created_at">
let seq = 0
const event = <T extends JsonSessionEvent["type"]>(body: Body<T>): Of<T> => {
	seq += 1
	return { id: `evt_${seq}`, seq, created_at: at, ...body } as Of<T>
}

const use = (id: string, name: string, extra: Partial<Body<"agent.tool_use">> = {}) =>
	event<"agent.tool_use">({
		type: "agent.tool_use",
		tool_use_id: id,
		name,
		input: { path: "/a" },
		...extra,
	})
const mcpUse = (id: string, name: string, extra: Partial<Body<"agent.mcp_tool_use">> = {}) =>
	event<"agent.mcp_tool_use">({
		type: "agent.mcp_tool_use",
		tool_use_id: id,
		mcp_server_name: "github",
		name,
		input: { repo: "checkfu" },
		...extra,
	})
const customUse = (id: string, name: string) =>
	event<"agent.custom_tool_use">({
		type: "agent.custom_tool_use",
		tool_use_id: id,
		name,
		input: { order: 42 },
	})
const result = (id: string, text: string, extra: Partial<Body<"agent.tool_result">> = {}) =>
	event<"agent.tool_result">({
		type: "agent.tool_result",
		tool_use_id: id,
		content: [{ type: "text", text }],
		is_error: false,
		...extra,
	})
const waitingOn = (...ids: ReadonlyArray<string>) =>
	event<"session.status_idle">({
		type: "session.status_idle",
		turn: 1,
		stop_reason: { type: "requires_action", event_ids: [...ids] },
	})
const running = () => event<"session.status_running">({ type: "session.status_running", turn: 1 })

const render = (events: ReadonlyArray<JsonSessionEvent>, send?: SendAnswer) =>
	renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<Transcript events={events} send={send} />
		</QueryClientProvider>,
	)

const noSend: SendAnswer = async () => undefined
const count = (html: string, text: string) => html.split(text).length - 1

describe("tool calls", () => {
	it("pairs a result with its use whichever arrives first", () => {
		const calls = toolCallsOf([result("tu_1", "file text"), use("tu_1", "read")])
		expect(calls.calls.get("tu_1")).toMatchObject({
			name: "read",
			status: "done",
			outcome: { text: "file text", isError: false },
		})
	})

	it("shows a call with no result yet as running, and a failed one as failed", () => {
		const calls = toolCallsOf([
			use("tu_1", "read"),
			use("tu_2", "write"),
			result("tu_2", "no", { is_error: true }),
		])
		expect(calls.calls.get("tu_1")?.status).toBe("running")
		expect(calls.calls.get("tu_2")?.status).toBe("error")
	})

	it("shows a call Pi refused as not run, with why, and never as failed", () => {
		const events = [
			use("tu_1", "missing"),
			result("tu_1", "Tool missing is not available", { is_error: true, rejected: "unavailable" }),
		]
		expect(toolCallsOf(events).calls.get("tu_1")?.status).toBe("rejected")
		const html = render(events)
		expect(html).toContain("Not run")
		expect(html).toContain("This call did not run: the tool is not available.")
		expect(html).not.toContain("Failed")
	})

	it("shows a script's own code, and a call it waited on as a call of its own", () => {
		const html = render([
			use("tu_s", "codemode", { input: { code: "await tools.search_issues({})" } }),
			mcpUse("tu_n1", "search_issues", { evaluated_permission: "ask" }),
			result("tu_n1", "3 issues"),
			result("tu_s", "done"),
		])
		expect(html).toContain("await tools.search_issues")
		expect(count(html, ">search_issues<")).toBe(1)
		expect(html.indexOf(">search_issues<")).toBeGreaterThan(html.indexOf(">codemode<"))
	})

	it("marks inputs and results the log shortened", () => {
		const html = render([
			use("tu_1", "read", { truncated: true }),
			result("tu_1", "abc", { truncated: true }),
		])
		expect(count(html, "Shortened in the log.")).toBe(2)
	})

	it("offers Allow and Deny on a call waiting for approval", () => {
		const html = render(
			[mcpUse("tu_1", "delete_repo", { evaluated_permission: "ask" }), waitingOn("tu_1")],
			noSend,
		)
		expect(html).toContain("Waiting on you")
		expect(html).toContain(">Allow<")
		expect(html).toContain(">Deny<")
		expect(html).toContain("<details open")
	})

	it("offers a result form on a waiting client tool", () => {
		const html = render([customUse("tu_1", "refund_order"), waitingOn("tu_1")], noSend)
		expect(html).toContain("in your application")
		expect(html).toContain("Send result")
		expect(html).not.toContain(">Allow<")
	})

	it("shows no answer controls without a way to send", () => {
		const html = render([mcpUse("tu_1", "delete_repo"), waitingOn("tu_1")])
		expect(html).toContain("Waiting on you")
		expect(html).not.toContain(">Allow<")
	})

	it("shows the answer once given, in place of the controls", () => {
		const allowed = render(
			[
				mcpUse("tu_1", "delete_repo"),
				waitingOn("tu_1"),
				event<"user.tool_confirmation">({
					type: "user.tool_confirmation",
					tool_use_id: "tu_1",
					result: "allow",
				}),
				running(),
			],
			noSend,
		)
		expect(allowed).toContain("You allowed this call.")
		expect(allowed).not.toContain(">Allow<")

		const denied = toolCallsOf([
			mcpUse("tu_2", "delete_repo"),
			waitingOn("tu_2"),
			event<"user.tool_confirmation">({
				type: "user.tool_confirmation",
				tool_use_id: "tu_2",
				result: "deny",
				deny_message: "too risky",
			}),
		])
		expect(denied.calls.get("tu_2")).toMatchObject({
			status: "denied",
			answer: { kind: "deny", message: "too risky" },
		})

		const answered = render(
			[
				customUse("tu_3", "refund_order"),
				waitingOn("tu_3"),
				event<"user.custom_tool_result">({
					type: "user.custom_tool_result",
					custom_tool_use_id: "tu_3",
					content: [{ type: "text", text: "refunded" }],
				}),
			],
			noSend,
		)
		expect(answered).toContain("Your application answered")
		expect(answered).toContain("refunded")
		expect(answered).not.toContain("Send result")
	})

	it("keeps a denied call labelled denied once the error that reports the block arrives", () => {
		const events = [
			mcpUse("tu_1", "delete_repo", { evaluated_permission: "ask" }),
			waitingOn("tu_1"),
			event<"user.tool_confirmation">({
				type: "user.tool_confirmation",
				tool_use_id: "tu_1",
				result: "deny",
				deny_message: "too risky",
			}),
			running(),
			event<"agent.mcp_tool_result">({
				type: "agent.mcp_tool_result",
				tool_use_id: "tu_1",
				content: [{ type: "text", text: "The call was denied: too risky" }],
				is_error: true,
			}),
		]
		expect(toolCallsOf(events).calls.get("tu_1")?.status).toBe("denied")
		const html = render(events, noSend)
		expect(html).toContain("Denied")
		expect(html).not.toContain("Failed")
		expect(html).toContain("The call was denied: too risky")
		expect(html).toContain("You denied this call: too risky")
	})

	it("shows a call its turn ended without as cancelled, never as running", () => {
		const interrupted = [
			mcpUse("tu_1", "delete_repo"),
			customUse("tu_2", "refund_order"),
			waitingOn("tu_1", "tu_2"),
			event<"session.status_idle">({
				type: "session.status_idle",
				turn: 1,
				stop_reason: { type: "interrupted" },
				cancelled_event_ids: ["tu_1", "tu_2"],
			}),
		]
		const calls = toolCallsOf(interrupted)
		expect(calls.calls.get("tu_1")?.status).toBe("cancelled")
		expect(calls.calls.get("tu_2")?.status).toBe("cancelled")
		const html = render(interrupted, noSend)
		expect(count(html, "Cancelled")).toBe(2)
		expect(html).not.toContain("Running")
		expect(html).not.toContain(">Allow<")

		const archived = toolCallsOf([
			use("tu_3", "read"),
			event<"session.status_terminated">({ type: "session.status_terminated" }),
			use("tu_4", "read"),
		])
		expect(archived.calls.get("tu_3")?.status).toBe("cancelled")
		expect(archived.calls.get("tu_4")?.status).toBe("running")

		const late = toolCallsOf([
			use("tu_5", "read"),
			event<"session.status_idle">({
				type: "session.status_idle",
				turn: 1,
				stop_reason: { type: "interrupted" },
			}),
			result("tu_5", "file text"),
		])
		expect(late.calls.get("tu_5")?.status).toBe("done")
	})

	it("tracks which calls still wait as answers arrive", () => {
		const first = [mcpUse("tu_1", "a"), customUse("tu_2", "b"), waitingOn("tu_1", "tu_2")]
		expect([...sessionCallsOf(first).waiting]).toEqual(["tu_1", "tu_2"])
		const partly = [
			...first,
			event<"user.tool_confirmation">({
				type: "user.tool_confirmation",
				tool_use_id: "tu_1",
				result: "allow",
			}),
		]
		expect([...sessionCallsOf(partly).waiting]).toEqual(["tu_2"])
		expect(sessionCallsOf([...partly, running()]).waiting.size).toBe(0)
	})

	it("loads older pages until every call waiting on you has its use, so its answer row renders", async () => {
		const ids = Array.from({ length: 64 }, (_, index) => `tu_p${index}`)
		const uses = ids.map((id) => customUse(id, "lookup"))
		const pause = waitingOn(...ids)
		const answers = ids.slice(1).map((id) =>
			event<"user.custom_tool_result">({
				type: "user.custom_tool_result",
				custom_tool_use_id: id,
				content: [{ type: "text", text: "ok" }],
			}),
		)
		const history = [...uses, pause, ...answers]
		const pageSize = 100
		const newest = history.slice(-pageSize)
		expect(sessionCallsOf(newest).unseen).toEqual(["tu_p0"])
		expect(render(newest, noSend)).not.toContain("Send result")
		let loaded = newest
		let pages = 0
		await loadUntilWaitingCallsSeen(async () => {
			pages += 1
			loaded = history.slice(-pageSize * (pages + 1))
			return { events: loaded, more: loaded.length < history.length }
		})
		expect(pages).toBe(1)
		expect(sessionCallsOf(loaded).unseen).toEqual([])
		expect([...sessionCallsOf(loaded).waiting]).toEqual(["tu_p0"])
		expect(render(loaded, noSend).split("Send result")).toHaveLength(2)
	})

	it("stops loading at the start of the history and reports a failed page", async () => {
		const pause = waitingOn("tu_gone")
		await expect(
			loadUntilWaitingCallsSeen(async () => ({ events: [pause], more: false })),
		).resolves.toBeNull()
		const failure = new Error("offline")
		await expect(
			loadUntilWaitingCallsSeen(async () => ({ events: [pause], more: true, failure })),
		).rejects.toBe(failure)
	})

	it("builds the events the answer controls send", () => {
		expect(allowEvent("tu_1")).toEqual({
			type: "user.tool_confirmation",
			tool_use_id: "tu_1",
			result: "allow",
		})
		expect(denyEvent("tu_1", "  too risky ")).toEqual({
			type: "user.tool_confirmation",
			tool_use_id: "tu_1",
			result: "deny",
			deny_message: "too risky",
		})
		expect(denyEvent("tu_1", " ")).not.toHaveProperty("deny_message")
		expect(customResultEvent("tu_2", "ok", true)).toEqual({
			type: "user.custom_tool_result",
			custom_tool_use_id: "tu_2",
			content: [{ type: "text", text: "ok" }],
			is_error: true,
		})
	})

	it("explains a 409 as a call that stopped waiting, and passes other errors through", () => {
		expect(answerFailure(new ApiError(409, null, "conflict")).message).toBe(NOT_WAITING)
		const other = new ApiError(500, null, "boom")
		expect(answerFailure(other)).toBe(other)
	})

	it("tells a message refused while calls wait from any other conflict, by the API's code", () => {
		const waiting = new ApiError(409, null, "The session's turn waits on tool calls.", {
			code: "session_awaiting_action",
		})
		expect(sendFailure(waiting)).toEqual(new Error(WAITING_REFUSES_MESSAGES))
		const archived = new ApiError(409, null, "Session sesn_1 is terminated.")
		expect(sendFailure(archived)).toBe(archived)
	})
})
