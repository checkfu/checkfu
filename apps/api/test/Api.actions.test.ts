import type {
	Api,
	AssistantMessage,
	Model,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai"
import { describe, expect, it } from "@effect/vitest"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import fc from "fast-check"
import * as Schedule from "effect/Schedule"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { Agent } from "@checkfu/domain/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/domain/Agent/AgentVersion.id"
import { CreateAgentDecision } from "@checkfu/domain/Agent/CreateAgent.decision"
import { UpdateAgent } from "@checkfu/domain/Agent/UpdateAgent.command"
import { UpdateAgentDecision } from "@checkfu/domain/Agent/UpdateAgent.decision"
import { encodeAgentTools, encodeMcpServers } from "@checkfu/domain/Mcp/McpServers"
import { AbandonTurn } from "@checkfu/domain/Session/AbandonTurn.command"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { idempotentCommandId } from "../src/Http/HttpHelpers.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { conversationName } from "../src/Pi/PiDurableHarness.ts"
import { MAX_PUBLIC_TOOL_NAME_LENGTH, assignToolNames } from "../src/Pi/PiToolNames.ts"
import { AUTH_HEADERS, makePiDurableTestLayer, sendRequest } from "./helpers/ApiHarness.ts"
import type { TestMcpTool } from "./helpers/ApiHarness.ts"

const DOCS = { type: "url", name: "docs", url: "https://docs.mcp.example/mcp" }

const usage = (input: number, output: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const answer = (
	model: Model<Api>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
	role: "assistant",
	content,
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: usage(3, 2),
	stopReason,
	timestamp: 0,
})

const call = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
})

const lastUserText = (context: TranscriptContext): string => {
	const user = context.messages.findLast((message) => message.role === "user")
	if (user === undefined) {
		return ""
	}
	return typeof user.content === "string"
		? user.content
		: user.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

const resultsSinceUser = (context: TranscriptContext): ReadonlyArray<string> => {
	const start = context.messages.findLastIndex((message) => message.role === "user")
	return context.messages
		.slice(start + 1)
		.flatMap((message) =>
			message.role === "toolResult"
				? [
						`${message.isError ? "error" : "ok"}:${message.content
							.map((part) => (part.type === "text" ? part.text : ""))
							.join("")}`,
					]
				: [],
		)
}

const BIG = "x".repeat(20_000)

const LONG_TOOL = `publish_${"very_".repeat(60)}long`
const LONG_TOOL_NAMES = assignToolNames([{ prefix: "mcp__docs__", name: LONG_TOOL }])[0]!

let held: Promise<void> = Promise.resolve()

const script = async (model: Model<Api>, context: TranscriptContext) => {
	const results = resultsSinceUser(context)
	const text = lastUserText(context)
	if (results.length > 0) {
		if (text === "hold") {
			await held
		}
		return answer(model, [{ type: "text", text: `saw ${results.join(" | ")}` }], "stop")
	}
	if (text.startsWith("plan:")) {
		const targets = JSON.parse(text.slice("plan:".length)) as ReadonlyArray<string>
		return answer(
			model,
			targets.map((target, index) => call(`p${index}`, "mcp__docs__deploy", { target })),
			"toolUse",
		)
	}
	switch (text) {
		case "deploy":
			return answer(model, [call("c1", "mcp__docs__deploy", { target: "prod" })], "toolUse")
		case "hold":
			return answer(model, [call("c1", "mcp__docs__deploy", { target: "held" })], "toolUse")
		case "two":
			return answer(
				model,
				[
					call("c1", "mcp__docs__deploy", { target: "a" }),
					call("c2", "mcp__docs__deploy", { target: "b" }),
				],
				"toolUse",
			)
		case "same":
			return answer(model, [call("same-id", "mcp__docs__deploy", { target: "x" })], "toolUse")
		case "search":
			return answer(model, [call("c1", "mcp__docs__search", { query: "q" })], "toolUse")
		case "long":
			return answer(model, [call("c1", LONG_TOOL_NAMES.model, {})], "toolUse")
		case "custom":
			return answer(model, [call("c1", "lookup_order", { order: "42" })], "toolUse")
		case "big":
			return answer(model, [call("c1", "lookup_order", { order: 1, note: BIG })], "toolUse")
		case "invalid":
			return answer(model, [call("c1", "lookup_order", { note: "no order" })], "toolUse")
		default:
			return answer(model, [{ type: "text", text: `echo ${text}` }], "stop")
	}
}

const ran: Array<string> = []
const MCP_TOOLS: ReadonlyArray<TestMcpTool> = [
	{
		server: "docs",
		name: "deploy",
		parameters: {
			type: "object",
			properties: { target: { type: "string" } },
			required: ["target"],
		},
		run: (args) => {
			const target = (args as { readonly target: string }).target
			ran.push(target)
			return `deployed ${target}`
		},
	},
	{ server: "docs", name: "search", readOnly: true, run: () => "found" },
	{
		server: "docs",
		name: LONG_TOOL,
		run: () => {
			ran.push("long")
			return "published"
		},
	},
]

const LOOKUP = {
	type: "custom",
	name: "lookup_order",
	description: "Looks an order up in the caller's system",
	input_schema: {
		type: "object",
		properties: { order: { type: "integer" }, note: { type: "string" } },
		required: ["order"],
	},
}

interface Ev {
	readonly type: string
	readonly rejected?: string
	readonly tool_use_id: string
	readonly name?: string
	readonly input?: unknown
	readonly truncated?: boolean
	readonly is_error?: boolean
	readonly evaluated_permission?: string
	readonly result?: string
	readonly deny_message?: string
	readonly turn?: number
	readonly cancelled_event_ids?: ReadonlyArray<string>
	readonly model_usage?: { readonly input_tokens: number; readonly output_tokens: number }
	readonly stop_reason: { readonly type: string; readonly event_ids: ReadonlyArray<string> }
	readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>
}

const find = (all: ReadonlyArray<Ev>, type: string): Ev => {
	const found = all.find((e) => e.type === type)
	if (found === undefined) {
		throw new Error(`no ${type} event`)
	}
	return found
}

type Call = (
	method: string,
	path: string,
	payload?: unknown,
	headers?: Record<string, string>,
) => Effect.Effect<{ readonly status: number; readonly body: any }>

type Hosted = Layer.Success<ReturnType<typeof makePiDurableTestLayer>["layer"]>

const world = async <A>(
	body: (
		call: Call,
		harness: ReturnType<typeof makePiDurableTestLayer>,
	) => Effect.Effect<A, never, Hosted | Scope.Scope>,
	build: (
		make: typeof makeApiHandler,
	) => Effect.Effect<Effect.Success<typeof makeApiHandler>, never, Hosted | Scope.Scope> = (make) =>
		make,
): Promise<A> => {
	ran.length = 0
	const harness = makePiDurableTestLayer(script, { mcpTools: MCP_TOOLS })
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* build(makeApiHandler)
				return yield* body(
					(method, path, payload, headers = {}) =>
						Effect.gen(function* () {
							const res = yield* sendRequest(apiFetch, {
								method,
								path,
								headers: { ...AUTH_HEADERS, ...headers },
								...(payload === undefined ? {} : { body: payload }),
							})
							const text = yield* Effect.promise(() => res.text())
							return { status: res.status, body: text.length === 0 ? null : JSON.parse(text) }
						}),
					harness,
				)
			}).pipe(Effect.scoped, Effect.provide(harness.layer)),
		)
	} finally {
		await harness.closeAll()
	}
}

const session = (call: Call, tools: ReadonlyArray<unknown> = [LOOKUP]) =>
	Effect.gen(function* () {
		const agent = yield* call("POST", "/v1/agents", {
			name: "Operator",
			model: "gpt-4o-mini",
			mcp_servers: [DOCS],
			tools,
		})
		expect(agent.status).toBe(201)
		const env = yield* call("POST", "/v1/environments", { name: "Env" })
		const created = yield* call("POST", "/v1/sessions", {
			agent: agent.body.id,
			environment_id: env.body.id,
		})
		expect(created.status).toBe(201)
		return created.body.id as string
	})

const send = (call: Call, id: string, events: ReadonlyArray<unknown>) =>
	call("POST", `/v1/sessions/${id}/events`, { events })

const message = (text: string) => ({ type: "user.message", content: [{ type: "text", text }] })

const events = (call: Call, id: string) =>
	Effect.map(
		call("GET", `/v1/sessions/${id}/events?limit=100`),
		(res) => (res.body as { readonly data: ReadonlyArray<Ev> }).data,
	)

const until = (call: Call, id: string, done: (all: ReadonlyArray<Ev>) => boolean, what: string) =>
	Effect.gen(function* () {
		const all = yield* events(call, id).pipe(
			Effect.repeat({ schedule: Schedule.spaced("10 millis"), times: 500, until: done }),
		)
		if (!done(all)) {
			return yield* Effect.die(new Error(`${what}: ${JSON.stringify(all.map((e) => e.type))}`))
		}
		return all
	})

const idles = (all: ReadonlyArray<Ev>) => all.filter((e) => e.type === "session.status_idle")
const waiting = (count: number) => (all: ReadonlyArray<Ev>) =>
	idles(all).filter((e) => e.stop_reason.type === "requires_action").length >= count
const ended = (all: ReadonlyArray<Ev>) =>
	idles(all).some((e) => e.stop_reason.type !== "requires_action")
const lastMessage = (all: ReadonlyArray<Ev>): string | undefined =>
	all.findLast((e) => e.type === "agent.message")?.content[0]?.text

const confirm = (tool_use_id: string, result: "allow" | "deny", deny_message?: string) => ({
	type: "user.tool_confirmation",
	tool_use_id,
	result,
	...(deny_message === undefined ? {} : { deny_message }),
})

const ANSWER_RUNS = Number(
	process.env["PI_PROPERTY_RUNS"] ?? (process.env["CI"] === undefined ? 20 : 5),
)

describe("What a round of approved and denied calls publishes", () => {
	it("runs exactly the allowed calls, marks the denied ones blocked, and publishes each once", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), async (allows) => {
				const targets = allows.map((_, index) => `t${index}`)
				await world((call) =>
					Effect.gen(function* () {
						const id = yield* session(call)
						yield* send(call, id, [message(`plan:${JSON.stringify(targets)}`)])
						const paused = yield* until(call, id, waiting(1), "no pause")
						const uses = paused.filter((e) => e.type === "agent.mcp_tool_use")
						expect(uses).toHaveLength(targets.length)
						for (const use of uses) {
							const index = targets.indexOf((use.input as { readonly target: string }).target)
							yield* send(call, id, [
								confirm(use.tool_use_id, allows[index] === true ? "allow" : "deny"),
							])
						}
						const all = yield* until(call, id, ended, "turn did not end")
						const published = all.filter((e) => e.type === "agent.mcp_tool_use")
						expect(new Set(published.map((e) => e.tool_use_id)).size).toBe(targets.length)
						expect(ran.toSorted()).toEqual(targets.filter((_, index) => allows[index] === true))
						for (const use of published) {
							const target = (use.input as { readonly target: string }).target
							const result = all.find(
								(e) => e.type === "agent.mcp_tool_result" && e.tool_use_id === use.tool_use_id,
							)
							if (allows[targets.indexOf(target)] === true) {
								expect(result?.rejected).toBeUndefined()
								expect(result?.is_error).toBe(false)
							} else {
								expect(result?.rejected).toBe("blocked")
								expect(ran).not.toContain(target)
							}
						}
					}),
				)
			}),
			{ numRuns: ANSWER_RUNS },
		)
	}, 600_000)
})

describe("tool calls that wait on an answer", () => {
	it("asks about a tool whose name is longer than a call's name may be, under a name that fits, and runs it once allowed", async () => {
		expect(LONG_TOOL.length).toBeGreaterThan(MAX_PUBLIC_TOOL_NAME_LENGTH)
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				expect((yield* send(call, id, [message("long")])).status).toBe(200)
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.mcp_tool_use")
				expect(use).toMatchObject({
					mcp_server_name: "docs",
					name: LONG_TOOL_NAMES.public,
					evaluated_permission: "ask",
				})
				expect(use.name?.length).toBeLessThanOrEqual(MAX_PUBLIC_TOOL_NAME_LENGTH)
				expect(idles(paused).at(-1)).toMatchObject({
					stop_reason: { type: "requires_action", event_ids: [use.tool_use_id] },
				})
				expect(ran).toEqual([])
				expect((yield* send(call, id, [confirm(use.tool_use_id, "allow")])).status).toBe(200)
				const all = yield* until(call, id, ended, "turn did not end")
				expect(ran).toEqual(["long"])
				expect(lastMessage(all)).toBe("saw ok:published")
			}),
		)
	})

	it("asks before a call that may change something, publishes it once with its arguments, and runs it once allowed", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				expect((yield* send(call, id, [message("deploy")])).status).toBe(200)
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.mcp_tool_use")
				expect(use).toMatchObject({
					mcp_server_name: "docs",
					name: "deploy",
					input: { target: "prod" },
					evaluated_permission: "ask",
				})
				expect(idles(paused).at(-1)).toMatchObject({
					stop_reason: { type: "requires_action", event_ids: [use.tool_use_id] },
					turn: 1,
				})
				expect((yield* call("GET", `/v1/sessions/${id}`)).body.status).toBe("idle")
				expect(ran).toEqual([])

				const answered = yield* send(call, id, [confirm(use.tool_use_id, "allow")])
				expect(answered.status).toBe(200)
				expect(answered.body.data).toEqual([
					{ type: "user.tool_confirmation", tool_use_id: use.tool_use_id, result: "allow" },
				])
				const all = yield* until(call, id, ended, "turn did not end")
				expect(ran).toEqual(["prod"])
				expect(lastMessage(all)).toBe("saw ok:deployed prod")
				expect(all.filter((e) => e.type === "agent.mcp_tool_use")).toHaveLength(1)
				expect(all.filter((e) => e.type === "agent.mcp_tool_result")).toMatchObject([
					{ tool_use_id: use.tool_use_id, is_error: false },
				])
				expect(idles(all).at(-1)).toMatchObject({ stop_reason: { type: "end_turn" }, turn: 1 })
				const spans = all.filter((e) => e.type === "span.model_request_end")
				expect(spans.map((e) => e.model_usage)).toEqual([
					{ input_tokens: 3, output_tokens: 2 },
					{ input_tokens: 3, output_tokens: 2 },
				])
				expect((yield* call("GET", `/v1/sessions/${id}`)).body.usage).toEqual({
					input_tokens: 6,
					output_tokens: 4,
				})
				expect((yield* send(call, id, [confirm(use.tool_use_id, "deny")])).status).toBe(409)
			}),
		)
	}, 30_000)

	it("tells the model a call was denied, with the person's reason, and never runs it", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				yield* send(call, id, [message("deploy")])
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.mcp_tool_use")
				expect(
					(yield* send(call, id, [confirm(use.tool_use_id, "deny", "not on a Friday")])).status,
				).toBe(200)
				const all = yield* until(call, id, ended, "turn did not end")
				expect(ran).toEqual([])
				expect(lastMessage(all)).toContain(
					"Tool call blocked: The user denied this call: not on a Friday",
				)
				expect(all.find((e) => e.type === "user.tool_confirmation")).toMatchObject({
					result: "deny",
					deny_message: "not on a Friday",
				})
				expect(all.find((e) => e.type === "agent.mcp_tool_result")).toMatchObject({
					tool_use_id: use.tool_use_id,
					rejected: "blocked",
				})
			}),
		)
	}, 30_000)

	it("asks before running a read-only tool and honors an explicit always_allow policy", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call, [
					LOOKUP,
					{
						type: "mcp_toolset",
						mcp_server_name: "docs",
						configs: [{ name: "deploy", permission_policy: { type: "always_allow" } }],
					},
				])
				yield* send(call, id, [message("search")])
				const first = yield* until(call, id, waiting(1), "search did not pause")
				const search = find(first, "agent.mcp_tool_use")
				expect(search).toMatchObject({ name: "search", evaluated_permission: "ask" })
				expect((yield* send(call, id, [confirm(search.tool_use_id, "allow")])).status).toBe(200)
				yield* until(call, id, ended, "search did not end")
				yield* send(call, id, [message("deploy")])
				const all = yield* until(call, id, (e) => idles(e).length >= 3, "deploy did not end")
				expect(
					all.find((e) => e.type === "agent.mcp_tool_use" && e.name === "deploy"),
				).toMatchObject({ evaluated_permission: "allow" })
				expect(ran).toEqual(["prod"])
			}),
		)
	}, 30_000)

	it("asks for a read-only tool the agent says always asks", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call, [
					{
						type: "mcp_toolset",
						mcp_server_name: "docs",
						default_config: { permission_policy: { type: "always_ask" } },
					},
				])
				yield* send(call, id, [message("search")])
				const paused = yield* until(call, id, waiting(1), "no pause")
				expect(find(paused, "agent.mcp_tool_use")).toMatchObject({
					name: "search",
					evaluated_permission: "ask",
				})
			}),
		)
	}, 30_000)

	it("waits for both calls of a round, answered one at a time, before the turn goes on", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				yield* send(call, id, [message("two")])
				const paused = yield* until(call, id, waiting(1), "no pause")
				const uses = paused.filter((e) => e.type === "agent.mcp_tool_use")
				expect(uses).toHaveLength(2)
				const byId = (a: string, b: string) => a.localeCompare(b)
				expect(idles(paused).at(-1)?.stop_reason.event_ids.toSorted(byId)).toEqual(
					uses.map((e) => e.tool_use_id).toSorted(byId),
				)
				yield* send(call, id, [confirm(uses[0]!.tool_use_id, "allow")])
				yield* Effect.sleep("150 millis")
				const between = yield* events(call, id)
				expect(between.filter((e) => e.type === "session.status_running")).toHaveLength(1)
				expect(ran).toEqual([])
				yield* send(call, id, [confirm(uses[1]!.tool_use_id, "deny")])
				const all = yield* until(call, id, ended, "turn did not end")
				expect(ran).toEqual(["a"])
				expect(lastMessage(all)).toMatch(
					/^saw ok:deployed a \| error:.*The user denied this call\./su,
				)
			}),
		)
	}, 30_000)

	it("refuses a message while the turn waits, and ends the waiting turn on interrupt", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				yield* send(call, id, [message("deploy")])
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.mcp_tool_use")
				const hurried = yield* send(call, id, [message("hurry")])
				expect(hurried.status).toBe(409)
				expect(hurried.body.error).toMatchObject({
					type: "conflict_error",
					code: "session_awaiting_action",
				})
				expect((yield* send(call, id, [{ type: "user.interrupt" }])).status).toBe(200)
				const all = yield* until(call, id, ended, "turn did not end")
				expect(idles(all).at(-1)).toMatchObject({
					stop_reason: { type: "interrupted" },
					turn: 1,
					cancelled_event_ids: [use.tool_use_id],
				})
				const late = yield* send(call, id, [confirm(use.tool_use_id, "allow")])
				expect(late.status).toBe(409)
				expect(late.body.error.code).toBeUndefined()
				expect(ran).toEqual([])
				yield* send(call, id, [message("hello")])
				const next = yield* until(call, id, (e) => idles(e).length >= 3, "next turn did not end")
				expect(lastMessage(next)).toBe("echo hello")
				expect(ran).toEqual([])
			}),
		)
	}, 30_000)

	it("ends a waiting turn when the session is archived", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				yield* send(call, id, [message("deploy")])
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.mcp_tool_use")
				expect((yield* call("POST", `/v1/sessions/${id}/archive`)).status).toBe(200)
				const all = yield* until(
					call,
					id,
					(e) => e.some((x) => x.type === "session.archived"),
					"not archived",
				)
				expect(find(all, "session.status_terminated")).toMatchObject({
					cancelled_event_ids: [use.tool_use_id],
				})
				expect((yield* send(call, id, [confirm(use.tool_use_id, "allow")])).status).toBe(409)
				expect(ran).toEqual([])
			}),
		)
	}, 30_000)

	it("ends the turn when the interrupt commits just before the pause does", async () => {
		await world((call, harness) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				let interrupts = 0
				harness.pausing.before = () =>
					Effect.suspend(() =>
						interrupts++ > 0
							? Effect.void
							: Effect.asVoid(send(call, id, [{ type: "user.interrupt" }])),
					)
				yield* send(call, id, [message("deploy")])
				const all = yield* until(call, id, ended, "turn did not end")
				const use = find(all, "agent.mcp_tool_use")
				expect(interrupts).toBeGreaterThan(0)
				expect(idles(all)).toHaveLength(1)
				expect(idles(all)[0]).toMatchObject({
					stop_reason: { type: "interrupted" },
					turn: 1,
					cancelled_event_ids: [use.tool_use_id],
				})
				expect(all.findIndex((e) => e.type === "user.interrupt")).toBeLessThan(
					all.findIndex((e) => e.type === "session.status_idle"),
				)
				expect((yield* send(call, id, [confirm(use.tool_use_id, "allow")])).status).toBe(409)
				yield* send(call, id, [message("hello")])
				const next = yield* until(call, id, (e) => idles(e).length >= 2, "next turn did not end")
				expect(lastMessage(next)).toBe("echo hello")
				expect(ran).toEqual([])
			}),
		)
	}, 30_000)

	it("runs the message queued behind a waiting turn once that turn is interrupted", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				const sent = yield* send(call, id, [message("deploy"), message("hello")])
				expect(
					(sent.body.data as ReadonlyArray<{ readonly queued: boolean }>).map((e) => e.queued),
				).toEqual([false, true])
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.mcp_tool_use")
				expect((yield* send(call, id, [{ type: "user.interrupt" }])).status).toBe(200)
				const all = yield* until(call, id, (e) => idles(e).length >= 3, "queued turn did not end")
				expect(idles(all).map((e) => [e.stop_reason.type, e.turn])).toEqual([
					["requires_action", 1],
					["interrupted", 1],
					["end_turn", 2],
				])
				expect(idles(all)[1]?.cancelled_event_ids).toEqual([use.tool_use_id])
				expect(lastMessage(all)).toBe("echo hello")
				expect(ran).toEqual([])
			}),
		)
	}, 30_000)

	it("leaves a later segment alone when an earlier segment's deadline fires late", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const sessions = yield* Session
				const id = yield* session(call)
				let release = () => {}
				held = new Promise<void>((resolve) => {
					release = resolve
				})
				yield* send(call, id, [message("hold")])
				const paused = yield* until(call, id, waiting(1), "no pause")
				yield* send(call, id, [confirm(find(paused, "agent.mcp_tool_use").tool_use_id, "allow")])
				yield* until(
					call,
					id,
					(e) => e.filter((x) => x.type === "span.model_request_start").length >= 2,
					"the second segment did not start",
				)
				const deadline = (segment: number) =>
					new AbandonTurn({
						session_id: SessionId.make(id),
						turn: 1,
						segment,
						error_type: "model_request_timeout",
						message: "Model request timed out.",
					})
				expect((yield* Effect.orDie(sessions.send(deadline(1)))).events).toEqual([])
				release()
				const all = yield* until(call, id, ended, "turn did not end")
				expect(all.some((e) => e.type === "session.error")).toBe(false)
				expect(idles(all).at(-1)).toMatchObject({ stop_reason: { type: "end_turn" }, turn: 1 })
				expect(lastMessage(all)).toBe("saw ok:deployed held")
			}),
		)
	}, 30_000)

	it("settles an event id once, for a message and an answer alike", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				expect((yield* send(call, id, [{ ...message("deploy"), id: "evt-1" }])).status).toBe(200)
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.mcp_tool_use")
				const reused = yield* send(call, id, [
					{ ...confirm(use.tool_use_id, "allow"), id: "evt-1" },
				])
				expect(reused.status).toBe(409)
				expect(JSON.stringify(reused.body)).toContain("already used for a different event")
				expect((yield* events(call, id)).some((e) => e.type === "user.tool_confirmation")).toBe(
					false,
				)
				expect(ran).toEqual([])
				const answered = yield* send(call, id, [
					{ ...confirm(use.tool_use_id, "allow"), id: "evt-2" },
				])
				expect(answered.status).toBe(200)
				const retried = yield* send(call, id, [
					{ ...confirm(use.tool_use_id, "allow"), id: "evt-2" },
				])
				expect([retried.status, retried.body]).toEqual([200, answered.body])
				expect(
					(yield* send(call, id, [{ ...confirm(use.tool_use_id, "deny"), id: "evt-2" }])).status,
				).toBe(409)
				const all = yield* until(call, id, ended, "turn did not end")
				expect(all.filter((e) => e.type === "user.tool_confirmation")).toHaveLength(1)
				expect(ran).toEqual(["prod"])
				const message2 = yield* send(call, id, [{ ...message("again"), id: "evt-2" }])
				expect(message2.status).toBe(409)
				expect(JSON.stringify(message2.body)).toContain("already used for a different event")
				expect((yield* events(call, id)).filter((e) => e.type === "user.message")).toHaveLength(1)
			}),
		)
	}, 30_000)

	it("keeps two sessions' calls apart when their harnesses give them the same ids", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const first = yield* session(call)
				const second = yield* session(call)
				yield* send(call, first, [message("deploy")])
				yield* send(call, second, [message("deploy")])
				const a = find(
					yield* until(call, first, waiting(1), "no first pause"),
					"agent.mcp_tool_use",
				)
				const b = find(
					yield* until(call, second, waiting(1), "no second pause"),
					"agent.mcp_tool_use",
				)
				expect(b.tool_use_id).toBe(a.tool_use_id)
				yield* send(call, first, [confirm(a.tool_use_id, "deny")])
				yield* until(call, first, ended, "first turn did not end")
				expect(idles(yield* events(call, second)).at(-1)).toMatchObject({
					stop_reason: { type: "requires_action", event_ids: [b.tool_use_id] },
				})
				expect(ran).toEqual([])
				yield* send(call, second, [confirm(b.tool_use_id, "allow")])
				const all = yield* until(call, second, ended, "second turn did not end")
				expect(lastMessage(all)).toBe("saw ok:deployed prod")
				expect(ran).toEqual(["prod"])
			}),
		)
	}, 30_000)

	it("keeps a waiting call through a restart of the session object, and runs it once allowed", async () => {
		await world((call, harness) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				yield* send(call, id, [message("deploy")])
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.mcp_tool_use")
				yield* Effect.promise(() => harness.restartPi(conversationName(id)))
				yield* send(call, id, [confirm(use.tool_use_id, "allow")])
				const all = yield* until(call, id, ended, "turn did not end")
				expect(ran).toEqual(["prod"])
				expect(lastMessage(all)).toBe("saw ok:deployed prod")
			}),
		)
	}, 30_000)

	it("never lets an answer for one call reach a later call the provider gave the same id", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				yield* send(call, id, [message("same")])
				const first = yield* until(call, id, waiting(1), "no first pause")
				const firstUse = find(first, "agent.mcp_tool_use")
				yield* send(call, id, [confirm(firstUse.tool_use_id, "allow")])
				yield* until(call, id, ended, "first turn did not end")
				yield* send(call, id, [message("same")])
				const second = yield* until(call, id, waiting(2), "no second pause")
				const secondUse = second.filter((e) => e.type === "agent.mcp_tool_use").at(-1)
				expect(secondUse?.tool_use_id).not.toBe(firstUse.tool_use_id)
				expect((yield* send(call, id, [confirm(firstUse.tool_use_id, "allow")])).status).toBe(409)
				expect(ran).toEqual(["x"])
			}),
		)
	}, 30_000)
})

describe("custom tools", () => {
	it("hands the application the call with its arguments as Pi checked them, and gives the model its result", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				yield* send(call, id, [message("custom")])
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.custom_tool_use")
				expect(use).toMatchObject({ name: "lookup_order", input: { order: 42 } })
				expect((yield* send(call, id, [confirm(use.tool_use_id, "allow")])).status).toBe(409)
				const answered = yield* send(call, id, [
					{
						type: "user.custom_tool_result",
						custom_tool_use_id: use.tool_use_id,
						content: [{ type: "text", text: "shipped" }],
					},
				])
				expect(answered.status).toBe(200)
				expect(answered.body.data).toEqual([
					{ type: "user.custom_tool_result", custom_tool_use_id: use.tool_use_id },
				])
				const all = yield* until(call, id, ended, "turn did not end")
				expect(lastMessage(all)).toBe("saw ok:shipped")
				expect(all.filter((e) => e.type === "agent.custom_tool_use")).toHaveLength(1)
			}),
		)
	}, 30_000)

	it("publishes arguments larger than an ordinary call's whole", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				yield* send(call, id, [message("big")])
				const paused = yield* until(call, id, waiting(1), "no pause")
				const use = find(paused, "agent.custom_tool_use")
				expect(use.input).toEqual({ order: 1, note: BIG })
				expect(use.truncated).toBeUndefined()
			}),
		)
	}, 30_000)

	it("keeps a call Pi refuses as invalid an ordinary failed call that nobody answers", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				yield* send(call, id, [message("invalid")])
				const all = yield* until(call, id, ended, "turn did not end")
				expect(waiting(1)(all)).toBe(false)
				expect(all.some((e) => e.type === "agent.custom_tool_use")).toBe(false)
				expect(find(all, "agent.tool_result")).toMatchObject({ is_error: true })
				expect(lastMessage(all)).toMatch(/^saw error:/u)
			}),
		)
	}, 30_000)

	it("refuses tool declarations Pi could not use", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const create = (tools: ReadonlyArray<unknown>) =>
					call("POST", "/v1/agents", {
						name: "Operator",
						model: "gpt-4o-mini",
						mcp_servers: [DOCS],
						tools,
					})
				const remote = yield* create([
					{
						...LOOKUP,
						input_schema: { type: "object", properties: { a: { $ref: "#/$defs/missing" } } },
					},
				])
				expect(remote.status).toBe(400)
				expect(remote.body.error.message).toContain("#/$defs/missing")
				const local = yield* create([
					{
						...LOOKUP,
						input_schema: {
							type: "object",
							$defs: { order: { type: "integer" } },
							properties: { order: { $ref: "#/$defs/order" } },
						},
					},
				])
				expect(local.status).toBe(201)
				expect(
					(yield* create([{ type: "mcp_toolset", mcp_server_name: "elsewhere" }])).status,
				).toBe(400)
				expect((yield* create([{ ...LOOKUP, name: "read" }])).status).toBe(400)
				expect((yield* create([LOOKUP, LOOKUP])).status).toBe(400)
				for (const names of [["find-item", "find_item"], ["tool-search"], ["mcp-_docs__find"]]) {
					const clash = yield* create(names.map((name) => ({ ...LOOKUP, name })))
					expect(clash.status).toBe(400)
					expect(clash.body.error.message).toContain("a script would call it")
				}
				for (const a of [{ $ref: "#/$defs/%E0%A4%A" }, { type: "string", pattern: "(" }]) {
					const unusable = yield* create([
						{ ...LOOKUP, input_schema: { type: "object", properties: { a } } },
					])
					expect(unusable.status).toBe(400)
					expect(unusable.body.error.message).toContain(
						'"lookup_order" cannot be declared: its input_schema is not usable',
					)
				}
				const literal = yield* create([
					{
						...LOOKUP,
						input_schema: {
							type: "object",
							properties: {
								a: {
									type: "object",
									examples: [{ $ref: "#/nowhere" }],
									default: { $ref: "elsewhere" },
									enum: [{ $ref: "#/$defs/none" }],
								},
								b: { const: { $ref: "#/$defs/none" } },
							},
						},
					},
				])
				expect(literal.status).toBe(201)
			}),
		)
	}, 30_000)

	it("names a keyed create as it was named before agents declared tools, however a schema is ordered", async () => {
		const sent: Array<string | undefined> = []
		await world(
			(call) =>
				Effect.gen(function* () {
					const digest = yield* Digest.Digest
					const key = { "idempotency-key": "before-tools-1" }
					const named = { name: "Researcher", model: "gpt-4o-mini" }
					const created = yield* call("POST", "/v1/agents", named, key)
					expect(created.status).toBe(201)
					const empty = yield* call("POST", "/v1/agents", { ...named, tools: [] }, key)
					expect([empty.status, empty.body]).toEqual([created.status, created.body])
					const before = yield* idempotentCommandId(digest, "create-agent", [
						"create",
						"agent",
						"before-tools-1",
						'{"description":null,"model":{"id":"gpt-4o-mini"},"name":"Researcher","system":null}',
					])
					expect(sent).toEqual([before, before])

					const other = { "idempotency-key": "ordered-1" }
					const withTool = (input_schema: unknown) =>
						call("POST", "/v1/agents", { ...named, tools: [{ ...LOOKUP, input_schema }] }, other)
					const first = yield* withTool({
						type: "object",
						properties: { order: { type: "integer", minimum: 1 } },
						required: ["order"],
					})
					expect(first.status).toBe(201)
					const reordered = yield* withTool({
						required: ["order"],
						properties: { order: { minimum: 1, type: "integer" } },
						type: "object",
					})
					expect([reordered.status, reordered.body]).toEqual([first.status, first.body])
					const different = yield* withTool({ type: "object", properties: {} })
					expect(different.status).toBe(409)
				}),
			(make) =>
				Effect.gen(function* () {
					const real = yield* CreateAgentDecision
					return yield* make.pipe(
						Effect.provideService(CreateAgentDecision, {
							...real,
							send: (command, options) => {
								sent.push(options?.commandId)
								return real.send(command, options)
							},
						}),
					)
				}),
		)
	}, 30_000)

	it("holds an update to the agent at the version it names, whatever commits beside it", async () => {
		const OTHER = { type: "url", name: "other", url: "https://other.example/mcp" }
		const docsToolset = { type: "mcp_toolset", mcp_server_name: "docs" }
		let beside: Effect.Effect<void> = Effect.void
		await world(
			(call) =>
				Effect.gen(function* () {
					const updateAgent = yield* UpdateAgentDecision
					const created = yield* call("POST", "/v1/agents", {
						name: "Operator",
						model: "gpt-4o-mini",
						mcp_servers: [DOCS],
					})
					const id = AgentId.make(created.body.id)
					const dropDocs = (expected_version: number) =>
						updateAgent
							.send(
								new UpdateAgent({
									agent_id: id,
									expected_version,
									next_version_id: AgentVersionId.make(`aver_beside_${expected_version}`),
									changes: { mcp_servers: encodeMcpServers([OTHER as never]) ?? "" },
								}),
							)
							.pipe(Effect.orDie, Effect.asVoid)

					beside = dropDocs(1)
					const ahead = yield* call("POST", `/v1/agents/${id}`, {
						version: 2,
						tools: [docsToolset],
					})
					expect(ahead.status).toBe(409)
					const now = yield* call("GET", `/v1/agents/${id}`)
					expect([now.body.version, now.body.tools]).toEqual([2, []])

					beside = updateAgent
						.send(
							new UpdateAgent({
								agent_id: id,
								expected_version: 2,
								next_version_id: AgentVersionId.make("aver_beside_2"),
								changes: { mcp_servers: encodeMcpServers([DOCS as never]) ?? "" },
							}),
						)
						.pipe(Effect.orDie, Effect.asVoid)
					const left = yield* call("POST", `/v1/agents/${id}`, {
						version: 2,
						tools: [{ type: "mcp_toolset", mcp_server_name: "other" }],
					})
					expect(left.status).toBe(409)
					const after = yield* call("GET", `/v1/agents/${id}`)
					expect([after.body.version, after.body.tools]).toEqual([3, []])
				}),
			(make) =>
				Effect.gen(function* () {
					const real = yield* Agent
					return yield* make.pipe(
						Effect.provideService(Agent, {
							...real,
							get: (id) =>
								Effect.tap(real.get(id), () => {
									const commit = beside
									beside = Effect.void
									return commit
								}),
						}),
					)
				}),
		)
	}, 30_000)

	it("has no command text for tools that together are more than an agent keeps", () => {
		const many = Array.from({ length: 64 }, (_, index) => ({
			type: "custom" as const,
			name: `lookup_${index}`,
			description: "d".repeat(4096),
			input_schema: {
				type: "object",
				properties: { note: { type: "string", description: "x".repeat(16_000) } },
			},
		}))
		expect(encodeAgentTools(many)).toBeUndefined()
		expect(encodeAgentTools(many.slice(0, 2))).toBe(JSON.stringify(many.slice(0, 2)))
	})

	it("changes only what an update names, held to the agent as the caller saw it", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const OTHER = { type: "url", name: "other", url: "https://other.example/mcp" }
				const toolset = { type: "mcp_toolset", mcp_server_name: "docs" }
				const created = yield* call("POST", "/v1/agents", {
					name: "Operator",
					model: "gpt-4o-mini",
					mcp_servers: [DOCS],
					tools: [toolset, LOOKUP],
				})
				expect(created.status).toBe(201)
				const id = created.body.id as string
				const update = (
					version: number,
					changes: {
						readonly mcp_servers?: ReadonlyArray<unknown>
						readonly tools?: ReadonlyArray<unknown>
					},
				) => call("POST", `/v1/agents/${id}`, { version, ...changes })

				const added = yield* update(1, { mcp_servers: [DOCS, OTHER] })
				expect(added.status).toBe(200)
				expect(added.body.version).toBe(2)
				expect(added.body.tools).toEqual(created.body.tools)

				const orphaned = yield* update(2, { mcp_servers: [OTHER] })
				expect(orphaned.status).toBe(400)
				expect(orphaned.body.error.message).toContain('"docs"')

				const elsewhere = yield* update(2, {
					tools: [{ type: "mcp_toolset", mcp_server_name: "elsewhere" }],
				})
				expect(elsewhere.status).toBe(400)
				const onlyCustom = yield* update(2, { tools: [LOOKUP] })
				expect(onlyCustom.status).toBe(200)
				expect(onlyCustom.body.version).toBe(3)
				expect(onlyCustom.body.mcp_servers).toEqual(added.body.mcp_servers)

				const stale = yield* update(1, { mcp_servers: [OTHER] })
				expect(stale.status).toBe(409)
				const staleTools = yield* update(1, {
					tools: [{ type: "mcp_toolset", mcp_server_name: "elsewhere" }],
				})
				expect(staleTools.status).toBe(409)
			}),
		)
	}, 30_000)

	it("refuses an answer whose call id no call could have", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				const long = "x".repeat(4096)
				expect((yield* send(call, id, [confirm(long, "allow")])).status).toBe(400)
				expect(
					(yield* send(call, id, [
						{
							type: "user.custom_tool_result",
							custom_tool_use_id: long,
							content: [{ type: "text", text: "late" }],
						},
					])).status,
				).toBe(400)
			}),
		)
	}, 30_000)
})
