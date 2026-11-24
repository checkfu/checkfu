import { clampToolCalls } from "@checkfu/domain/Session/RecordToolCalls"
import { MAX_CUSTOM_TOOL_INPUT_JSON_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import type { ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { CodemodeSandbox } from "@earendil-works/pi-codemode"
import type { Extension } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { makeApiHandler } from "../src/Http/Router.ts"
import { PiApprovalStore, makeToolGate } from "../src/Pi/PiApprovals.ts"
import { loadToolSurface, withScriptDeadline } from "../src/Pi/PiCodemode.ts"
import { PiCustomToolStore, SCRIPT_NOTE, customToolsExtension } from "../src/Pi/PiCustomTools.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { memorySql } from "./helpers/SqliteExecutor.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
	waitForSession,
} from "./helpers/ApiHarness.ts"

const withToolSurface = await loadToolSurface()

type Fetch = Parameters<typeof sendRequest>[0]
type Event = Schema.JsonObject

const LOOKUP = {
	type: "custom",
	name: "lookup_order",
	description: "Look an order up in the shop's own system.",
	input_schema: {
		type: "object",
		properties: { order: { type: "string" }, quantity: { type: "integer" } },
		required: ["order"],
	},
} as const

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

const json = (res: Response) => Effect.promise(() => res.json() as Promise<Event>)

const post = (apiFetch: Fetch, path: string, body: Schema.JsonObject) =>
	Effect.gen(function* () {
		const res = yield* sendRequest(apiFetch, { method: "POST", path, headers: AUTH_HEADERS, body })
		return { status: res.status, body: yield* json(res) }
	})

const get = (apiFetch: Fetch, path: string) =>
	Effect.gen(function* () {
		const res = yield* sendRequest(apiFetch, { method: "GET", path, headers: AUTH_HEADERS })
		return { status: res.status, body: yield* json(res) }
	})

/**
 * An agent with one custom tool (`lookup_order`), beside a desk whose `post`
 * asks a person first, so both kinds of wait can meet in one turn.
 */
const world = (
	handler: (model: Model<Api>, context: TranscriptContext) => AssistantMessage,
	confirmationsSeen?: Parameters<typeof makePiDurableTestLayer>[6],
) => {
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
		confirmationsSeen,
	)
	const run = async <A>(
		body: (api: ReturnType<typeof client>, sessionId: string) => Effect.Effect<A>,
	): Promise<A> => {
		try {
			return await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const agent = yield* post(apiFetch, "/v1/agents", {
						name: "Shop",
						model: "gpt-4o-mini",
						tools: [LOOKUP],
					})
					const env = yield* post(apiFetch, "/v1/environments", { name: "Env" })
					const session = yield* post(apiFetch, "/v1/sessions", {
						agent: agent.body["id"] as string,
						environment_id: env.body["id"] as string,
					})
					const sessionId = session.body["id"] as string
					return yield* body(client(apiFetch, sessionId), sessionId)
				}).pipe(Effect.scoped, Effect.provide(base.layer)),
			)
		} finally {
			await base.closeAll()
			await Promise.all(sandboxes.map((sandbox) => sandbox.close()))
		}
	}
	return { run, posted, restartPi: base.restartPi, conversations: base.conversations }
}

const client = (apiFetch: Fetch, sessionId: string) => {
	const send = (events: ReadonlyArray<Schema.JsonObject>) =>
		post(apiFetch, `/v1/sessions/${sessionId}/events`, { events })
	const events = Effect.map(
		get(apiFetch, `/v1/sessions/${sessionId}/events?limit=100`),
		(page) => page.body["data"] as ReadonlyArray<Event>,
	)
	const idles = Effect.map(events, (all) =>
		all.filter((event) => event["type"] === "session.status_idle"),
	)
	return {
		send,
		say: (text: string) => send([{ type: "user.message", content: [{ type: "text", text }] }]),
		result: (custom_tool_use_id: string, text: string, is_error?: boolean) =>
			send([
				{
					type: "user.custom_tool_result",
					custom_tool_use_id,
					content: [{ type: "text", text }],
					...(is_error === undefined ? {} : { is_error }),
				},
			]),
		confirm: (tool_use_id: string, result: "allow" | "deny") =>
			send([{ type: "user.tool_confirmation", tool_use_id, result }]),
		interrupt: send([{ type: "user.interrupt" }]),
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
const ofType = (events: ReadonlyArray<Event>, type: string) =>
	events.filter((event) => event["type"] === type)

const lookupThenReply = (model: Model<Api>, context: TranscriptContext) =>
	toolResults(context).length === 0
		? calls(model, ["call-1", "lookup_order", { order: "A-1" }])
		: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4)

describe("custom tools", () => {
	it("pauses on a custom tool call and carries on from the application's result", async () => {
		const { run } = world(lookupThenReply)
		await run((api) =>
			Effect.gen(function* () {
				expect((yield* api.say("where is A-1?")).status).toBe(200)
				expect(yield* api.idle(1)).toEqual({ type: "requires_action", event_ids: ["call-1"] })
				expect(types(yield* api.events)).toEqual([
					"user.message",
					"session.status_running",
					"span.model_request_start",
					"agent.custom_tool_use",
					"span.model_request_end",
					"session.status_idle",
				])
				expect(ofType(yield* api.events, "agent.custom_tool_use")[0]).toMatchObject({
					tool_use_id: "call-1",
					name: "lookup_order",
					input: { order: "A-1" },
				})

				const answered = yield* api.result("call-1", "shipped")
				expect(answered).toEqual({
					status: 200,
					body: { data: [{ type: "user.custom_tool_result", custom_tool_use_id: "call-1" }] },
				})
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })

				const events = yield* api.events
				// The application's event is the record of the result: the agent side adds none.
				expect(types(events).slice(6)).toEqual([
					"user.custom_tool_result",
					"session.status_running",
					"span.model_request_start",
					"agent.message",
					"span.model_request_end",
					"session.status_idle",
				])
				expect(ofType(events, "agent.custom_tool_use")).toHaveLength(1)
				expect(ofType(events, "user.custom_tool_result")[0]).toMatchObject({
					custom_tool_use_id: "call-1",
					content: [{ type: "text", text: "shipped" }],
				})
				expect(events.at(-3)).toMatchObject({ content: [{ type: "text", text: "Done: shipped" }] })

				expect((yield* api.result("call-1", "lost")).status).toBe(409)
			}),
		)
	})

	it("tells the model when the application says the tool failed", async () => {
		const { run } = world((model, context) => {
			const results = toolResults(context)
			return results.length === 0
				? calls(model, ["call-1", "lookup_order", { order: "A-1" }])
				: makeAssistantReply(
						model,
						null,
						`${results[0]?.isError === true ? "Failed" : "Done"}: ${resultText(context)}`,
						5,
						4,
					)
		})
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("where is A-1?")
				yield* api.idle(1)
				expect((yield* api.result("call-1", "no such order", true)).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })
				const events = yield* api.events
				expect(ofType(events, "user.custom_tool_result")[0]).toMatchObject({ is_error: true })
				expect(events.at(-3)).toMatchObject({
					content: [{ type: "text", text: "Failed: no such order" }],
				})
			}),
		)
	})

	const both = (model: Model<Api>, context: TranscriptContext) =>
		toolResults(context).length === 0
			? calls(
					model,
					["call-tool", "lookup_order", { order: "A-1" }],
					["call-ask", "post", { text: "hello" }],
				)
			: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4)

	it("waits on a custom tool and an approval together, the result answered first", async () => {
		const { run, posted } = world(both)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				const paused = yield* api.idle(1)
				expect(paused?.type).toBe("requires_action")
				expect(paused?.event_ids?.toSorted()).toEqual(["call-ask", "call-tool"])
				expect((yield* api.result("call-tool", "shipped")).status).toBe(200)
				// The session resumed on the first answer and paused again on what is left.
				expect(yield* api.idle(2)).toEqual({ type: "requires_action", event_ids: ["call-ask"] })
				expect(posted).toEqual([])
				expect((yield* api.confirm("call-ask", "allow")).status).toBe(200)
				expect(yield* api.idle(3)).toEqual({ type: "end_turn" })
				expect(posted).toEqual(["hello"])
				const events = yield* api.events
				expect(events.at(-3)).toMatchObject({
					content: [{ type: "text", text: "Done: shipped | posted:hello" }],
				})
				expect(ofType(events, "agent.custom_tool_use")).toHaveLength(1)
			}),
		)
	})

	it("waits on a custom tool and an approval together, the approval answered first", async () => {
		const { run, posted } = world(both)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				yield* api.idle(1)
				expect((yield* api.confirm("call-ask", "allow")).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "requires_action", event_ids: ["call-tool"] })
				expect(posted).toEqual(["hello"])
				expect((yield* api.result("call-tool", "shipped")).status).toBe(200)
				expect(yield* api.idle(3)).toEqual({ type: "end_turn" })
				expect((yield* api.events).at(-3)).toMatchObject({
					content: [{ type: "text", text: "Done: shipped | posted:hello" }],
				})
			}),
		)
	})

	it("answers each waiting call only with what it waits for, and no call it does not know", async () => {
		const { run, posted } = world(both)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				yield* api.idle(1)
				expect((yield* api.confirm("call-tool", "allow")).status).toBe(409)
				expect((yield* api.result("call-ask", "done")).status).toBe(409)
				const unknown = yield* api.result("call-other", "done")
				expect(unknown.status).toBe(409)
				expect(JSON.stringify(unknown.body)).toContain("waiting")
				expect(posted).toEqual([])
				expect(types(yield* api.events).at(-1)).toBe("session.status_idle")
			}),
		)
	})

	it("stays paused across a restart, then takes the result, having asked once", async () => {
		const { run, restartPi, conversations } = world(lookupThenReply)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("where is A-1?")
				expect(yield* api.idle(1)).toEqual({ type: "requires_action", event_ids: ["call-1"] })
				yield* Effect.promise(() => restartPi(conversations[0] ?? ""))

				expect((yield* api.result("call-1", "shipped")).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })
				const events = yield* api.events
				expect(ofType(events, "agent.custom_tool_use")).toHaveLength(1)
				expect(events.at(-3)).toMatchObject({ content: [{ type: "text", text: "Done: shipped" }] })
			}),
		)
	})

	it("gives up a waiting custom tool call on an interrupt, and takes a new message afterwards", async () => {
		const { run } = world((model, context) => {
			const last = context.messages.findLast((message) => message.role === "user")
			const text = typeof last?.content === "string" ? last.content : ""
			return text === "go" && toolResults(context).length === 0
				? calls(model, ["call-1", "lookup_order", { order: "A-1" }])
				: makeAssistantReply(model, null, `Heard: ${text}`, 5, 4)
		})
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("go")
				yield* api.idle(1)
				expect((yield* api.interrupt).status).toBe(200)
				expect(
					(yield* api
						.result("call-1", "shipped")
						.pipe(Effect.repeat({ until: (answer) => answer.status === 409, times: 200 }))).status,
				).toBe(409)
				expect((yield* api.say("never mind")).status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })
				const events = yield* api.events
				expect(events.at(-3)).toMatchObject({
					content: [{ type: "text", text: "Heard: never mind" }],
				})
				expect(ofType(events, "user.custom_tool_result")).toEqual([])
			}),
		)
	})

	it("sends the application a long request whole, past the session log's own bounds", async () => {
		const order = "o".repeat(20_000)
		const { run } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "lookup_order", { order }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("where is it?")
				expect(yield* api.idle(1)).toEqual({ type: "requires_action", event_ids: ["call-1"] })
				const [request] = ofType(yield* api.events, "agent.custom_tool_use")
				expect(request?.["input"]).toEqual({ order })
				expect(request?.["truncated"]).toBeUndefined()
			}),
		)
	})

	it("refuses a request too large to send before pausing, and tells the model", async () => {
		const order = "o".repeat(MAX_CUSTOM_TOOL_INPUT_JSON_LENGTH)
		const { run } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "lookup_order", { order }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("where is it?")
				const reason = yield* api.idle(1)
				expect(reason).toEqual({ type: "end_turn" })
				const events = yield* api.events
				expect(ofType(events, "agent.custom_tool_use")).toEqual([])
				expect(ofType(events, "agent.tool_use")).toMatchObject([
					{ tool_use_id: "call-1", name: "lookup_order" },
				])
				const [failed] = ofType(events, "agent.tool_result")
				expect(failed).toMatchObject({ tool_use_id: "call-1", is_error: true })
				expect(JSON.stringify(failed)).toContain(`at most ${MAX_CUSTOM_TOOL_INPUT_JSON_LENGTH}`)
			}),
		)
	})

	it("sends the arguments Pi checked and coerced, not the model's raw ones", async () => {
		const { run } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "lookup_order", { order: "A-1", quantity: "42" }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("where is it?")
				yield* api.idle(1)
				const [request] = ofType(yield* api.events, "agent.custom_tool_use")
				expect(request?.["input"]).toEqual({ order: "A-1", quantity: 42 })
			}),
		)
	})

	it("shows a call Pi refused before it ran as a failed call, not one waiting for the application", async () => {
		const { run } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, ["call-1", "lookup_order", { quantity: 1 }])
				: makeAssistantReply(model, null, `Done: ${resultText(context)}`, 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("where is it?")
				expect(yield* api.idle(1)).toEqual({ type: "end_turn" })
				const events = yield* api.events
				expect(ofType(events, "agent.custom_tool_use")).toEqual([])
				expect(ofType(events, "agent.tool_use")).toMatchObject([{ tool_use_id: "call-1" }])
				expect(ofType(events, "agent.tool_result")).toMatchObject([
					{ tool_use_id: "call-1", is_error: true },
				])
			}),
		)
	})

	it("gives the model a result that lands while a queued message ends the wait", async () => {
		let cue: Effect.Effect<void> | undefined
		const { run } = world(lookupThenReply, (client) => ({
			...client,
			get: (...args: Parameters<typeof client.get>) =>
				Effect.gen(function* () {
					const before = yield* client.get(...args)
					// The first look finds nothing yet; the result and a new message land right after it.
					const act = cue
					cue = undefined
					if (act !== undefined) {
						yield* act
					}
					return before
				}),
		}))
		await run((api) =>
			Effect.gen(function* () {
				cue = Effect.asVoid(
					Effect.all([api.say("and is it insured?"), api.result("call-1", "shipped")]),
				)
				yield* api.say("where is A-1?")
				yield* api.idle(2)
				const events = yield* api.events
				expect(ofType(events, "user.custom_tool_result")).toHaveLength(1)
				const replies = ofType(events, "agent.message").map((event) => JSON.stringify(event))
				expect(replies[0]).toContain("Done: shipped")
			}),
		)
	})

	it("offers a custom tool to the model only, and says so", () => {
		const [tool] = customToolsExtension([LOOKUP], () => undefined).tools ?? []
		expect(tool?.callers).toEqual(["model"])
		expect(tool?.description).toContain(LOOKUP.description)
		expect(tool?.description).toContain(SCRIPT_NOTE)
	})

	it("waits once and is named once when its call runs again before the park was stored", async () => {
		const sql = memorySql()
		const approvals = new PiApprovalStore(sql)
		const customTools = new PiCustomToolStore(sql)
		customTools.bind([LOOKUP])
		approvals.begin("turn:1")
		const notOpen = () => Promise.resolve("not_found" as const)
		const gate = makeToolGate({
			store: approvals,
			permission: () => undefined,
			ledger: { began: () => undefined, ended: () => undefined },
			signal: notOpen,
			signalResult: notOpen,
		})
		const [tool] = customTools.extension(gate.park).tools ?? []
		const api = { callId: "call-1", taskId: 7, readSignal: () => Promise.resolve(undefined) }
		const run = () => tool?.execute({ order: "A-1" }, api as never, {} as never)

		const parked = await run()
		expect(parked).toMatchObject({ sleep: { signals: [expect.anything()] } })
		expect(await run()).toEqual(parked)
		expect(gate.waiting()).toEqual(["call-1"])
		expect(gate.waitingResults()).toEqual(["call-1"])

		const served = customTools.served()
		const named = clampToolCalls(
			[
				{ type: "tool_use", tool_use_id: "call-1", name: "lookup_order", input: { order: "A-1" } },
				{
					type: "tool_result",
					tool_use_id: "call-1",
					content: [{ type: "text", text: "shipped" }],
					is_error: false,
				},
				{ type: "tool_use", tool_use_id: "call-2", name: "read", input: {} },
			].flatMap((event) => {
				const kept = served.named(event as ToolEvent)
				return kept === undefined ? [] : [kept]
			}),
		)
		expect(named.map((call) => [call._tag, call.use.type, call.use.tool_use_id])).toEqual([
			["use", "custom_tool_use", "call-1"],
			["use", "tool_use", "call-2"],
		])
		// The turn that paused publishes the call; the turn that carries it on does not again.
		expect(approvals.unpublished("turn:1", named)).toEqual(named)
		expect(approvals.unpublished("turn:1", named)).toEqual(named)
		expect(approvals.unpublished("turn:2", named)).toEqual([])
	})

	it("does not let a script call a custom tool", async () => {
		const { run } = world((model, context) =>
			toolResults(context).length === 0
				? calls(model, [
						"script-1",
						"codemode",
						{ code: 'return await tools.lookup_order({ order: "A-1" })' },
					])
				: makeAssistantReply(model, null, "The script could not look it up.", 5, 4),
		)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("where is A-1?")
				expect(yield* api.idle(1)).toEqual({ type: "end_turn" })
				const events = yield* api.events
				expect(ofType(events, "agent.custom_tool_use")).toEqual([])
				const [failed] = ofType(events, "agent.tool_result")
				expect(failed).toMatchObject({ tool_use_id: "script-1", is_error: true })
				// The script was told there is no such tool; it did not start a call and wait on it.
				expect(JSON.stringify(failed?.["content"])).toContain("tools.lookup_order does not exist")
			}),
		)
	})

	it("refuses a result that is too long, and a field it does not know", async () => {
		const { run } = world(lookupThenReply)
		await run((api) =>
			Effect.gen(function* () {
				yield* api.say("where is A-1?")
				yield* api.idle(1)
				const long = yield* api.result("call-1", "x".repeat(16_385))
				expect(long.status).toBe(400)
				expect(JSON.stringify(long.body)).toContain("16384")
				const unknown = yield* api.send([
					{
						type: "user.custom_tool_result",
						custom_tool_use_id: "call-1",
						content: [{ type: "text", text: "shipped" }],
						extra: true,
					},
				])
				expect(unknown.status).toBe(400)
				// Text blocks are joined and recorded as one, as a user message's are.
				const blocks = yield* api.send([
					{
						type: "user.custom_tool_result",
						custom_tool_use_id: "call-1",
						content: [
							{ type: "text", text: "shipped" },
							{ type: "text", text: "today" },
						],
					},
				])
				expect(blocks.status).toBe(200)
				expect(yield* api.idle(2)).toEqual({ type: "end_turn" })
				const events = yield* api.events
				expect(ofType(events, "user.custom_tool_result")[0]).toMatchObject({
					content: [{ type: "text", text: "shipped\ntoday" }],
				})
				expect(events.at(-3)).toMatchObject({
					content: [{ type: "text", text: "Done: shipped\ntoday" }],
				})
			}),
		)
	})
})

describe("an agent's custom tools", () => {
	const withApi = async <A>(body: (apiFetch: Fetch) => Effect.Effect<A>) => {
		const base = makePiDurableTestLayer((model) =>
			Promise.resolve(makeAssistantReply(model, null, "ok", 1, 1)),
		)
		try {
			return await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					return yield* body(apiFetch)
				}).pipe(Effect.scoped, Effect.provide(base.layer)),
			)
		} finally {
			await base.closeAll()
		}
	}
	const agent = (tools: ReadonlyArray<Schema.JsonObject>) => ({
		name: "Shop",
		model: "gpt-4o-mini",
		tools,
	})

	it("keeps them with each version, beside its MCP tool configuration", async () => {
		await withApi((apiFetch) =>
			Effect.gen(function* () {
				const toolset = {
					type: "mcp_toolset",
					mcp_server_name: "tracker",
					default_config: { permission_policy: { type: "always_ask" } },
				}
				const created = yield* post(apiFetch, "/v1/agents", {
					...agent([toolset, LOOKUP]),
					mcp_servers: [{ type: "url", name: "tracker", url: "https://mcp.example.com/mcp" }],
				})
				expect(created.status).toBe(201)
				expect(created.body["tools"]).toEqual([toolset, LOOKUP])
				const id = created.body["id"] as string

				// A change of something else keeps the tools.
				const renamed = yield* post(apiFetch, `/v1/agents/${id}`, { version: 1, name: "Store" })
				expect(renamed.body).toMatchObject({ version: 2, tools: [toolset, LOOKUP] })

				// Replacing tools replaces the custom tools too, and mints a version on its own.
				const refund = { ...LOOKUP, name: "refund_order" }
				const replaced = yield* post(apiFetch, `/v1/agents/${id}`, { version: 2, tools: [refund] })
				expect(replaced.body).toMatchObject({ version: 3, tools: [refund] })
				expect((yield* get(apiFetch, `/v1/agents/${id}`)).body["tools"]).toEqual([refund])

				// The same tools again change nothing.
				const same = yield* post(apiFetch, `/v1/agents/${id}`, { version: 3, tools: [refund] })
				expect(same.body).toMatchObject({ version: 3 })

				const cleared = yield* post(apiFetch, `/v1/agents/${id}`, { version: 3, tools: [] })
				expect(cleared.body).toMatchObject({ version: 4, tools: [] })
			}),
		)
	})

	it("refuses names it cannot offer and schemas that are not an object's", async () => {
		await withApi((apiFetch) =>
			Effect.gen(function* () {
				const refusal = (tools: ReadonlyArray<Schema.JsonObject>) =>
					Effect.map(post(apiFetch, "/v1/agents", agent(tools)), (res) => ({
						status: res.status,
						text: JSON.stringify(res.body),
					}))
				expect(yield* refusal([LOOKUP, LOOKUP])).toMatchObject({ status: 400 })
				expect((yield* refusal([LOOKUP, LOOKUP])).text).toContain("more than once")
				for (const name of ["mcp__tracker__search", "read", "codemode", "tool_search"]) {
					const reserved = yield* refusal([{ ...LOOKUP, name }])
					expect(reserved.status).toBe(400)
					expect(reserved.text).toContain("reserved")
				}
				expect((yield* refusal([{ ...LOOKUP, name: "has space" }])).status).toBe(400)
				expect((yield* refusal([{ ...LOOKUP, name: "n".repeat(65) }])).status).toBe(400)
				expect((yield* refusal([{ ...LOOKUP, description: "" }])).status).toBe(400)
				const notObject = yield* refusal([{ ...LOOKUP, input_schema: { type: "string" } }])
				expect(notObject.status).toBe(400)
				expect(notObject.text).toContain(String.raw`type \"object\"`)
				for (const property of [{ $ref: "#/$defs/missing" }, { type: "string", pattern: "(" }]) {
					const invalid = yield* refusal([
						{ ...LOOKUP, input_schema: { type: "object", properties: { order: property } } },
					])
					expect(invalid.status).toBe(400)
					expect(invalid.text).toContain("not a valid JSON Schema")
				}
				const huge = yield* refusal([
					{
						...LOOKUP,
						input_schema: { type: "object", description: "d".repeat(16_384) },
					},
				])
				expect(huge.status).toBe(400)
				expect((yield* refusal([{ ...LOOKUP, extra: true }])).status).toBe(400)
				expect(
					(yield* refusal(
						Array.from({ length: 65 }, (_, index) => ({ ...LOOKUP, name: `tool_${index}` })),
					)).status,
				).toBe(400)
			}),
		)
	})

	it("refuses a schema reference it cannot resolve, naming it, instead of dropping it", async () => {
		await withApi((apiFetch) =>
			Effect.gen(function* () {
				const external = "https://schemas.example.com/order.json"
				const refused = yield* post(
					apiFetch,
					"/v1/agents",
					agent([
						{
							...LOOKUP,
							input_schema: {
								type: "object",
								properties: { order: { $ref: external, minLength: 3 } },
								required: ["order"],
							},
						},
					]),
				)
				expect(refused.status).toBe(400)
				expect(JSON.stringify(refused.body)).toContain(external)
			}),
		)
	})
})
