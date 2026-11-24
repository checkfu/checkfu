import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import type { ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { afterAll, describe, expect, it } from "vitest"
import { makeConnectionProxy } from "../src/Connection/ConnectionProxy.ts"
import type { ConnectionProxy } from "../src/Connection/ConnectionProxy.ts"
import { makeMcpUpstream } from "../src/Connection/McpUpstream.ts"
import { secretForms } from "../src/Connection/Scrub.ts"
import { boundStructured } from "../src/Connection/ResultBounds.ts"
import type { McpCallOutcome, McpUpstream } from "../src/Connection/McpUpstream.ts"
import {
	fencedMcpCall,
	mcpExtension,
	mcpToolName,
	withoutRemoteReferences,
} from "../src/Pi/PiMcp.ts"
import { MAX_MCP_TOOL_LIST_BYTES, PiMcpStore, parentCallId } from "../src/Pi/PiMcpStore.ts"
import { MODEL_TEXT_LIMITS } from "../src/Pi/PiToolText.ts"
import type { SqlExecutor } from "../src/Pi/PiMcpStore.ts"
import { startFakeMcpServer } from "./workerd/FakeMcpServer.ts"
import type { FakeMcpServer } from "./workerd/FakeMcpServer.ts"
import { makeTurnFence } from "../src/Workspace/WorkspaceFence.ts"
import type { TurnToken } from "../src/Workspace/WorkspaceFence.ts"

const executor = (db: DatabaseSync): SqlExecutor => ({
	exec: (query, ...bindings) => {
		const statement = db.prepare(query)
		const values = bindings as ReadonlyArray<SQLInputValue>
		if (statement.columns().length > 0) {
			return statement.all(...values)
		}
		statement.run(...values)
		return []
	},
	transaction: (run) => {
		db.exec("BEGIN")
		try {
			run()
			db.exec("COMMIT")
		} catch (error) {
			db.exec("ROLLBACK")
			throw error
		}
	},
})

const store = () => new PiMcpStore(executor(new DatabaseSync(":memory:")))

const TRACKER = { name: "tracker", url: "https://mcp.tracker.example/mcp", credential_id: "vcrd_1" }

const use = (id: string, name: string, input: Record<string, string> = {}): ToolEvent => ({
	type: "tool_use",
	tool_use_id: id,
	name,
	input,
})
const result = (id: string, text: string): ToolEvent => ({
	type: "tool_result",
	tool_use_id: id,
	content: [{ type: "text", text }],
	is_error: false,
})

// The events in the order the turn's reader takes them from the store.
const withMcpCalls = (mcp: PiMcpStore, events: ReadonlyArray<ToolEvent>): Array<ToolEvent> => {
	const served = mcp.served()
	return events.flatMap((event) =>
		event.type === "tool_use"
			? [served.named(event), ...served.nested(event.tool_use_id)]
			: [served.named(event)],
	)
}

describe("the session's MCP store", () => {
	it("remembers the bound servers and each one's tools", () => {
		const mcp = store()
		expect(mcp.servers()).toEqual([])
		expect(mcp.bind([TRACKER])).toBe(true)
		expect(mcp.bind([TRACKER])).toBe(false)
		expect(mcp.servers()).toEqual([{ binding: TRACKER, tools: null, unavailable: null }])

		const tools = [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }]
		mcp.listed("tracker", tools)
		expect(mcp.servers()).toEqual([{ binding: TRACKER, tools, unavailable: null }])

		expect(mcp.bind([{ ...TRACKER, credential_id: null }])).toBe(true)
		expect(mcp.servers()).toEqual([
			{ binding: { ...TRACKER, credential_id: null }, tools: null, unavailable: null },
		])
	})

	it("keeps no tool list too large for one row, and says why the server has no tools", () => {
		const mcp = store()
		mcp.bind([TRACKER])
		const huge = (name: string) => ({
			name,
			description: "A tool with a very large input schema.",
			inputSchema: { type: "object", description: "x".repeat(600_000) },
		})
		mcp.listed("tracker", [huge("a"), huge("b"), huge("c")])
		const [server] = mcp.servers()
		expect(server?.tools).toEqual([])
		expect(server?.unavailable).toContain(`more than the ${MAX_MCP_TOOL_LIST_BYTES}`)

		const extension = mcpExtension(server!, {
			call: () => Promise.reject(new Error("not called")),
			began: () => undefined,
			ended: () => undefined,
		})
		expect(extension.tools).toEqual([])
		expect(extension.namespace?.description).toContain("Its tools are not available")
	})

	it("names a call the model made to an MCP tool, keeping what the transcript recorded", () => {
		const mcp = store()
		mcp.began({ call_id: "call-1", server: "tracker", tool: "search.items", input: { q: "a" } })
		mcp.ended("call-1", { content: [{ type: "text", text: "ledger copy" }], is_error: false })

		expect(
			withMcpCalls(mcp, [
				use("call-0", "read"),
				result("call-0", "file"),
				use("call-1", "mcp__tracker__search_items", { q: "a" }),
				result("call-1", "3 found"),
			]),
		).toEqual([
			use("call-0", "read"),
			result("call-0", "file"),
			{
				type: "mcp_tool_use",
				tool_use_id: "call-1",
				mcp_server_name: "tracker",
				name: "search.items",
				input: { q: "a" },
			},
			{ ...result("call-1", "3 found"), type: "mcp_tool_result" },
		])
	})

	it("places a script's calls after the script call, in the order they were made", () => {
		const mcp = store()
		expect(parentCallId("call-1/c2")).toBe("call-1")
		expect(parentCallId("call-1")).toBeNull()
		mcp.began({ call_id: "call-1/c1", server: "tracker", tool: "echo", input: { text: "a" } })
		mcp.ended("call-1/c1", { content: [{ type: "text", text: "echo:a" }], is_error: false })
		mcp.began({ call_id: "call-1/c2", server: "tracker", tool: "echo", input: { text: "b" } })
		// A rerun of the script reattaches to the call it already made.
		mcp.began({ call_id: "call-1/c1", server: "tracker", tool: "echo", input: { text: "a" } })

		const merged = withMcpCalls(mcp, [use("call-1", "codemode"), result("call-1", "done")])
		expect(merged.map((event) => [event.type, event.tool_use_id])).toEqual([
			["tool_use", "call-1"],
			["mcp_tool_use", "call-1/c1"],
			["mcp_tool_result", "call-1/c1"],
			["mcp_tool_use", "call-1/c2"],
			["mcp_tool_result", "call-1/c2"],
			["tool_result", "call-1"],
		])
		expect(merged[1]).toMatchObject({ parent_tool_use_id: "call-1", input: { text: "a" } })
		expect(merged[2]).toMatchObject({ content: [{ type: "text", text: "echo:a" }] })
		// The second call never reported back.
		expect(merged[4]).toMatchObject({ is_error: true })
		expect(JSON.stringify(merged[4])).toContain("may or may not have completed")

		mcp.forgetCalls()
		expect(withMcpCalls(mcp, [use("call-1", "codemode")])).toEqual([use("call-1", "codemode")])
	})

	it("bounds what one call adds to the store", () => {
		const mcp = store()
		mcp.began({
			call_id: "x/c1",
			server: "tracker",
			tool: "echo",
			input: { text: "a".repeat(20_000) },
		})
		mcp.ended("x/c1", { content: [{ type: "text", text: "b".repeat(20_000) }], is_error: false })
		const [, call, answer] = withMcpCalls(mcp, [use("x", "codemode")])
		expect(call).toMatchObject({ input: {}, truncated: true })
		expect(answer?.type === "mcp_tool_result" && answer.content[0]?.text.length).toBe(16_384)
	})
})

describe("an MCP server's tools as a Pi extension", () => {
	const calls = (outcome: McpCallOutcome | Error) => {
		const seen: Array<unknown> = []
		return {
			seen,
			calls: {
				call: (_binding: unknown, tool: string, args: unknown) => {
					seen.push(["call", tool, args])
					return "ok" in outcome ? Promise.resolve(outcome) : Promise.reject(outcome)
				},
				began: (call: unknown) => seen.push(["began", call]),
				ended: (callId: string, result: unknown) => seen.push(["ended", callId, result]),
			},
		}
	}
	const execute = async (
		outcome: McpCallOutcome | Error,
		tool: { readonly outputSchema?: { readonly type: string } } = {},
		context: { readonly abortSignal?: AbortSignal } = {},
	) => {
		const { seen, calls: wiring } = calls(outcome)
		const extension = mcpExtension(
			{
				binding: TRACKER,
				tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" }, ...tool }],
			},
			wiring,
		)
		const [registered] = extension.tools ?? []
		const run = registered?.execute as unknown as (
			args: { readonly text: string },
			api: { readonly callId: string },
			context: { readonly abortSignal?: AbortSignal },
		) => Promise<object>
		return { seen, registered, result: await run({ text: "hi" }, { callId: "call-9" }, context) }
	}

	it("names tools so that a provider accepts them and keeps the rest for scripts", () => {
		expect(mcpToolName("tracker", "search.items/v2")).toBe("mcp__tracker__search_items_v2")
		const extension = mcpExtension(
			{
				binding: TRACKER,
				tools: [
					{ name: "echo", description: "Echo", inputSchema: { type: "object" } },
					{ name: "e".repeat(80), description: "Long", inputSchema: { type: "object" } },
					{ name: "echo", description: "Twice", inputSchema: { type: "object" } },
				],
			},
			calls({ ok: true, content: [], isError: false }).calls,
		)
		expect(extension.namespace).toEqual({
			name: "tracker",
			description: "MCP server at mcp.tracker.example.",
		})
		expect(
			extension.tools?.map((tool) => [tool.name.length <= 64, tool.deferred, tool.callers]),
		).toEqual([
			[true, true, undefined],
			[false, true, ["tools"]],
		])
		expect(
			mcpExtension({ binding: TRACKER, tools: null }, calls(new Error("unused")).calls),
		).toMatchObject({
			tools: [],
			namespace: { description: expect.stringContaining("could not be reached") },
		})
	})

	it("accepts whatever a schema describes by reference to another document", () => {
		expect(
			withoutRemoteReferences({
				type: "object",
				properties: {
					local: { $ref: "#/$defs/a" },
					remote: { $ref: "https://example.com/schema.json", description: "Elsewhere" },
					list: { type: "array", items: { $ref: "other.json" } },
				},
				$defs: { a: { type: "string" } },
			}),
		).toEqual({
			type: "object",
			properties: {
				local: { $ref: "#/$defs/a" },
				remote: { description: "Elsewhere" },
				list: { type: "array", items: {} },
			},
			$defs: { a: { type: "string" } },
		})
	})

	it("returns the server's answer and records the call", async () => {
		const { seen, result: answer } = await execute({
			ok: true,
			content: [
				{ type: "text", text: "echo:hi" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			structuredContent: { ignored: true },
			isError: false,
		})
		expect(answer).toEqual({
			output: [
				{ type: "text", text: "echo:hi" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			isError: false,
		})
		expect(seen).toEqual([
			["began", { call_id: "call-9", server: "tracker", tool: "echo", input: { text: "hi" } }],
			["call", "echo", { text: "hi" }],
			[
				"ended",
				"call-9",
				{
					content: [
						{ type: "text", text: "echo:hi" },
						{ type: "text", text: "[image/png image]" },
					],
					is_error: false,
				},
			],
		])
	})

	it("gives the model a note instead of an oversize JSON document cut part way", async () => {
		const rows = Array.from({ length: 5000 }, (_, id) => ({ id, name: `row ${id}` }))
		const document = JSON.stringify({ rows })
		const {
			registered,
			seen,
			result: answer,
		} = await execute(
			{
				ok: true,
				content: [{ type: "text", text: document }],
				structuredContent: { rows },
				isError: false,
			},
			{ outputSchema: { type: "object" } },
		)
		expect(registered?.outputLimits).toEqual(MODEL_TEXT_LIMITS)
		const { output, structuredOutput } = answer as {
			readonly output: ReadonlyArray<{ readonly type: string; readonly text: string }>
			readonly structuredOutput: unknown
		}
		expect(output).toHaveLength(1)
		expect(output[0]?.text).toContain("bytes of JSON")
		expect(output[0]?.text).toContain("Narrow the request")
		expect(output[0]?.text).not.toContain('"rows"')
		expect(Buffer.byteLength(output[0]?.text ?? "")).toBeLessThan(MODEL_TEXT_LIMITS.maxBytes)
		// Scripts still get the whole answer, bounded on its own.
		expect(structuredOutput).toEqual({ rows })
		expect(JSON.stringify(seen.at(-1))).toContain("Narrow the request")
	})

	it("hands a script the structured answer of a tool that declares one", async () => {
		const { registered, result: answer } = await execute(
			{
				ok: true,
				content: [{ type: "text", text: "{}" }],
				structuredContent: { sum: 5 },
				isError: false,
			},
			{ outputSchema: { type: "object" } },
		)
		expect(registered?.structuredOutputSchema).toEqual({ type: "object" })
		expect(answer).toMatchObject({ structuredOutput: { sum: 5 } })
	})

	it("turns a refusal or an unreachable connection into a tool error", async () => {
		const refused = await execute({
			ok: false,
			reason: "unauthorized",
			message: "The MCP server did not accept the credential (401).",
		})
		expect(refused.result).toEqual({
			output: [{ type: "text", text: "The MCP server did not accept the credential (401)." }],
			isError: true,
		})
		expect(refused.seen.at(-1)).toMatchObject(["ended", "call-9", { is_error: true }])

		const unreachable = await execute(new Error("rpc failed with tok_secret"))
		expect(JSON.stringify(unreachable.result)).not.toContain("tok_secret")
		expect(unreachable.result).toMatchObject({ isError: true })
	})

	it("sends nothing once the turn was interrupted", async () => {
		const aborted = new AbortController()
		aborted.abort()
		const { seen, result } = await execute(
			{ ok: true, content: [{ type: "text", text: "hi" }], isError: false },
			{},
			{ abortSignal: aborted.signal },
		)
		expect(seen).toEqual([])
		expect(result).toEqual({
			output: [{ type: "text", text: "The turn was interrupted before this call ran." }],
			isError: true,
		})
	})
})

describe("a connection's MCP client", () => {
	const servers: Array<FakeMcpServer> = []
	const server = async (
		accepted: ReadonlyArray<string> | null,
		options: { readonly stateful?: boolean } = {},
	) => {
		const started = await startFakeMcpServer(accepted, options)
		servers.push(started)
		return started
	}
	const clients: Array<McpUpstream> = []
	/** A session's client for `url`, sending through a connection that holds `target`. */
	const sessionClient = (url: string, proxy: ConnectionProxy) => {
		const client = makeMcpUpstream(url, proxy.forward)
		clients.push(client)
		return client
	}
	afterAll(async () => {
		await Promise.all(clients.map((client) => client.close()))
		await Promise.all(servers.map((started) => started.close()))
	})

	it("sends the secret only to the server it was stored for, whatever URL a caller names", async () => {
		const stored = await server(["tok_a"])
		const other = await server(null)
		const proxy = makeConnectionProxy(() => ({ url: stored.url, token: () => "tok_a" }))

		const wrong = sessionClient(other.url, proxy)
		expect(await wrong.callTool("echo", { text: "x" })).toMatchObject({
			ok: false,
			reason: "wrong_server",
		})
		expect(await wrong.listTools()).toMatchObject({ ok: false, reason: "wrong_server" })
		expect(other.tokens).toEqual([])

		expect(await sessionClient(stored.url, proxy).callTool("echo", { text: "x" })).toEqual({
			ok: true,
			content: [{ type: "text", text: "echo:x" }],
			isError: false,
		})
		expect(other.tokens).toEqual([])
	})

	it("lists tools with their schemas and returns structured answers", async () => {
		const open = await server(null)
		const client = sessionClient(
			open.url,
			makeConnectionProxy(() => ({ url: open.url, token: null })),
		)
		const listed = await client.listTools()
		expect(listed.ok && listed.tools.map((tool) => tool.name)).toEqual([
			"echo",
			"add",
			"picture",
			"leak",
		])
		expect(listed.ok && listed.tools[1]?.outputSchema).toMatchObject({ type: "object" })
		expect(await client.callTool("add", { a: 2, b: 3 })).toMatchObject({
			ok: true,
			structuredContent: { sum: 5 },
		})
		expect(open.tokens.every((token) => token === undefined)).toBe(true)
	})

	it("passes images on whole: the session's result hook bounds them", async () => {
		const open = await server(null)
		const client = sessionClient(
			open.url,
			makeConnectionProxy(() => ({ url: open.url, token: null })),
		)
		const answer = await client.callTool("picture", { first: 1024, second: 4096 })
		expect(answer.ok && answer.content.map((block) => block.type)).toEqual(["image", "image"])
	})

	it("reads the secret for every request and fails closed once it is gone", async () => {
		const guarded = await server(["tok_a"])
		let secret: string | null = "tok_a"
		const client = sessionClient(
			guarded.url,
			makeConnectionProxy(() => ({ url: guarded.url, token: () => secret })),
		)
		expect(await client.callTool("echo", { text: "1" })).toMatchObject({ ok: true })

		guarded.accept(["tok_b"])
		expect(await client.callTool("echo", { text: "2" })).toEqual({
			ok: false,
			reason: "unauthorized",
			message: "The MCP server did not accept the credential (401).",
		})
		secret = "tok_b"
		expect(await client.callTool("echo", { text: "3" })).toMatchObject({ ok: true })
		expect(guarded.calls.map((call) => call.token)).toEqual(["tok_a", "tok_b"])

		secret = null
		const before = guarded.tokens.length
		expect(await client.callTool("echo", { text: "4" })).toMatchObject({
			ok: false,
			reason: "credential_unavailable",
		})
		expect(guarded.tokens).toHaveLength(before)

		const gone = sessionClient(
			guarded.url,
			makeConnectionProxy(() => null),
		)
		expect(await gone.listTools()).toMatchObject({ reason: "credential_unavailable" })
	})

	it("keeps each session's MCP session to itself on one connection", async () => {
		const stateful = await server(["tok_a"], { stateful: true })
		const proxy = makeConnectionProxy(() => ({ url: stateful.url, token: () => "tok_a" }))
		const first = sessionClient(stateful.url, proxy)
		const second = sessionClient(stateful.url, proxy)

		expect(await first.callTool("echo", { text: "1" })).toMatchObject({ ok: true })
		expect(await second.callTool("echo", { text: "2" })).toMatchObject({ ok: true })
		expect(await first.callTool("echo", { text: "3" })).toMatchObject({ ok: true })

		const sessions = stateful.calls.map((call) => call.session)
		expect(sessions.every((session) => session !== undefined)).toBe(true)
		expect(sessions[0]).not.toBe(sessions[1])
		expect(sessions[2]).toBe(sessions[0])
	})

	it("returns no spelling of the credential, in text or in structured content", async () => {
		const secret = "tok a~b/c+d=e&f"
		const echoing = await server([secret])
		const client = sessionClient(
			echoing.url,
			makeConnectionProxy(() => ({ url: echoing.url, token: () => secret })),
		)
		const answer = await client.callTool("leak", {})
		expect(answer).toMatchObject({ ok: true })
		expect(echoing.calls.at(-1)?.token).toBe(secret)
		const seen = JSON.stringify(answer)
		// Every spelling the echo sent, worked out here rather than taken from the scrubber.
		const spellings = [
			secret,
			encodeURIComponent(secret),
			new URLSearchParams({ key: secret }).toString().slice(4),
			JSON.stringify(secret).slice(1, -1),
		]
		for (const spelling of spellings) {
			expect(seen).not.toContain(spelling)
			expect(seen).not.toContain(JSON.stringify(spelling).slice(1, -1))
		}
		expect(seen).toContain("[redacted]")
		expect(secretForms(secret)).toEqual(expect.arrayContaining(spellings))
	})

	it("answers a superseded turn's call without sending it", async () => {
		const sent: Array<string> = []
		let current = true
		const call = fencedMcpCall(
			() => Promise.resolve(current),
			(_binding, tool) => {
				sent.push(tool)
				return Promise.resolve({ ok: true, content: [], isError: false })
			},
		)
		expect(await call(TRACKER, "create_issue", {})).toMatchObject({ ok: true })
		current = false
		expect(await call(TRACKER, "create_issue", {})).toEqual({
			ok: false,
			reason: "failed",
			message: "This turn is no longer the session's current one, so the call was not sent.",
		})
		expect(sent).toEqual(["create_issue"])
	})

	it("sends nothing for a turn that a newer turn replaced", async () => {
		let newest: TurnToken | undefined
		const fence = makeTurnFence({ get: () => newest, put: (token) => (newest = token) })
		const sent: Array<number> = []
		const callAs = (turn: number) =>
			fencedMcpCall(
				() => fence.enter({ turn }),
				() => {
					sent.push(turn)
					return Promise.resolve({ ok: true, content: [], isError: false })
				},
			)(TRACKER, "create_issue", {})

		expect(await fence.enter({ turn: 1 })).toBe(true)
		expect(await callAs(1)).toMatchObject({ ok: true })
		expect(await fence.enter({ turn: 2 })).toBe(true)
		expect(await callAs(1)).toMatchObject({ ok: false, reason: "failed" })
		expect(await callAs(2)).toMatchObject({ ok: true })
		expect(sent).toEqual([1, 2])
	})
})

describe("bounding structured results", () => {
	it("drops structured content over its bound and says why", () => {
		expect(boundStructured({ sum: 5 })).toEqual({ value: { sum: 5 } })
		const big = boundStructured({ rows: "x".repeat(300_000) })
		expect(big.value).toBeUndefined()
		expect(big.dropped).toContain("left out")
	})
})
