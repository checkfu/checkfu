import { CheckfuApi } from "../src/Api.ts"
import { CheckfuClient } from "../src/Effect.ts"
import { Checkfu, SDK_OPERATION_BINDINGS } from "../src/index.ts"

const assert = (condition, message) => {
	if (!condition) {
		throw new Error(`Node ESM smoke test failed: ${message}`)
	}
}

assert(typeof Checkfu === "function", "Checkfu constructor missing from packages/sdk/src/index.ts")
assert(
	typeof CheckfuClient === "function",
	"CheckfuClient service missing from packages/sdk/src/Effect.ts",
)
assert(CheckfuApi !== undefined, "CheckfuApi missing from packages/sdk/src/Api.ts")
assert(SDK_OPERATION_BINDINGS.length > 0, "SDK_OPERATION_BINDINGS must be non-empty")

const seenUrls = []
const client = new Checkfu({
	apiKey: "ck_node_esm_smoke",
	baseUrl: "https://gateway.example/tenant/v1/v1",
	fetch: async (input) => {
		const req = new Request(input)
		seenUrls.push(req.url)
		return new Response(
			JSON.stringify({
				id: "agent_node_smoke",
				type: "agent",
				version: 1,
				name: "Node Smoke",
				model: { id: "gpt-6.2-sol" },
				system: null,
				description: null,
				mcp_servers: [],
				tools: [],
				created_at: "2026-11-23T18:00:00.000Z",
				updated_at: "2026-11-23T18:00:00.000Z",
				archived_at: null,
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)
	},
})

try {
	assert(
		client.baseUrl === "https://gateway.example/tenant/v1",
		`expected single /v1 normalization, got ${client.baseUrl}`,
	)
	const agent = await client.agents.retrieve("agent_node_smoke")
	assert(agent.id === "agent_node_smoke", `unexpected agent id ${agent.id}`)
	assert(
		seenUrls.length === 1 &&
			seenUrls[0] === "https://gateway.example/tenant/v1/v1/agents/agent_node_smoke",
		`unexpected request URLs: ${JSON.stringify(seenUrls)}`,
	)
} finally {
	await client.close()
}
