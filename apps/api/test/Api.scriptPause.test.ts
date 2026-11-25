import { CodemodeSandbox } from "@earendil-works/pi-codemode"
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { MAX_TOOL_CALLS_PER_TURN } from "@checkfu/domain/Session/SessionTypes"
import { emptySessionFold, foldSessionEvents } from "@checkfu/sdk"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import fc from "fast-check"
import * as Schedule from "effect/Schedule"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { makeApiHandler } from "../src/Http/Router.ts"
import type { ScriptDeadline } from "../src/Pi/PiCodemode.ts"
import { AUTH_HEADERS, makePiDurableTestLayer, sendRequest } from "./helpers/ApiHarness.ts"
import type { TestMcpTool } from "./helpers/ApiHarness.ts"

const DOCS = { type: "url", name: "docs", url: "https://docs.mcp.example/mcp" }

const usage = {
	input: 3,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

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
	usage,
	stopReason,
	timestamp: 0,
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

const scriptResult = (context: TranscriptContext): string | undefined => {
	const start = context.messages.findLastIndex((message) => message.role === "user")
	const result = context.messages.slice(start + 1).find((message) => message.role === "toolResult")
	return result === undefined || result.role !== "toolResult"
		? undefined
		: `${result.isError ? "error" : "ok"}:${result.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("")}`
}

const SCRIPTS = new Map([
	["ask", 'const r = await tools.mcp__docs__deploy({ target: "prod" }); return "script got " + r'],
	[
		"deny",
		[
			'try { await tools.mcp__docs__deploy({ target: "prod" }); return "ran" }',
			'catch (error) { return "caught " + error.message }',
		].join("\n"),
	],
	["custom", 'const r = await tools.lookup_order({ order: 42 }); return "script got " + r'],
	[
		"late",
		[
			`for (let i = 0; i < ${MAX_TOOL_CALLS_PER_TURN + 6}; i++) {`,
			'  await tools.mcp__docs__search({ query: "q" + i })',
			"}",
			'const r = await tools.mcp__docs__deploy({ target: "late" }); return "script got " + r',
		].join("\n"),
	],
	[
		"slow",
		[
			"const [a, b] = await Promise.all([",
			'  tools.mcp__docs__deploy({ target: "y" }),',
			"  tools.mcp__docs__slow({}),",
			"]);",
			'return a + " / " + b',
		].join("\n"),
	],
	[
		"parallel",
		[
			"const [a, b] = await Promise.all([",
			'  tools.mcp__docs__deploy({ target: "x" }),',
			'  tools.mcp__docs__search({ query: "q" }),',
			"]);",
			'return a + " / " + b',
		].join("\n"),
	],
])

const model = async (current: Model<Api>, context: TranscriptContext) => {
	const result = scriptResult(context)
	if (result !== undefined) {
		return answer(current, [{ type: "text", text: `saw ${result}` }], "stop")
	}
	const text = lastUserText(context)
	const planned = text.startsWith("spause:")
		? (JSON.parse(text.slice("spause:".length)) as ReadonlyArray<string>)
				.map(
					(target) =>
						`try { await tools.mcp__docs__deploy(${JSON.stringify({ target })}) } catch {}`,
				)
				.concat('return "script done"')
				.join("\n")
		: undefined
	const code = planned ?? SCRIPTS.get(text)
	return code === undefined
		? answer(current, [{ type: "text", text: "nothing to run" }], "stop")
		: answer(
				current,
				[{ type: "toolCall", id: "c1", name: "codemode", arguments: { code } }],
				"toolUse",
			)
}

const deployed: Array<string> = []
const searched: Array<string> = []
const MCP_TOOLS: ReadonlyArray<TestMcpTool> = [
	{
		server: "docs",
		name: "deploy",
		parameters: { type: "object", properties: { target: { type: "string" } } },
		run: (args) => {
			const target = (args as { readonly target: string }).target
			deployed.push(target)
			return `deployed ${target}`
		},
	},
	{
		server: "docs",
		name: "slow",
		readOnly: true,
		run: async () => {
			await sleep(2000)
			return "slow done"
		},
	},
	{
		server: "docs",
		name: "search",
		readOnly: true,
		run: (args) => {
			searched.push((args as { readonly query: string }).query)
			return "found"
		},
	},
]

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})

const LOOKUP = {
	type: "custom",
	name: "lookup_order",
	description: "Looks an order up in the caller's system",
	input_schema: { type: "object", properties: { order: { type: "integer" } }, required: ["order"] },
}

interface Ev {
	readonly seq: number
	readonly type: string
	readonly rejected?: string
	readonly tool_use_id: string
	readonly name?: string
	readonly input?: unknown
	readonly is_error?: boolean
	readonly stop_reason: { readonly type: string; readonly event_ids: ReadonlyArray<string> }
	readonly content: ReadonlyArray<{ readonly text: string }>
}

type Call = (
	method: string,
	path: string,
	payload?: unknown,
) => Effect.Effect<{ readonly status: number; readonly body: any }>

type Hosted = Layer.Success<ReturnType<typeof makePiDurableTestLayer>["layer"]>

const world = async <A>(
	options: {
		readonly sandbox?: (opening: number) => CodemodeSandbox
		readonly deadline?: ScriptDeadline
	},
	body: (
		call: Call,
		harness: ReturnType<typeof makePiDurableTestLayer>,
	) => Effect.Effect<A, never, Hosted | Scope.Scope>,
): Promise<A> => {
	deployed.length = 0
	searched.length = 0
	const sandboxes: Array<CodemodeSandbox> = []
	const harness = makePiDurableTestLayer(model, {
		mcpTools: MCP_TOOLS,
		codemode: {
			sandbox: (opening) => {
				const sandbox = options.sandbox?.(opening) ?? new CodemodeSandbox()
				sandboxes.push(sandbox)
				return sandbox
			},
			...(options.deadline === undefined ? {} : { deadline: options.deadline }),
		},
	})
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				return yield* body(
					(method, path, payload) =>
						Effect.gen(function* () {
							const res = yield* sendRequest(apiFetch, {
								method,
								path,
								headers: AUTH_HEADERS,
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
		await Promise.all(sandboxes.map((sandbox) => sandbox.close()))
	}
}

const session = (call: Call) =>
	Effect.gen(function* () {
		const agent = yield* call("POST", "/v1/agents", {
			name: "Operator",
			model: "gpt-4o-mini",
			mcp_servers: [DOCS],
			tools: [
				LOOKUP,
				{
					type: "mcp_toolset",
					mcp_server_name: DOCS.name,
					configs: ["slow", "search"].map((name) => ({
						name,
						permission_policy: { type: "always_allow" },
					})),
				},
			],
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
			Effect.repeat({ schedule: Schedule.spaced("20 millis"), times: 750, until: done }),
		)
		if (!done(all)) {
			return yield* Effect.die(new Error(`${what}: ${JSON.stringify(all.map((e) => e.type))}`))
		}
		return all
	})

const allEvents = (call: Call, id: string) =>
	Effect.gen(function* () {
		const all: Array<Ev> = []
		while (true) {
			const after = all.at(-1)?.seq
			const page = (yield* call(
				"GET",
				`/v1/sessions/${id}/events?limit=100${after === undefined ? "" : `&after=${after}`}`,
			)).body as { readonly data: ReadonlyArray<Ev> }
			all.push(...page.data)
			if (page.data.length < 100) {
				return all
			}
		}
	})

const idles = (all: ReadonlyArray<Ev>) => all.filter((e) => e.type === "session.status_idle")
const waiting = (all: ReadonlyArray<Ev>) =>
	idles(all).some((e) => e.stop_reason.type === "requires_action")
const ended = (all: ReadonlyArray<Ev>) =>
	idles(all).some((e) => e.stop_reason.type !== "requires_action")
const lastMessage = (all: ReadonlyArray<Ev>): string | undefined =>
	all.findLast((e) => e.type === "agent.message")?.content[0]?.text

const parkOn = (call: Call, id: string, name: string, requestType: string) =>
	Effect.gen(function* () {
		expect((yield* send(call, id, [message(name)])).status).toBe(200)
		const all = yield* until(call, id, waiting, "the script never paused")
		const script = all.find((e) => e.type === "agent.tool_use" && e.name === "codemode")
		const request = all.find((e) => e.type === requestType)
		const idle = idles(all).find((e) => e.stop_reason.type === "requires_action")
		expect(script).toBeDefined()
		expect(request).not.toHaveProperty("parent_tool_use_id")
		expect(idle?.stop_reason.event_ids).toEqual([request?.tool_use_id])
		expect(all.indexOf(script as Ev)).toBeLessThan(all.indexOf(request as Ev))
		return { script: script as Ev, request: request as Ev }
	})

const confirm = (tool_use_id: string, result: "allow" | "deny", deny_message?: string) => ({
	type: "user.tool_confirmation",
	tool_use_id,
	result,
	...(deny_message === undefined ? {} : { deny_message }),
})

const PAUSE_RUNS = Number(
	process.env["PI_PROPERTY_RUNS"] ?? (process.env["CI"] === undefined ? 15 : 4),
)

const pauses = (all: ReadonlyArray<Ev>) =>
	idles(all).filter((e) => e.stop_reason.type === "requires_action")

describe("What a script that pauses on each call publishes", () => {
	it("runs the calls a person allows, marks the denied ones blocked, and publishes each once", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 3 }), async (allows) => {
				const targets = allows.map((_, index) => `p${index}`)
				await world({}, (call) =>
					Effect.gen(function* () {
						const id = yield* session(call)
						yield* send(call, id, [message(`spause:${JSON.stringify(targets)}`)])
						for (const [index, allow] of allows.entries()) {
							const all = yield* until(
								call,
								id,
								(seen) => pauses(seen).length > index || ended(seen),
								"the script neither paused nor ended",
							)
							const waitingOn = pauses(all).at(-1)?.stop_reason.event_ids[0]
							expect(waitingOn).toBeDefined()
							yield* send(call, id, [confirm(waitingOn ?? "", allow ? "allow" : "deny")])
						}
						const all = yield* until(call, id, ended, "the turn never ended")
						expect(lastMessage(all)).toMatch(/^saw ok:[^]*script done/)
						expect(deployed).toEqual(targets.filter((_, index) => allows[index] === true))
						const nested = all.filter((e) => e.type === "agent.mcp_tool_use")
						expect(new Set(nested.map((e) => e.tool_use_id)).size).toBe(targets.length)
						for (const use of nested) {
							const target = (use.input as { readonly target: string }).target
							const result = all.find(
								(e) => e.type === "agent.mcp_tool_result" && e.tool_use_id === use.tool_use_id,
							)
							expect(result).toBeDefined()
							if (allows[targets.indexOf(target)] === true) {
								expect(result?.rejected).toBeUndefined()
							} else {
								expect(result?.rejected).toBe("blocked")
							}
						}
					}),
				)
			}),
			{ numRuns: PAUSE_RUNS },
		)
	}, 600_000)
})

describe("a script that waits on a person", () => {
	it("parks on a call that asks, and once allowed goes on and runs the call once", async () => {
		await world({}, (call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				const { script, request } = yield* parkOn(call, id, "ask", "agent.mcp_tool_use")
				expect(request).toMatchObject({ name: "deploy", input: { target: "prod" } })
				expect(deployed).toEqual([])

				expect((yield* send(call, id, [confirm(request.tool_use_id, "allow")])).status).toBe(200)
				const all = yield* until(call, id, ended, "the turn never ended")
				expect(lastMessage(all)).toMatch(/^saw ok:[^]*script got deployed prod/)
				expect(deployed).toEqual(["prod"])
				const uses = all.filter((e) => e.type.endsWith("tool_use"))
				expect(uses.map((e) => e.tool_use_id)).toEqual([script.tool_use_id, request.tool_use_id])
				const results = all.filter((e) => e.type.endsWith("tool_result"))
				expect(results.map((e) => e.tool_use_id)).toEqual([request.tool_use_id, script.tool_use_id])
			}),
		)
	})

	it("publishes the result of a call that waited after its script's other calls filled the turn's limit", async () => {
		await world({}, (call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				const { script, request } = yield* parkOn(call, id, "late", "agent.mcp_tool_use")
				expect((yield* send(call, id, [confirm(request.tool_use_id, "allow")])).status).toBe(200)
				const all = yield* allEvents(call, id).pipe(
					Effect.repeat({ schedule: Schedule.spaced("20 millis"), times: 750, until: ended }),
				)
				expect(ended(all)).toBe(true)
				expect(deployed).toEqual(["late"])
				expect(searched).toHaveLength(MAX_TOOL_CALLS_PER_TURN + 6)

				const uses = all.filter((e) => e.type.endsWith("tool_use")).map((e) => e.tool_use_id)
				const results = all.filter((e) => e.type.endsWith("tool_result"))
				expect(results.map((e) => e.tool_use_id).toSorted()).toEqual(uses.toSorted())
				expect(uses.toSorted()).toEqual([script.tool_use_id, request.tool_use_id].toSorted())
				expect(results.find((e) => e.tool_use_id === request.tool_use_id)).toMatchObject({
					type: "agent.mcp_tool_result",
					is_error: false,
					content: [{ text: "deployed late" }],
				})
				expect(results.at(-1)?.tool_use_id).toBe(script.tool_use_id)
				const fold = foldSessionEvents(emptySessionFold("all"), all as never)
				expect([...fold.calls.values()].map((made) => made.status)).toEqual(uses.map(() => "done"))
			}),
		)
	})

	it("stays parked through a restart of the session object, and runs the call once", async () => {
		await world({}, (call, harness) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				const { request } = yield* parkOn(call, id, "ask", "agent.mcp_tool_use")
				yield* Effect.promise(() => harness.restartPi(id))
				expect((yield* send(call, id, [confirm(request.tool_use_id, "allow")])).status).toBe(200)
				const all = yield* until(call, id, ended, "the turn never ended")
				expect(lastMessage(all)).toMatch(/^saw ok:[^]*script got deployed prod/)
				expect(deployed).toEqual(["prod"])
			}),
		)
	})

	it("rejects the call in the script when denied, and the script can catch it", async () => {
		await world({}, (call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				const { request } = yield* parkOn(call, id, "deny", "agent.mcp_tool_use")
				expect(
					(yield* send(call, id, [confirm(request.tool_use_id, "deny", "not today")])).status,
				).toBe(200)
				const all = yield* until(call, id, ended, "the turn never ended")
				expect(lastMessage(all)).toMatch(/^saw ok:[^]*caught [^]*not today/)
				expect(deployed).toEqual([])
			}),
		)
	})

	it("hands a script's custom tool call to the application and gives the script its result", async () => {
		await world({}, (call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				const { request } = yield* parkOn(call, id, "custom", "agent.custom_tool_use")
				expect(request).toMatchObject({ name: "lookup_order", input: { order: 42 } })
				const result = {
					type: "user.custom_tool_result",
					custom_tool_use_id: request.tool_use_id,
					content: [{ type: "text", text: "shipped" }],
				}
				expect((yield* send(call, id, [result])).status).toBe(200)
				const all = yield* until(call, id, ended, "the turn never ended")
				expect(lastMessage(all)).toMatch(/^saw ok:[^]*script got shipped/)
			}),
		)
	})

	it("runs a call made beside the waiting one once, never again after the park", async () => {
		await world({}, (call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				const { request } = yield* parkOn(call, id, "parallel", "agent.mcp_tool_use")
				expect(searched).toEqual(["q"])
				expect((yield* send(call, id, [confirm(request.tool_use_id, "allow")])).status).toBe(200)
				const all = yield* until(call, id, ended, "the turn never ended")
				expect(lastMessage(all)).toMatch(/^saw ok:[^]*deployed x \/ found/)
				expect(searched).toEqual(["q"])
				expect(deployed).toEqual(["x"])
			}),
		)
	})

	it("ends the script with an error when it resumes in a sandbox other than the one it began in", async () => {
		await world(
			{
				sandbox: (opening) =>
					new CodemodeSandbox({ memoryLimitBytes: (opening === 1 ? 32 : 48) * 1024 * 1024 }),
			},
			(call, harness) =>
				Effect.gen(function* () {
					const id = yield* session(call)
					const { request } = yield* parkOn(call, id, "ask", "agent.mcp_tool_use")
					yield* Effect.promise(() => harness.restartPi(id))
					expect((yield* send(call, id, [confirm(request.tool_use_id, "allow")])).status).toBe(200)
					const all = yield* until(call, id, ended, "the turn never ended")
					expect(lastMessage(all)).toMatch(/^saw error:[^]*sandbox changed/)
				}),
		)
	})

	it("keeps counting a call still at work toward its deadline, and parks only once every call waits", async () => {
		await world({ deadline: { defaultMs: 1000, maxMs: 1000 } }, (call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				expect((yield* send(call, id, [message("slow")])).status).toBe(200)
				const all = yield* until(call, id, ended, "the turn never ended")
				expect(waiting(all)).toBe(false)
				expect(lastMessage(all)).toMatch(/^saw error:[^]*timed out/i)
				expect(deployed).toEqual([])
			}),
		)
	}, 20_000)

	it("does not count the time it waits toward its deadline", async () => {
		await world({ deadline: { defaultMs: 1000, maxMs: 1000 } }, (call) =>
			Effect.gen(function* () {
				const id = yield* session(call)
				const { request } = yield* parkOn(call, id, "ask", "agent.mcp_tool_use")
				yield* Effect.sleep("1500 millis")
				expect((yield* send(call, id, [confirm(request.tool_use_id, "allow")])).status).toBe(200)
				const all = yield* until(call, id, ended, "the turn never ended")
				expect(lastMessage(all)).toMatch(/^saw ok:[^]*script got deployed prod/)
			}),
		)
	}, 20_000)
})
