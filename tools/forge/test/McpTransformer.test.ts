import { parse } from "@cloudflare/forge"
import type { Json } from "@cloudflare/forge"
import { describe, expect, it } from "@effect/vitest"
import { generateMcpFiles, projectMcpTools } from "../src/McpTransformer.ts"
import { exportDeterministicOpenApiJson } from "../src/OpenApiExport.ts"

type Operation = Record<string, Json>

const withOperation = (path: string, method: string, operation: Operation): string => {
	const spec = JSON.parse(exportDeterministicOpenApiJson()) as {
		paths: Record<string, Record<string, Json>>
	}
	spec.paths[path] = { ...spec.paths[path], [method]: operation }
	return JSON.stringify(spec)
}

const searchAgents = {
	operationId: "agents.search",
	summary: "Search agents",
	description: "Search agents",
	"x-forge-group-name": "agents",
	"x-forge-method-name": "search",
	parameters: [
		{
			name: "limit",
			in: "query",
			required: false,
			description: "Page size",
			schema: { type: "integer" },
		},
	],
	responses: {
		"200": {
			description: "Success",
			content: { "application/json": { schema: { type: "object" } } },
		},
	},
} satisfies Operation

const project = (openApiJson: string) => {
	using forge = parse(openApiJson)
	return projectMcpTools(forge, openApiJson)
}

describe("MCP tool projection", () => {
	it("projects every exposed operation of the Checkfu API into the established tool shape", () => {
		const tools = project(exportDeterministicOpenApiJson())
		const byName = new Map(tools.map((tool) => [tool.name, tool]))

		expect(tools.map((tool) => tool.name)).toEqual([...byName.keys()].toSorted())
		expect(tools.some((tool) => tool.path.endsWith("/events/stream"))).toBe(false)
		expect(tools.some((tool) => tool.path === "/health")).toBe(false)

		expect(byName.get("agents_createAgent")).toMatchObject({
			method: "POST",
			path: "/v1/agents",
			readOnly: false,
			destructive: false,
			inputSchema: { required: ["body"], additionalProperties: false },
		})
		expect(Object.keys(byName.get("agents_createAgent")?.inputSchema["properties"] ?? {})).toEqual([
			"body",
			"idempotency_key",
		])
		const listEvents = byName.get("sessions_listEvents")
		expect(listEvents).toMatchObject({
			method: "GET",
			path: "/v1/sessions/{session_id}/events",
			readOnly: true,
			inputSchema: {
				properties: {
					path: {
						properties: {
							session_id: {
								pattern: String.raw`^(?:[^/\\.][^/\\]*|\.[^/\\.][^/\\]*|\.\.[^/\\]+)$`,
							},
						},
						required: ["session_id"],
						additionalProperties: false,
					},
					query: { required: [], additionalProperties: false },
				},
				required: ["path"],
			},
		})
		expect(Object.keys(listEvents?.inputSchema["properties"] ?? {})).toEqual(["path", "query"])
		expect(byName.get("agents_createAgent")?.inputSchema).toMatchObject({
			properties: {
				idempotency_key: {
					type: "string",
					pattern: String.raw`^[!-~](?:[\t -~]*[!-~])?$`,
					minLength: 1,
					maxLength: 128,
				},
			},
		})

		// Repeating is safe for reads, for DELETE unless the API says otherwise, and for writes the
		// API declares idempotent. A write that is only safe with a retry key is not.
		expect(
			tools.filter((tool) => tool.idempotent && !tool.readOnly).map((tool) => tool.name),
		).toEqual([
			"agents_archiveAgent",
			"automations_archiveAutomation",
			"automations_createAutomation",
			"environments_archiveEnvironment",
			"environments_deleteEnvironment",
			"memoryStores_archiveMemoryStore",
			"memoryStores_deleteMemoryStore",
			"sessions_archiveSession",
		])
		expect(tools.filter((tool) => tool.readOnly && !tool.idempotent)).toEqual([])

		// Only an operation that declares itself additive may drop the destructive hint.
		expect(
			tools.filter((tool) => !tool.readOnly && !tool.destructive).map((tool) => tool.name),
		).toEqual([
			"agents_createAgent",
			"automations_createAutomation",
			"environments_createEnvironment",
			"memoryStores_createMemory",
			"memoryStores_createMemoryStore",
			"sessions_createSession",
		])
		expect(tools.filter((tool) => tool.readOnly && tool.destructive)).toEqual([])
	})

	it("refuses an operation that has not decided its MCP exposure", () => {
		expect(() => project(withOperation("/v1/agents", "get", searchAgents))).toThrow(
			/GET \/v1\/agents: declare "x-checkfu-mcp"/,
		)
	})

	it("exposes a named operation and leaves out one that opts out", () => {
		const exposed = project(
			withOperation("/v1/agents", "get", {
				...searchAgents,
				"x-checkfu-mcp": { name: "agents_searchAgents" },
			}),
		).find((tool) => tool.name === "agents_searchAgents")
		expect(exposed).toMatchObject({
			readOnly: true,
			inputSchema: {
				properties: {
					query: { properties: { limit: { type: "integer", description: "Page size" } } },
				},
				required: [],
			},
		})

		const hidden = project(
			withOperation("/v1/agents", "get", { ...searchAgents, "x-checkfu-mcp": false }),
		)
		expect(hidden.some((tool) => tool.path === "/v1/agents" && tool.method === "GET")).toBe(false)
	})

	it("refuses duplicate names, invalid names, and success responses that are not a JSON object", () => {
		expect(() =>
			project(
				withOperation("/v1/agents", "get", {
					...searchAgents,
					"x-checkfu-mcp": { name: "agents_getAgent" },
				}),
			),
		).toThrow(/Duplicate MCP tool name "agents_getAgent"/)

		expect(() =>
			project(
				withOperation("/v1/agents", "get", {
					...searchAgents,
					"x-checkfu-mcp": { name: "agents.list" },
				}),
			),
		).toThrow(/is not valid/)

		expect(() =>
			project(
				withOperation("/v1/agents", "get", {
					...searchAgents,
					"x-checkfu-mcp": { name: "agents_searchAgents" },
					responses: {
						"200": {
							description: "Success",
							content: { "text/event-stream": { schema: { type: "string" } } },
						},
					},
				}),
			),
		).toThrow(/MCP tools return a JSON object/)

		const successes: ReadonlyArray<Json> = [
			{ "204": { description: "No content" } },
			{
				"200": {
					description: "Success",
					content: {
						"application/json": { schema: { type: "array", items: { type: "object" } } },
					},
				},
			},
			{
				"200": {
					description: "Success",
					content: { "application/json": { schema: { type: "string" } } },
				},
			},
		]
		for (const responses of successes) {
			expect(() =>
				project(
					withOperation("/v1/agents", "get", {
						...searchAgents,
						"x-checkfu-mcp": { name: "agents_searchAgents" },
						responses,
					}),
				),
			).toThrow(/MCP tools return a JSON object/)
		}
	})

	it("refuses a parameter the runtime would not forward", () => {
		const exposed = { ...searchAgents, "x-checkfu-mcp": { name: "agents_searchAgents" } }
		const cases: ReadonlyArray<readonly [Json, RegExp]> = [
			[
				{ name: "x-tenant", in: "header", required: true, schema: { type: "string" } },
				/cannot send the header parameter "x-tenant"/,
			],
			[
				{ name: "x-trace", in: "header", required: false, schema: { type: "string" } },
				/cannot send the header parameter "x-trace"/,
			],
			[
				{ name: "session", in: "cookie", required: false, schema: { type: "string" } },
				/cannot send the cookie parameter "session"/,
			],
			[
				{
					name: "ids",
					in: "query",
					required: false,
					schema: { type: "array", items: { type: "string" } },
				},
				/cannot send the query parameter "ids"/,
			],
		]
		for (const [parameter, message] of cases) {
			expect(() =>
				project(withOperation("/v1/agents", "get", { ...exposed, parameters: [parameter] })),
			).toThrow(message)
		}

		expect(() =>
			project(
				withOperation("/v1/agents/{agent_id}", "get", {
					...exposed,
					parameters: [
						{
							name: "agent_id",
							in: "path",
							required: true,
							schema: { type: "string", pattern: "^agent_" },
						},
					],
				}),
			),
		).toThrow(/a path parameter with its own pattern is not supported/)

		const spec = JSON.parse(withOperation("/v1/agents", "get", exposed)) as {
			paths: Record<string, Record<string, Json>>
		}
		spec.paths["/v1/agents"] = { ...spec.paths["/v1/agents"], parameters: [] }
		expect(() => project(JSON.stringify(spec))).toThrow(
			/parameters declared on the path item are not supported/,
		)

		const retryable = project(
			withOperation("/v1/agents", "get", {
				...exposed,
				parameters: [
					{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } },
				],
			}),
		).find((tool) => tool.name === "agents_searchAgents")
		expect(Object.keys(retryable?.inputSchema["properties"] ?? {})).toEqual(["idempotency_key"])
		expect(retryable?.inputSchema["required"]).toEqual([])

		const mandatory = project(
			withOperation("/v1/agents", "get", {
				...exposed,
				parameters: [
					{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
				],
			}),
		).find((tool) => tool.name === "agents_searchAgents")
		expect(mandatory?.inputSchema["required"]).toEqual(["idempotency_key"])
	})

	it("refuses a request body on GET", () => {
		expect(() =>
			project(
				withOperation("/v1/agents", "get", {
					...searchAgents,
					"x-checkfu-mcp": { name: "agents_searchAgents" },
					requestBody: {
						required: true,
						content: { "application/json": { schema: { type: "object" } } },
					},
				}),
			),
		).toThrow(/GET \/v1\/agents: MCP tools cannot send a request body with GET/)
	})

	it("refuses an input schema the server could publish but not enforce", () => {
		expect(() =>
			project(
				withOperation("/v1/agents/search", "post", {
					...searchAgents,
					"x-checkfu-mcp": { name: "agents_searchAgents" },
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: {
									type: "object",
									if: { required: ["a"] },
									then: { required: ["b"] },
								},
							},
						},
					},
				}),
			),
		).toThrow(
			/POST \/v1\/agents\/search: the MCP server cannot enforce this operation's input schema/,
		)
	})

	it("inlines referenced component schemas as $defs", () => {
		const openApiJson = withOperation("/v1/agents/search", "post", {
			...searchAgents,
			"x-checkfu-mcp": { name: "agents_searchAgents" },
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: { $ref: "#/components/schemas/SessionEvent" } },
				},
			},
		})
		const tool = project(openApiJson).find((candidate) => candidate.name === "agents_searchAgents")
		expect(tool?.inputSchema).toMatchObject({
			properties: { body: { $ref: "#/$defs/SessionEvent" } },
			required: ["body"],
		})
		expect(JSON.stringify(tool?.inputSchema)).not.toContain("#/components/schemas/")
		expect(Object.keys((tool?.inputSchema["$defs"] ?? {}) as object)).toContain("SessionEvent")
	})

	it("emits one module that carries the API version and the tool manifest", () => {
		const openApiJson = exportDeterministicOpenApiJson()
		using forge = parse(openApiJson)
		const files = generateMcpFiles(forge, openApiJson)
		expect(files.map((file) => file.path)).toEqual(["Tools.ts"])
		expect(files[0]?.content).toContain(`GENERATED_API_VERSION = "${forge.version}"`)
		expect(files[0]?.content).toContain('"name": "sessions_sendSessionEvents"')
	})
})
