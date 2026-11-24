import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import type { ApiServerBinding } from "@checkfu/domain/Mcp/ApiServers"
import type { ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { compile } from "@earendil-works/pi-schema"
import { describe, expect, it } from "vitest"
import type { McpToolDescriptor } from "../src/Connection/McpUpstream.ts"
import {
	apiExtension,
	apiResultSchema,
	apiToolName,
	apiToolPermissions,
	fencedApiCall,
} from "../src/Pi/PiApi.ts"
import type { ApiToolOutcome } from "../src/Pi/PiApi.ts"
import { PiMcpStore } from "../src/Pi/PiMcpStore.ts"
import type { SqlExecutor } from "../src/Pi/PiMcpStore.ts"
import { MODEL_TEXT_LIMITS } from "../src/Pi/PiToolText.ts"

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

const SHOP: ApiServerBinding = {
	name: "shop",
	base_url: "https://api.shop.example/v1",
	catalog_id: "aver_1/shop",
	credential_id: "vcrd_1",
}

const PET = {
	type: "object",
	properties: { id: { $ref: "#/$defs/Id" }, name: { type: "string" } },
	required: ["id"],
	$defs: { Id: { type: "string" } },
}

const getPet: McpToolDescriptor = {
	name: "getPet",
	description: "Look a pet up.",
	inputSchema: { type: "object" },
	outputSchema: PET,
	readOnly: true,
}
const createPet: McpToolDescriptor = {
	name: "createPet",
	description: "Add a pet.",
	inputSchema: { type: "object" },
}

const answer = (status: number, body: string, truncated = false): ApiToolOutcome => ({
	ok: true,
	status,
	contentType: "application/json",
	body,
	truncated,
})

const run = async (
	tool: McpToolDescriptor,
	outcome: ApiToolOutcome | Error,
	context: { readonly abortSignal?: AbortSignal } = {},
) => {
	const seen: Array<unknown> = []
	const extension = apiExtension(
		{ binding: SHOP, tools: [tool] },
		{
			call: (_binding, operation, args) => {
				seen.push(["call", operation, args])
				return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
			},
			began: (call) => seen.push(["began", call]),
			ended: (callId, result) => seen.push(["ended", callId, result]),
		},
	)
	const [registered] = extension.tools ?? []
	const execute = registered?.execute as unknown as (
		args: { readonly path: { readonly petId: string } },
		api: { readonly callId: string },
		context: { readonly abortSignal?: AbortSignal },
	) => Promise<{
		readonly output: ReadonlyArray<{ readonly text: string }>
		readonly isError: boolean
		readonly structuredOutput?: unknown
	}>
	return {
		seen,
		registered,
		result: await execute({ path: { petId: "7" } }, { callId: "call-9" }, context),
	}
}

describe("whether an API operation asks a person first", () => {
	it("lets an operation that only reads run, and asks for every other, unless the agent says", () => {
		const permissions = (binding: ApiServerBinding) =>
			Object.fromEntries(
				[...apiToolPermissions([{ binding, tools: [getPet, createPet] }])].map(([name, tool]) => [
					name,
					tool.ask,
				]),
			)
		expect(permissions(SHOP)).toEqual({ api__shop__getPet: false, api__shop__createPet: true })
		expect(permissions({ ...SHOP, permissions: { default: "always_allow" } })).toEqual({
			api__shop__getPet: false,
			api__shop__createPet: false,
		})
		expect(
			permissions({
				...SHOP,
				permissions: { tools: [{ name: "getPet", permission_policy: "always_ask" }] },
			}),
		).toEqual({ api__shop__getPet: true, api__shop__createPet: true })
	})

	it("marks each gated tool as an API operation of its server", () => {
		expect(
			apiToolPermissions([{ binding: SHOP, tools: [createPet] }]).get("api__shop__createPet"),
		).toEqual({ source: "api", server: "shop", tool: "createPet", ask: true })
		expect(apiToolPermissions([{ binding: SHOP, tools: null }]).size).toBe(0)
	})
})

describe("an API server's operations as a Pi extension", () => {
	it("names each operation for its server, defers it, and keeps a long name for scripts", () => {
		expect(apiToolName("shop", "getPet")).toBe("api__shop__getPet")
		const long = "o".repeat(60)
		const extension = apiExtension(
			{ binding: SHOP, tools: [getPet, { ...createPet, name: long }] },
			{
				call: () => Promise.reject(new Error("unused")),
				began: () => undefined,
				ended: () => undefined,
			},
		)
		expect(extension.namespace).toEqual({
			name: "shop",
			description: "HTTP API at api.shop.example.",
		})
		expect(extension.tools?.map((tool) => [tool.name, tool.deferred, tool.callers])).toEqual([
			["api__shop__getPet", true, undefined],
			[`api__shop__${long}`, true, ["tools"]],
		])
	})

	it("always describes a result a response can satisfy, typed when the document says how", () => {
		const typed = compile(apiResultSchema(PET))
		expect(typed.check({ status: 200, body: { id: "7", name: "Rex" } })).toBe(true)
		expect(typed.check({ status: 200, body: { name: "no id" } })).toBe(false)
		expect(typed.check({ status: 200, text: "<html>" })).toBe(true)
		expect(typed.check({ body: { id: "7" } })).toBe(false)

		const open = compile(apiResultSchema(undefined))
		expect(open.check({ status: 204 })).toBe(true)
		expect(open.check({ status: 200, body: [1, 2] })).toBe(true)
		// A schema Pi cannot compile describes nothing rather than refusing every answer.
		expect(apiResultSchema({ $ref: "#/$defs/Missing" })).toEqual(apiResultSchema(undefined))
	})

	it("hands back the parsed body when it is what the document promised, and records the call", async () => {
		const { seen, result } = await run(getPet, answer(200, '{"id":"7","name":"Rex"}'))
		expect(result).toEqual({
			output: [{ type: "text", text: '{"id":"7","name":"Rex"}' }],
			isError: false,
			structuredOutput: { status: 200, body: { id: "7", name: "Rex" } },
		})
		expect(seen).toEqual([
			[
				"began",
				{
					call_id: "call-9",
					source: "api",
					server: "shop",
					tool: "getPet",
					input: { path: { petId: "7" } },
					permission: "allow",
				},
			],
			["call", "getPet", { path: { petId: "7" } }],
			[
				"ended",
				"call-9",
				{ content: [{ type: "text", text: '{"id":"7","name":"Rex"}' }], is_error: false },
			],
		])
	})

	it("still answers when the API does not keep to its document", async () => {
		const wrongShape = await run(getPet, answer(200, '{"name":"no id"}'))
		expect(wrongShape.result).toMatchObject({
			isError: false,
			structuredOutput: { status: 200, text: '{"name":"no id"}' },
		})
		const notJson = await run(getPet, answer(200, "<html>"))
		expect(notJson.result.structuredOutput).toEqual({ status: 200, text: "<html>" })
		const empty = await run(createPet, answer(204, ""))
		expect(empty.result).toEqual({
			output: [{ type: "text", text: "HTTP 204 with no body" }],
			isError: false,
			structuredOutput: { status: 204 },
		})
	})

	it("reports a refusal with its status, and a cut response as cut", async () => {
		const refused = await run(createPet, answer(404, '{"error":"not found"}'))
		expect(refused.result).toEqual({
			output: [{ type: "text", text: 'HTTP 404\n{"error":"not found"}' }],
			isError: true,
			structuredOutput: { status: 404, body: { error: "not found" } },
		})
		// A JSON body cut when it was read is never shown cut: the model is told to ask for less.
		const cut = await run(createPet, answer(200, '{"half":', true))
		expect(cut.result.output[0]?.text).toMatch(/^HTTP 200\n\[The response is more than/u)
		expect(cut.result.output[0]?.text).not.toContain('{"half":')
		expect(cut.result.structuredOutput).toMatchObject({ status: 200 })
		expect(cut.result.structuredOutput).not.toHaveProperty("body")
		const cutText = await run(createPet, {
			ok: true,
			status: 200,
			contentType: "text/plain",
			body: "first line\nsecond li",
			truncated: true,
		})
		expect(cutText.result.output[0]?.text).toContain("has been cut.]")
	})

	it("gives the model a note instead of an oversize JSON body cut part way", async () => {
		const pets = Array.from({ length: 4000 }, (_, id) => ({ id, name: `pet ${id}` }))
		const body = JSON.stringify(pets)
		const { registered, seen, result } = await run(getPet, answer(200, body))
		expect(registered?.outputLimits).toEqual(MODEL_TEXT_LIMITS)
		expect(result.output).toHaveLength(1)
		const text = result.output[0]?.text ?? ""
		expect(text.startsWith("HTTP 200\n[The response is")).toBe(true)
		expect(text).toContain("Narrow the request")
		expect(text).not.toContain('"name"')
		expect(Buffer.byteLength(text)).toBeLessThan(MODEL_TEXT_LIMITS.maxBytes)
		expect(result.isError).toBe(false)
		// Scripts still get the parsed body, which is bounded by what is read of a response.
		expect(result.structuredOutput).toMatchObject({ status: 200 })
		expect(JSON.stringify(seen.at(-1))).toContain("Narrow the request")
	})

	it("turns a call that never reached the API into a tool error", async () => {
		const refused = await run(getPet, {
			ok: false,
			message: 'The path parameter "petId" is required.',
		})
		expect(refused.result).toEqual({
			output: [{ type: "text", text: 'The path parameter "petId" is required.' }],
			isError: true,
		})
		const unreachable = await run(getPet, new Error("rpc failed with key_secret"))
		expect(unreachable.result.isError).toBe(true)
		expect(JSON.stringify([unreachable.result, unreachable.seen])).not.toContain("key_secret")
	})

	it("sends nothing once the turn was interrupted", async () => {
		const aborted = new AbortController()
		aborted.abort()
		const { seen, result } = await run(getPet, new Error("not reached"), {
			abortSignal: aborted.signal,
		})
		expect(seen).toEqual([])
		expect(result).toEqual({
			output: [{ type: "text", text: "The turn was interrupted before this call ran." }],
			isError: true,
		})
	})

	it("answers a superseded turn's call without sending it", async () => {
		const sent: Array<string> = []
		const call = fencedApiCall(
			() => Promise.resolve(sent.length === 0),
			(_binding, operation) => {
				sent.push(operation)
				return Promise.resolve(answer(200, "{}"))
			},
		)
		expect(await call(SHOP, "getPet", {})).toMatchObject({ ok: true })
		expect(await call(SHOP, "createPet", {})).toMatchObject({ ok: false })
		expect(sent).toEqual(["getPet"])
	})
})

describe("the session's store, for API servers", () => {
	const use = (id: string, name: string): ToolEvent => ({
		type: "tool_use",
		tool_use_id: id,
		name,
		input: {},
	})
	const result = (id: string): ToolEvent => ({
		type: "tool_result",
		tool_use_id: id,
		content: [{ type: "text", text: "done" }],
		is_error: false,
	})

	it("remembers the bound API servers and each one's tools", () => {
		const store = new PiMcpStore(executor(new DatabaseSync(":memory:")))
		expect(store.bindApi([SHOP])).toBe(true)
		expect(store.bindApi([SHOP])).toBe(false)
		expect(store.apiServers()).toEqual([{ binding: SHOP, tools: null }])
		store.listedApi("shop", [getPet])
		expect(store.apiServers()).toEqual([{ binding: SHOP, tools: [getPet] }])
		expect(store.servers()).toEqual([])
	})

	it("names a direct call and a script's call to an API as API calls, beside MCP calls", () => {
		const store = new PiMcpStore(executor(new DatabaseSync(":memory:")))
		store.began({
			call_id: "c1",
			source: "api",
			server: "shop",
			tool: "createPet",
			input: {},
			permission: "ask",
		})
		store.began({
			call_id: "s1/c1",
			source: "api",
			server: "shop",
			tool: "getPet",
			input: { path: { petId: "7" } },
			permission: "allow",
		})
		store.ended("s1/c1", { content: [{ type: "text", text: "Rex" }], is_error: false })
		store.began({
			call_id: "s1/c2",
			server: "tracker",
			tool: "echo",
			input: {},
			permission: "allow",
		})
		store.ended("s1/c2", { content: [{ type: "text", text: "echo" }], is_error: false })

		// The events in the order the turn's reader takes them from the store.
		const served = store.served()
		const events = [
			use("c1", "api__shop__createPet"),
			result("c1"),
			use("s1", "codemode"),
			result("s1"),
		].flatMap((event) => {
			const named = served.named(event)
			const kept = named === undefined ? [] : [named]
			return event.type === "tool_use" ? [...kept, ...served.nested(event.tool_use_id)] : kept
		})
		expect(events.map((event) => [event.type, event.tool_use_id])).toEqual([
			["api_tool_use", "c1"],
			["api_tool_result", "c1"],
			["tool_use", "s1"],
			["api_tool_use", "s1/c1"],
			["api_tool_result", "s1/c1"],
			["mcp_tool_use", "s1/c2"],
			["mcp_tool_result", "s1/c2"],
			["tool_result", "s1"],
		])
		expect(events[0]).toMatchObject({
			api_server_name: "shop",
			name: "createPet",
			evaluated_permission: "ask",
		})
		expect(events[3]).toMatchObject({
			api_server_name: "shop",
			name: "getPet",
			parent_tool_use_id: "s1",
			input: { path: { petId: "7" } },
		})
	})
})
