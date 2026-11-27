import { AgentResource, ListAgentsResponse } from "@checkfu/sdk/Api"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { CallToolRequestParams } from "@modelcontextprotocol/client"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { MCP_URL, TEST_API_KEY, makeTestServer } from "./helpers/McpHarness.ts"

const connected = async (fetch: typeof globalThis.fetch) => {
	const client = new Client(
		{ name: "independent-sdk-user", version: "1.0.0" },
		{ versionNegotiation: { mode: "auto" } },
	)
	await client.connect(
		new StreamableHTTPClientTransport(new URL(MCP_URL), {
			requestInit: { headers: { authorization: `Bearer ${TEST_API_KEY}` } },
			fetch,
		}),
	)
	return client
}

const callOk = async (client: Client, params: CallToolRequestParams) => {
	const result = await client.callTool(params)
	expect(result.isError).not.toBe(true)
	return result.structuredContent
}

const exerciseRetry = async (fetch: typeof globalThis.fetch) => {
	let loseReply = false
	const interruptedFetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init)
		const reply = await fetch(request)
		if (loseReply && request.headers.get("mcp-name") === "agents_createAgent") {
			loseReply = false
			await reply.body?.cancel()
			throw new TypeError("Connection lost after the server committed the agent")
		}
		return reply
	}
	const first = await connected(interruptedFetch)
	const retry = await connected(fetch)
	try {
		expect(first.getProtocolEra()).toBe("modern")
		const { tools } = await first.listTools()
		expect(tools.some((tool) => tool.name === "agents_createAgent")).toBe(true)
		const create = {
			name: "agents_createAgent",
			arguments: {
				body: { name: "Recover my uncertain create", model: "gpt-6.2-sol" },
				idempotency_key: "uncertain-create-from-independent-client",
			},
		}
		loseReply = true
		await expect(first.callTool(create)).rejects.toThrow(
			"Connection lost after the server committed",
		)
		const recovered = Schema.decodeUnknownSync(Schema.toCodecJson(AgentResource))(
			await callOk(retry, create),
		)
		const agents = Schema.decodeUnknownSync(Schema.toCodecJson(ListAgentsResponse))(
			await callOk(retry, { name: "agents_listAgents", arguments: {} }),
		)
		expect(agents.data.map((agent) => agent.id)).toEqual([recovered.id])
		expect(recovered.version).toBe(1)
		const conflict = await retry.callTool({
			...create,
			arguments: {
				...create.arguments,
				body: { ...create.arguments.body, name: "Different intent" },
			},
		})
		expect(conflict.isError).toBe(true)
		expect(conflict.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("idempotency_key_reused"),
			}),
		])
		const unchanged = Schema.decodeUnknownSync(Schema.toCodecJson(AgentResource))(
			await callOk(retry, {
				name: "agents_getAgent",
				arguments: { path: { agent_id: recovered.id } },
			}),
		)
		expect(unchanged.name).toBe("Recover my uncertain create")
		expect(unchanged.version).toBe(1)
	} finally {
		await first.close()
		await retry.close()
	}
}

describe("independent MCP SDK interoperability", () => {
	it.live(
		"discovers the protocol and recovers an uncertain create without duplicating or changing it",
		() =>
			Effect.gen(function* () {
				const server = yield* makeTestServer
				yield* Effect.promise(() => exerciseRetry(server.fetchWeb))
			}).pipe(Effect.scoped),
		{ tags: ["acceptance", "mcp-uncertain-create"] },
	)
})
