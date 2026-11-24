import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { CodemodeSandbox } from "@earendil-works/pi-codemode"
import type { Extension } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { makeApiHandler } from "../src/Http/Router.ts"
import { DENIED_MESSAGE } from "../src/Pi/PiApprovals.ts"
import { loadToolSurface, withScriptDeadline } from "../src/Pi/PiCodemode.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import {
	AUTH_HEADERS,
	createIdleSession,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
	waitForSession,
} from "./helpers/ApiHarness.ts"

const withToolSurface = await loadToolSurface()

type Fetch = Parameters<typeof sendRequest>[0]
type Event = Schema.JsonObject

const calls = (
	model: Model<Api>,
	...made: ReadonlyArray<readonly [id: string, name: string, args: Schema.JsonObject]>
): AssistantMessage => ({
	...makeAssistantReply(model, null, "", 3, 2),
	content: made.map(([id, name, args]) => ({
		type: "toolCall" as const,
		id,
		name,
		arguments: args,
	})),
	stopReason: "toolUse",
})

const toolResults = (context: TranscriptContext) =>
	context.messages.filter((message) => message.role === "toolResult")

const resultText = (context: TranscriptContext) =>
	toolResults(context)
		.flatMap((message) => message.content)
		.map((block) => (block.type === "text" ? block.text : ""))
		.join(" | ")

/** A desk with one tool that asks first (`post`) and one that does not (`peek`). */
const world = (handler: (model: Model<Api>, context: TranscriptContext) => AssistantMessage) => {
	const posted: Array<string> = []
	const sandboxes: Array<CodemodeSandbox> = []
	const desk: Extension = {
		name: "desk",
		tools: [
			{
				name: "post",
				description: "Post a message.",
				parameters: { type: "object", properties: { text: { type: "string" } } },
				execute: (args: { readonly text?: string }) => {
					posted.push(args.text ?? "")
					return Promise.resolve({ output: [{ type: "text", text: `posted:${args.text ?? ""}` }] })
				},
			},
			{
				name: "peek",
				description: "Read the board.",
				parameters: { type: "object", properties: {} },
				execute: () => Promise.resolve({ output: [{ type: "text", text: "board" }] }),
			},
		],
	}
	const base = makePiDurableTestLayer(
		(model, context) => Promise.resolve(handler(model, context)),
		undefined,
		undefined,
		() => {
			const sandbox = withScriptDeadline(new CodemodeSandbox(), { defaultMs: 2000, maxMs: 2000 })
			sandboxes.push(sandbox)
			const registry = createCheckfuRegistry()
			for (const extension of withToolSurface(sandbox, [desk])) {
				registry.install(extension)
			}
			return registry
		},
		undefined,
		(tool) => (tool === "post" ? { server: "desk", tool: "post", ask: true } : undefined),
	)
	const run = async <A>(
		body: (api: ReturnType<typeof client>, sessionId: string) => Effect.Effect<A>,
	): Promise<A> => {
		try {
			return await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					const api = client(apiFetch, session.id)
					return yield* body(api, session.id)
				}).pipe(Effect.scoped, Effect.provide(base.layer)),
			)
		} finally {
			await base.closeAll()
			await Promise.all(sandboxes.map((sandbox) => sandbox.close()))
		}
	}
	return {
		run,
		posted,
		restartPi: base.restartPi,
		forgetPiState: base.forgetPiState,
		conversations: base.conversations,
	}
}

const client = (apiFetch: Fetch, sessionId: string) => {
	const send = (events: ReadonlyArray<Schema.JsonObject>) =>
		Effect.gen(function* () {
			const res = yield* sendRequest(apiFetch, {
				method: "POST",
				path: `/v1/sessions/${sessionId}/events`,
				headers: AUTH_HEADERS,
				body: { events },
			})
			return { status: res.status, body: (yield* Effect.promise(() => res.json())) as Event }
		})
	const events = Effect.gen(function* () {
		const res = yield* sendRequest(apiFetch, {
			method: "GET",
			path: `/v1/sessions/${sessionId}/events?limit=100`,
			headers: AUTH_HEADERS,
		})
		const body = (yield* Effect.promise(() => res.json())) as {
			readonly data: ReadonlyArray<Event>
		}
		return body.data
	})
	const idles = Effect.map(events, (all) =>
		all.filter((event) => event["type"] === "session.status_idle"),
	)
	return {
		send,
		say: (text: string) => send([{ type: "user.message", content: [{ type: "text", text }] }]),
		confirm: (tool_use_id: string, result: "allow" | "deny", deny_message?: string) =>
			send([
				{
					type: "user.tool_confirmation",
					tool_use_id,
					result,
					...(deny_message === undefined ? {} : { deny_message }),
				},
			]),
		interrupt: send([{ type: "user.interrupt" }]),
		archive: Effect.gen(function* () {
			const res = yield* sendRequest(apiFetch, {
				method: "POST",
				path: `/v1/sessions/${sessionId}/archive`,
				headers: AUTH_HEADERS,
			})
			return { status: res.status }
		}),
		events,
		/** Waits until the session has gone idle `count` times, and returns the last time's reason. */
		idle: (count: number) =>
			Effect.gen(function* () {
				yield* waitForSession(apiFetch, sessionId, (session) => session.status === "idle")
				const seen = yield* idles.pipe(
					Effect.repeat({ until: (all) => all.length >= count, times: 400 }),
				)
				yield* waitForSession(apiFetch, sessionId, (session) => session.status === "idle")
				return seen[count - 1]?.["stop_reason"] as
					| { readonly type: string; readonly event_ids?: ReadonlyArray<string> }
					| undefined
			}),
	}
}

const types = (events: ReadonlyArray<Event>) => events.map((event) => event["type"])

describe("tool calls that ask a person first", () => {
	it("pauses the turn without running the tool, and runs it once when allowed", async () => {
		const { run, posted } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "post", { text: "hello" }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				expect((yield* api.say("go")).status).toBe(200)
				expect(yield* api.idle(1)).toEqual({ type: "requires_action", event_ids: ["call-1"] })
				expect(posted).toEqual([])
				expect(types(yield* api.events)).toEqual([
					"user.message",
					"session.status_running",
					"span.model_request_start",
					"agent.tool_use",
					"span.model_request_end",
					"session.status_idle",
				])

				const refused = yield* api.say("hurry up")
				expect(refused.status).toBe(409)
				expect(JSON.stringify(refused.body)).toContain("waiting for tool calls")

				expect((yield* api.confirm("call-1", "allow")).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })
				expect(posted).toEqual(["hello"])

				const events = yield* api.events
				expect(types(events).slice(6)).toEqual([
					"user.tool_confirmation",
					"session.status_running",
					"span.model_request_start",
					"agent.tool_result",
					"agent.message",
					"span.model_request_end",
					"session.status_idle",
				])
				expect(events.filter((event) => event["type"] === "agent.tool_use")).toHaveLength(1)
				expect(events.at(-3)).toMatchObject({
					content: [{ type: "text", text: "Done: posted:hello" }],
				})

				// The answered call takes no second answer.
				expect((yield* api.confirm("call-1", "deny")).status).toBe(409)
				expect(posted).toEqual(["hello"])
			}),
		)
	})

	it("tells the model why a call was denied and never runs it", async () => {
		const { run, posted } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "post", { text: "hello" }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				yield* api.idle(1)
				expect((yield* api.confirm("call-1", "deny", "Not on a Friday.")).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })
				expect(posted).toEqual([])

				const events = yield* api.events
				expect(events.find((event) => event["type"] === "user.tool_confirmation")).toMatchObject({
					tool_use_id: "call-1",
					result: "deny",
					deny_message: "Not on a Friday.",
				})
				expect(events.find((event) => event["type"] === "agent.tool_result")).toMatchObject({
					tool_use_id: "call-1",
					is_error: true,
				})
				expect(JSON.stringify(events.at(-3))).toContain("Not on a Friday.")
			}),
		)
	})

	it("uses a default wording for a denial without a reason", async () => {
		const { run } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "post", { text: "hello" }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				yield* api.idle(1)
				yield* api.confirm("call-1", "deny")
				yield* api.idle(2)
				expect(JSON.stringify((yield* api.events).at(-3))).toContain(DENIED_MESSAGE)
			}),
		)
	})

	it("runs a tool that does not ask without pausing", async () => {
		const { run } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "peek", {}])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				expect(yield* api.idle(1)).toEqual({ type: "end_turn" })
				expect((yield* api.events).at(-3)).toMatchObject({
					content: [{ type: "text", text: "Done: board" }],
				})
			}),
		)
	})

	it("sends a message that reads like the resume placeholder to the model like any other", async () => {
		const { run } = world((model, context) =>
			makeAssistantReply(model, null, `Heard: ${extractLastUserText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("[checkfu:resume]")
				expect(yield* api.idle(1)).toEqual({ type: "end_turn" })
				expect((yield* api.events).at(-3)).toMatchObject({
					content: [{ type: "text", text: "Heard: [checkfu:resume]" }],
				})
			}),
		)
	})

	it("stays paused across a restart and still runs the call once", async () => {
		const { run, posted, restartPi, conversations } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "post", { text: "hello" }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				expect(yield* api.idle(1)).toEqual({ type: "requires_action", event_ids: ["call-1"] })
				yield* Effect.promise(() => restartPi(conversations[0] ?? ""))
				expect(posted).toEqual([])

				expect((yield* api.confirm("call-1", "allow")).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })
				expect(posted).toEqual(["hello"])
				expect((yield* api.events).at(-3)).toMatchObject({
					content: [{ type: "text", text: "Done: posted:hello" }],
				})
			}),
		)
	})

	it("gives up a waiting call on an interrupt, and takes a new message afterwards", async () => {
		const { run, posted } = world((model, context) => {
			const last = context.messages.findLast((message) => message.role === "user")
			const text = typeof last?.content === "string" ? last.content : ""
			return text === "go" && toolResults(context).length === 0
				? calls(model, ["call-1", "post", { text: "hello" }])
				: makeAssistantReply(model, null, `Heard: ${text}`, 5, 4)
		})
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				yield* api.idle(1)
				expect((yield* api.interrupt).status).toBe(200)
				// The late answer finds nothing waiting.
				expect(
					(yield* api
						.confirm("call-1", "allow")
						.pipe(Effect.repeat({ until: (answer) => answer.status === 409, times: 200 }))).status,
				).toBe(409)
				expect(posted).toEqual([])

				expect((yield* api.say("something else")).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })
				expect(posted).toEqual([])
				const events = yield* api.events
				expect(types(events)).toContain("user.interrupt")
				expect(events.at(-3)).toMatchObject({
					content: [{ type: "text", text: "Heard: something else" }],
				})
			}),
		)
	})

	it("waits on two calls at once and takes their answers one at a time", async () => {
		const { run, posted } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-a", "post", { text: "a" }], ["call-b", "post", { text: "b" }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				expect(yield* api.idle(1)).toEqual({
					type: "requires_action",
					event_ids: ["call-a", "call-b"],
				})

				expect((yield* api.confirm("call-a", "allow")).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "requires_action", event_ids: ["call-b"] })
				expect(posted).toEqual(["a"])

				expect((yield* api.confirm("call-b", "deny", "One is enough.")).status).toBe(200)
				expect(yield* api.idle(3)).toEqual({ type: "end_turn" })
				expect(posted).toEqual(["a"])

				const events = yield* api.events
				expect(events.filter((event) => event["type"] === "agent.tool_use")).toHaveLength(2)
				expect(events.filter((event) => event["type"] === "agent.tool_result")).toHaveLength(2)
				const reply = JSON.stringify(events.at(-3))
				expect(reply).toContain("posted:a")
				expect(reply).toContain("One is enough.")
			}),
		)
	})

	it("refuses the call from a script at once, telling the model to make it directly", async () => {
		const code =
			'return await tools.post({ text: "sneak" }).catch((error) => "refused: " + error.message);'
		const { run, posted } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "codemode", { code }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				expect(yield* api.idle(1)).toEqual({ type: "end_turn" })
				expect(posted).toEqual([])
				const reply = JSON.stringify((yield* api.events).at(-3))
				expect(reply).toContain("refused: ")
				expect(reply).toContain("Call post directly")
			}),
		)
	})

	it("gives up a waiting call when its session is archived", async () => {
		const { run, posted } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "post", { text: "hello" }])
				: makeAssistantReply(model, null, "Done.", 5, 4),
		)
		await run((api, sessionId) =>
			Effect.gen(function* () {
				yield* api.say("go")
				yield* api.idle(1)
				expect((yield* api.archive).status).toBe(200)
				expect((yield* api.confirm("call-1", "allow")).status).toBe(409)
				expect(posted).toEqual([])
				expect(sessionId.length).toBeGreaterThan(0)
			}),
		)
	})

	it("refuses an answer for a call that is not waiting", async () => {
		const { run } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "post", { text: "hello" }])
				: makeAssistantReply(model, null, "Done.", 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				const early = yield* api.confirm("call-1", "allow")
				expect(early.status).toBe(409)
				yield* api.say("go")
				yield* api.idle(1)
				const unknown = yield* api.confirm("call-nope", "allow")
				expect(unknown.status).toBe(409)
				expect(JSON.stringify(unknown.body)).toContain("waiting")
				// A misspelled field is refused, not dropped.
				const misspelled = yield* api.send([
					{ type: "user.tool_confirmation", tool_use_id: "call-1", result: "deny", message: "No." },
				])
				expect(misspelled.status).toBe(400)
				// The session is still paused on the real call.
				expect((yield* api.confirm("call-1", "allow")).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })
			}),
		)
	})
})
