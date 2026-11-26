import {
	MAX_AGENT_BODY_BYTES,
	MAX_EVENTS_BODY_BYTES,
	MAX_REQUEST_BODY_BYTES,
} from "@checkfu/api/Http/HttpHelpers"
import { ClientEventId } from "@checkfu/api/Http/Api"
import { ArtifactVersionFromString } from "@checkfu/sdk/Api"
import {
	ArtifactContentType,
	ArtifactPath,
	MAX_ARTIFACT_BODY_BYTES,
	MAX_ARTIFACT_CONTENT_TYPE_LENGTH,
	MAX_INLINE_FILE_BYTES,
	MAX_ARTIFACT_PATH_LENGTH,
	MAX_INLINE_TOTAL_BYTES,
} from "@checkfu/sdk/Schemas"
import { MAX_AGENT_SYSTEM_LENGTH } from "@checkfu/domain/Agent/AgentTypes"
import { describe, expect, it } from "@effect/vitest"
import type * as McpClient from "effect/ai/McpClient"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { GENERATED_TOOLS } from "../src/generated/Tools.ts"
import {
	PATH_SEGMENT_PATTERN,
	importInputSchema,
	makeToolHandler,
} from "../src/GeneratedRuntime.ts"
import { CREDENTIAL_CHECK_PATH, MAX_MCP_BODY_BYTES } from "../src/Server.ts"
import { MCP_ORIGIN, MCP_URL, TEST_API_KEY, makeTestServer } from "./helpers/McpHarness.ts"

type ToolArguments = NonNullable<Parameters<McpClient.McpClient["callTool"]>[0]["arguments"]>

type Argument =
	| string
	| number
	| boolean
	| ReadonlyArray<Argument>
	| { readonly [key: string]: Argument }

const CLIENT_META = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientInfo": { name: "checkfu-mcp-test", version: "0.0.0" },
	"io.modelcontextprotocol/clientCapabilities": {},
}

const LIST_TOOLS = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "tools/list",
	params: { _meta: CLIENT_META },
})

const callToolRequest = (name: string, args: Argument, headers: Record<string, string>) =>
	new Request(MCP_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": "tools/call",
			"mcp-name": name,
			...headers,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args, _meta: CLIENT_META },
		}),
	})

const listToolsRequest = (path: string, headers: Record<string, string> = {}, body = LIST_TOOLS) =>
	new Request(`${MCP_ORIGIN}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": "tools/list",
			...headers,
		},
		body,
	})

const isList = (value: Argument): value is ReadonlyArray<Argument> => Array.isArray(value)

const withUnknownField = (value: Argument): Array<Argument> => {
	if (isList(value)) {
		return value.flatMap((item, index) =>
			withUnknownField(item).map((changed) => value.with(index, changed)),
		)
	}
	if (typeof value !== "object") {
		return []
	}
	return [
		{ ...value, unknown_field: true },
		...Object.entries(value).flatMap(([key, child]) =>
			withUnknownField(child).map((changed) => ({ ...value, [key]: changed })),
		),
	]
}

const Structured = Schema.Record(Schema.String, Schema.Unknown)

const ErrorEnvelope = Schema.fromJsonString(
	Schema.Struct({
		type: Schema.Literal("error"),
		error: Schema.Struct({ type: Schema.String, message: Schema.String }),
		request_id: Schema.optionalKey(Schema.String),
	}),
)

const isCredentialCheck = (input: RequestInfo | URL) =>
	new URL(typeof input === "string" ? input : "href" in input ? input.href : input.url).pathname ===
	CREDENTIAL_CHECK_PATH

const afterCredentialCheck = (reply: () => Promise<Response>) => ({
	fetch: ((input) =>
		isCredentialCheck(input)
			? Promise.resolve(Response.json({ type: "authentication_verified" }))
			: reply()) satisfies typeof globalThis.fetch,
})

const callTool = (client: McpClient.McpClient, name: string, args: ToolArguments) =>
	Effect.gen(function* () {
		const tools = yield* client.listTools()
		const tool = tools.find((candidate) => candidate.name === name)
		if (tool === undefined) {
			return yield* Effect.die(new Error(`Unknown tool ${name}`))
		}
		return yield* client.callTool({ tool, arguments: args })
	})

const callOk = (client: McpClient.McpClient, name: string, args: ToolArguments) =>
	Effect.gen(function* () {
		const result = yield* callTool(client, name, args)
		expect(result.isError).toBe(false)
		return yield* Schema.decodeUnknownEffect(Structured)(result.structuredContent)
	})

const callError = (client: McpClient.McpClient, name: string, args: ToolArguments) =>
	Effect.gen(function* () {
		const result = yield* callTool(client, name, args)
		expect(result.isError).toBe(true)
		expect(result.structuredContent).toBeUndefined()
		const [block] = result.content
		return yield* Schema.decodeUnknownEffect(ErrorEnvelope)(
			block?.type === "text" ? block.text : undefined,
		)
	})

describe("Checkfu MCP server", () => {
	it.live("lists one tool per exposed API operation under the established names", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const client = yield* server.connect()
			expect(client.serverInfo?.name).toBe("checkfu")

			const tools = yield* client.listTools()
			expect(tools.map((tool) => tool.name)).toEqual([
				"agents_archiveAgent",
				"agents_createAgent",
				"agents_getAgent",
				"agents_listAgents",
				"agents_listVersions",
				"agents_updateAgent",
				"artifacts_createArtifact",
				"artifacts_createArtifactLink",
				"artifacts_createArtifactVersion",
				"artifacts_deleteArtifact",
				"artifacts_getArtifact",
				"artifacts_getArtifactFile",
				"artifacts_getArtifactVersion",
				"artifacts_listArtifacts",
				"artifacts_publishArtifact",
				"artifacts_unpublishArtifact",
				"automations_archiveAutomation",
				"automations_createAutomation",
				"automations_getAutomation",
				"automations_getRun",
				"automations_listAutomations",
				"automations_listRuns",
				"automations_pauseAutomation",
				"automations_runAutomation",
				"automations_unpauseAutomation",
				"automations_updateAutomation",
				"environments_archiveEnvironment",
				"environments_createEnvironment",
				"environments_deleteEnvironment",
				"environments_getEnvironment",
				"environments_listEnvironments",
				"environments_updateEnvironment",
				"sessions_archiveSession",
				"sessions_createSession",
				"sessions_getOutputs",
				"sessions_getResource",
				"sessions_getSession",
				"sessions_listEvents",
				"sessions_listResources",
				"sessions_listSessions",
				"sessions_sendSessionEvents",
				"vaults_archiveCredential",
				"vaults_archiveVault",
				"vaults_createVault",
				"vaults_deleteCredential",
				"vaults_deleteVault",
				"vaults_getCredential",
				"vaults_getVault",
				"vaults_listCredentials",
				"vaults_listVaults",
				"vaults_updateVault",
			])
			expect(tools.map((tool) => tool.inputSchema)).toEqual(
				GENERATED_TOOLS.map((tool) => tool.inputSchema),
			)

			const hints = Object.fromEntries(
				tools.map((tool) => [
					tool.name,
					[
						tool.annotations?.readOnlyHint ? "read-only" : "writes",
						tool.annotations?.destructiveHint ? "destructive" : "additive",
						tool.annotations?.idempotentHint ? "repeatable" : "not repeatable",
					].join(", "),
				]),
			)
			expect(hints).toEqual({
				agents_archiveAgent: "writes, destructive, repeatable",
				agents_createAgent: "writes, additive, not repeatable",
				agents_getAgent: "read-only, additive, repeatable",
				agents_listAgents: "read-only, additive, repeatable",
				agents_listVersions: "read-only, additive, repeatable",
				agents_updateAgent: "writes, destructive, not repeatable",
				artifacts_createArtifact: "writes, additive, not repeatable",
				artifacts_createArtifactLink: "writes, additive, not repeatable",
				artifacts_createArtifactVersion: "writes, additive, not repeatable",
				artifacts_deleteArtifact: "writes, destructive, repeatable",
				artifacts_getArtifact: "read-only, additive, repeatable",
				artifacts_getArtifactFile: "read-only, additive, repeatable",
				artifacts_getArtifactVersion: "read-only, additive, repeatable",
				artifacts_listArtifacts: "read-only, additive, repeatable",
				artifacts_publishArtifact: "writes, destructive, not repeatable",
				artifacts_unpublishArtifact: "writes, destructive, not repeatable",
				automations_archiveAutomation: "writes, destructive, repeatable",
				automations_createAutomation: "writes, additive, repeatable",
				automations_getAutomation: "read-only, additive, repeatable",
				automations_getRun: "read-only, additive, repeatable",
				automations_listAutomations: "read-only, additive, repeatable",
				automations_listRuns: "read-only, additive, repeatable",
				automations_pauseAutomation: "writes, destructive, not repeatable",
				automations_runAutomation: "writes, destructive, not repeatable",
				automations_unpauseAutomation: "writes, destructive, not repeatable",
				automations_updateAutomation: "writes, destructive, not repeatable",
				environments_archiveEnvironment: "writes, destructive, repeatable",
				environments_createEnvironment: "writes, additive, not repeatable",
				environments_deleteEnvironment: "writes, destructive, repeatable",
				environments_getEnvironment: "read-only, additive, repeatable",
				environments_listEnvironments: "read-only, additive, repeatable",
				environments_updateEnvironment: "writes, destructive, not repeatable",
				sessions_archiveSession: "writes, destructive, repeatable",
				sessions_createSession: "writes, additive, not repeatable",
				sessions_getOutputs: "read-only, additive, repeatable",
				sessions_getResource: "read-only, additive, repeatable",
				sessions_getSession: "read-only, additive, repeatable",
				sessions_listEvents: "read-only, additive, repeatable",
				sessions_listSessions: "read-only, additive, repeatable",
				sessions_listResources: "read-only, additive, repeatable",
				sessions_sendSessionEvents: "writes, destructive, not repeatable",
				vaults_archiveCredential: "writes, destructive, repeatable",
				vaults_archiveVault: "writes, destructive, repeatable",
				vaults_createVault: "writes, additive, not repeatable",
				vaults_deleteCredential: "writes, destructive, repeatable",
				vaults_deleteVault: "writes, destructive, repeatable",
				vaults_getCredential: "read-only, additive, repeatable",
				vaults_getVault: "read-only, additive, repeatable",
				vaults_listCredentials: "read-only, additive, repeatable",
				vaults_listVaults: "read-only, additive, repeatable",
				vaults_updateVault: "writes, destructive, not repeatable",
			})
		}).pipe(Effect.scoped),
	)

	it("offers no tool that takes a credential's secret", () => {
		const names = GENERATED_TOOLS.map((tool) => tool.name)
		expect(names).not.toContain("vaults_createCredential")
		expect(names).not.toContain("vaults_updateCredential")
		expect(
			GENERATED_TOOLS.filter((tool) => JSON.stringify(tool.inputSchema).includes('"token"')),
		).toEqual([])
	})

	it.live("runs a conversation end to end through tools", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const client = yield* server.connect()

			const agentInput = {
				body: { name: "Assistant", model: "gpt-6.2-sol" },
				idempotency_key: "create-agent-1",
			}
			const agent = yield* callOk(client, "agents_createAgent", agentInput)
			const retried = yield* callOk(client, "agents_createAgent", agentInput)
			expect(retried["id"]).toBe(agent["id"])

			const environment = yield* callOk(client, "environments_createEnvironment", {
				body: { name: "default" },
			})
			const session = yield* callOk(client, "sessions_createSession", {
				body: { agent: agent["id"], environment_id: environment["id"] },
			})
			const path = { session_id: session["id"] }
			expect(yield* callOk(client, "sessions_getSession", { path })).toMatchObject({
				id: session["id"],
				agent: { id: agent["id"], version: 1 },
			})

			yield* callOk(client, "sessions_sendSessionEvents", {
				path,
				body: {
					events: [{ type: "user.message", content: [{ type: "text", text: "Hello Checkfu!" }] }],
				},
			})
			const events = yield* callOk(client, "sessions_listEvents", {
				path,
				query: { limit: "50", order: "asc" },
			}).pipe(
				Effect.filterOrFail(
					(page) => JSON.stringify(page["data"]).includes("Echo: Hello Checkfu!"),
					() => "agent reply not listed yet",
				),
				Effect.retry(Schedule.max([Schedule.spaced("20 millis"), Schedule.recurs(200)])),
			)
			expect(events["has_more"]).toBe(false)
		}).pipe(Effect.scoped),
	)

	it.live("returns API and argument errors as tool errors", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const client = yield* server.connect()

			const missing = yield* callError(client, "agents_getAgent", {
				path: { agent_id: "agent_missing" },
			})
			expect(missing.error.type).toBe("not_found_error")
			expect(missing.request_id).toMatch(/^req_/)

			const before = server.apiRequests.length
			for (const agent_id of ["..", "a/b", String.raw`a\b`]) {
				const refused = yield* callError(client, "agents_getAgent", { path: { agent_id } })
				expect([agent_id, refused.error.type]).toEqual([agent_id, "invalid_request_error"])
				expect(refused.error.message).toContain('["path"]["agent_id"]')
			}
			for (const run of ["0", "01", "1.5", "a/b"]) {
				const refused = yield* callError(client, "automations_getRun", {
					path: { automation_id: "auto_1", run },
				})
				expect([run, refused.error.type]).toEqual([run, "invalid_request_error"])
				expect(refused.error.message).toContain('["path"]["run"]')
			}
			const illFormed = yield* callError(client, "agents_getAgent", {
				path: { agent_id: "agent_\uD800" },
			})
			expect(illFormed.error).toEqual({
				type: "invalid_request_error",
				message: 'Expected well-formed Unicode\n  at ["path"]["agent_id"]',
			})
			const illFormedQuery = yield* callError(client, "sessions_listEvents", {
				path: { session_id: "sess_1" },
				query: { after: "\uD800" },
			})
			expect(illFormedQuery.error.message).toContain('["query"]["after"]')
			expect(server.apiRequests.length).toBe(before)
		}).pipe(Effect.scoped),
	)

	it.live("rejects arguments its published schema rejects instead of dropping them", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const client = yield* server.connect()
			const body = { name: "Assistant", model: "gpt-6.2-sol" }

			const session = { session_id: "sess_1" }
			const cases: ReadonlyArray<readonly [string, ToolArguments, string]> = [
				["agents_createAgent", { body, idempotencyKey: "retry-1" }, '["idempotencyKey"]'],
				["agents_createAgent", { body, path: { agent_id: "agent_1" } }, '["path"]'],
				["agents_createAgent", { body, path: {} }, '["path"]'],
				["agents_createAgent", { body, query: { limit: "5" } }, '["query"]'],
				["agents_createAgent", { body: { ...body, sytem: "Be brief." } }, '["body"]["sytem"]'],
				["agents_createAgent", { body: { ...body, name: "" } }, '["body"]["name"]'],
				["agents_createAgent", {}, '["body"]'],
				["agents_getAgent", {}, '["path"]'],
				["agents_getAgent", { path: { agent_id: "" } }, '["path"]["agent_id"]'],
				["agents_getAgent", { path: { agent_id: "a", other: "b" } }, '["path"]["other"]'],
				["agents_getAgent", { path: { agent_id: "a" }, body: {} }, '["body"]'],
				[
					"agents_getAgent",
					{ path: { agent_id: "a" }, query: { version: "0" } },
					'["query"]["version"]',
				],
				[
					"agents_archiveAgent",
					{ path: { agent_id: "a" }, idempotency_key: "k" },
					'["idempotency_key"]',
				],
				["sessions_listEvents", { path: session, query: { limt: "5" } }, '["query"]["limt"]'],
				["sessions_listEvents", { path: session, query: { limit: 50 } }, '["query"]["limit"]'],
				["sessions_listEvents", { path: session, query: { limit: "500" } }, '["query"]["limit"]'],
				["sessions_listEvents", { path: session, query: { order: "up" } }, '["query"]["order"]'],
			]
			for (const [name, args, location] of cases) {
				const refused = yield* callError(client, name, args)
				expect([name, args, refused.error.type]).toEqual([name, args, "invalid_request_error"])
				expect(refused.error.message).toContain(location)
			}
			expect(server.apiRequests.length).toBe(0)
		}).pipe(Effect.scoped),
	)

	it.live(
		"refuses an unknown field at every object of every tool's arguments",
		() =>
			Effect.gen(function* () {
				const server = yield* makeTestServer
				const client = yield* server.connect()

				const model = { id: "gpt-6.2-sol" }
				const config = { type: "cloud", networking: { type: "unrestricted" } }
				const agent = { path: { agent_id: "agent_1" } }
				const environment = { path: { environment_id: "env_1" } }
				const session = { path: { session_id: "sess_1" } }
				const automation = { path: { automation_id: "auto_1" } }
				const artifact = { path: { artifact_id: "art_1" } }
				const artifactVersion = { path: { artifact_id: "art_1", version: 1 } }
				const files = [{ path: "index.html", content: "<h1>Hello</h1>", encoding: "utf8" }]
				const vault = { path: { vault_id: "vault_1" } }
				const credential = { path: { vault_id: "vault_1", credential_id: "cred_1" } }
				const calls = {
					agents_archiveAgent: agent,
					agents_createAgent: { body: { name: "Assistant", model, system: "Be brief." } },
					agents_getAgent: agent,
					agents_listAgents: { query: { limit: "5", include_archived: "true" } },
					agents_listVersions: { ...agent, query: { limit: "2" } },
					agents_updateAgent: { ...agent, body: { version: 1, model } },
					artifacts_createArtifact: { body: { name: "Report", files } },
					artifacts_createArtifactLink: { ...artifactVersion, body: { expires_in: 600 } },
					artifacts_createArtifactVersion: { ...artifact, body: { version: 1, files } },
					artifacts_deleteArtifact: artifact,
					artifacts_getArtifact: artifact,
					artifacts_getArtifactFile: { ...artifactVersion, query: { file: "index.html" } },
					artifacts_getArtifactVersion: artifactVersion,
					artifacts_listArtifacts: { query: { limit: "5", order: "desc" } },
					artifacts_publishArtifact: { ...artifact, body: { version: 1 } },
					artifacts_unpublishArtifact: artifact,
					automations_archiveAutomation: automation,
					automations_createAutomation: {
						body: {
							name: "Morning report",
							agent: { type: "agent", id: "agent_1", version: 1 },
							environment_id: "env_1",
							initial_events: [
								{ type: "user.message", content: [{ type: "text", text: "Report." }] },
							],
							schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
						},
						idempotency_key: "create-morning-report",
					},
					automations_getAutomation: automation,
					automations_getRun: { path: { automation_id: "auto_1", run: 1 } },
					automations_listAutomations: { query: { limit: "5" } },
					automations_listRuns: { ...automation, query: { limit: "5" } },
					automations_pauseAutomation: automation,
					automations_runAutomation: automation,
					automations_unpauseAutomation: automation,
					automations_updateAutomation: { ...automation, body: { name: "Renamed" } },
					environments_archiveEnvironment: environment,
					environments_createEnvironment: { body: { name: "default", config } },
					environments_deleteEnvironment: environment,
					environments_getEnvironment: environment,
					environments_listEnvironments: { query: { order: "desc" } },
					environments_updateEnvironment: { ...environment, body: { version: 1, config } },
					sessions_archiveSession: session,
					sessions_createSession: {
						body: {
							agent: { type: "agent", id: "agent_1", version: 1 },
							environment_id: "env_1",
							resources: [
								{
									type: "github_repository",
									url: "https://github.com/acme/api",
									checkout: { type: "branch", name: "main" },
								},
							],
						},
					},
					sessions_getOutputs: session,
					sessions_getResource: { path: { session_id: "sess_1", resource_id: "sesrsc_1" } },
					sessions_getSession: session,
					sessions_listEvents: { ...session, query: { limit: "5" } },
					sessions_listResources: session,
					sessions_listSessions: { query: { agent_id: "agent_1", after: "3:sess_1" } },
					sessions_sendSessionEvents: {
						...session,
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "Hello" }] }],
						},
					},
					vaults_archiveCredential: credential,
					vaults_archiveVault: vault,
					vaults_createVault: { body: { display_name: "Team" } },
					vaults_deleteCredential: credential,
					vaults_deleteVault: vault,
					vaults_getCredential: credential,
					vaults_getVault: vault,
					vaults_listCredentials: vault,
					vaults_listVaults: { query: { limit: "5", include_archived: "true" } },
					vaults_updateVault: { ...vault, body: { display_name: "Team" } },
				} satisfies Record<string, Argument>
				expect(Object.keys(calls)).toEqual(GENERATED_TOOLS.map((tool) => tool.name))

				let refusals = 0
				for (const [name, valid] of Object.entries(calls)) {
					for (const changed of withUnknownField(valid)) {
						const refused = yield* callError(client, name, changed as ToolArguments)
						expect([name, changed, refused.error.type]).toEqual([
							name,
							changed,
							"invalid_request_error",
						])
						expect(refused.error.message).toContain("unknown_field")
						refusals += 1
					}
				}
				expect(refusals).toBeGreaterThan(40)
				expect(server.apiRequests.length).toBe(0)

				for (const [name, valid] of Object.entries(calls)) {
					const result = yield* callTool(client, name, valid)
					const [block] = result.content
					const refusal = result.isError
						? yield* Schema.decodeUnknownEffect(ErrorEnvelope)(
								block?.type === "text" ? block.text : undefined,
							)
						: undefined
					expect([name, refusal === undefined || refusal.request_id !== undefined]).toEqual([
						name,
						true,
					])
				}
				expect(server.apiRequests.length).toBe(Object.keys(calls).length)
			}).pipe(Effect.scoped),
		30_000,
	)

	const everyByte = Array.from({ length: 256 }, (_, code) => String.fromCodePoint(code))
	const published = (tool: (typeof GENERATED_TOOLS)[number], argument: string) =>
		Schema.Struct({
			properties: Schema.Struct({ [argument]: Schema.Record(Schema.String, Schema.Unknown) }),
		})
			.pipe(Schema.decodeUnknownOption)(tool.inputSchema)
			.pipe(Option.map((schema) => schema.properties[argument] ?? {}))

	it("accepts exactly the retry keys the API accepts that a header carries unchanged", () => {
		const apiAccepts = Schema.is(ClientEventId)
		const headerCarries = (key: string) => /^[\t\u0020-\u007E]*$/u.test(key)
		const keys = [
			"",
			"batch 42",
			"batch\t42",
			"k".repeat(128),
			"k".repeat(129),
			"snow\u2603",
			...everyByte.flatMap((character) => [
				character,
				`${character}k`,
				`k${character}k`,
				`k${character}`,
			]),
		]

		const keyed = GENERATED_TOOLS.flatMap((tool) =>
			Option.match(published(tool, "idempotency_key"), {
				onNone: () => [],
				onSome: (schema) => [[tool.name, schema] as const],
			}),
		)
		expect(keyed.map(([name]) => name)).toEqual([
			"agents_createAgent",
			"artifacts_createArtifact",
			"artifacts_publishArtifact",
			"artifacts_unpublishArtifact",
			"automations_createAutomation",
			"environments_createEnvironment",
			"sessions_createSession",
			"sessions_sendSessionEvents",
			"vaults_createVault",
		])
		for (const [name, schema] of keyed) {
			const accepts = Schema.is(
				importInputSchema({ type: "object", properties: { key: schema }, required: ["key"] }),
			)
			const disagreements = keys.filter(
				(key) => accepts({ key }) !== (apiAccepts(key) && headerCarries(key)),
			)
			expect([name, disagreements.map((key) => JSON.stringify(key))]).toEqual([name, []])
		}
	})

	it("publishes the path-segment rule in a form every validator can run", () => {
		const isSegment = (value: string) =>
			value.length > 0 &&
			value !== "." &&
			value !== ".." &&
			!value.includes("/") &&
			!value.includes("\\")
		const pattern = new RegExp(PATH_SEGMENT_PATTERN, "u")
		const values = [
			"",
			"...",
			".a.b",
			"a/b",
			"snow\u2603",
			...everyByte.flatMap((character) => [
				character,
				`${character}k`,
				`k${character}k`,
				`k${character}`,
				`.${character}`,
				`..${character}`,
				`${character}.`,
				`${character}..`,
			]),
		]
		expect(
			values.flatMap((value) =>
				pattern.test(value) === isSegment(value) ? [] : [JSON.stringify(value)],
			),
		).toEqual([])

		const pathParameters = GENERATED_TOOLS.flatMap((tool) =>
			Option.match(published(tool, "path"), {
				onNone: () => [],
				onSome: (schema) =>
					Object.values(
						Schema.decodeUnknownSync(
							Schema.Struct({
								properties: Schema.Record(
									Schema.String,
									Schema.Union([
										Schema.Struct({ type: Schema.Literal("string"), pattern: Schema.String }),
										Schema.Struct({ type: Schema.Literal("integer") }),
									]),
								),
							}),
						)(schema).properties,
					).flatMap((parameter) => (parameter.type === "string" ? [parameter] : [])),
			}),
		)
		expect(pathParameters.length).toBeGreaterThan(0)
		expect(new Set(pathParameters.map((parameter) => parameter.pattern))).toEqual(
			new Set([PATH_SEGMENT_PATTERN]),
		)
		expect(JSON.stringify(GENERATED_TOOLS)).not.toMatch(/\(\?<?[=!]/)
	})

	it("accepts exactly the artifact version numbers the API accepts, as integers", () => {
		const apiAccepts = (value: unknown) =>
			typeof value === "number" &&
			Option.isSome(Schema.decodeOption(ArtifactVersionFromString)(String(value)))
		const values = [1, 9, 10, 999_999_999, 0, -1, 1.5, 1_000_000_000, "1", "latest"]
		const tools = GENERATED_TOOLS.filter((tool) => tool.path.includes("{version}"))
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"artifacts_createArtifactLink",
			"artifacts_getArtifactFile",
			"artifacts_getArtifactVersion",
		])
		for (const tool of tools) {
			const accepts = Schema.is(importInputSchema(Option.getOrThrow(published(tool, "path"))))
			const disagreements = values.filter(
				(version) => accepts({ artifact_id: "art_1", version }) !== apiAccepts(version),
			)
			expect([tool.name, disagreements]).toEqual([tool.name, []])
		}
		expect([1, 999_999_999].every(apiAccepts)).toBe(true)
		expect([0, 1.5, 1_000_000_000, "1"].some(apiAccepts)).toBe(false)
	})

	it("publishes the artifact file path and content-type rules the API applies", () => {
		const emoji = String.fromCodePoint(0x1_f6_00)
		const rules = {
			path: {
				api: ArtifactPath,
				values: [
					"a.txt",
					"a/../b",
					"x".repeat(MAX_ARTIFACT_PATH_LENGTH),
					"x".repeat(MAX_ARTIFACT_PATH_LENGTH + 1),
					emoji.repeat(MAX_ARTIFACT_PATH_LENGTH),
					emoji.repeat(MAX_ARTIFACT_PATH_LENGTH + 1),
				],
			},
			content_type: {
				api: ArtifactContentType,
				values: [
					"plain",
					"ab",
					"a/b",
					"Text/HTML; charset=UTF-8",
					'video/mp4; codecs="avc1.42E01E"',
					"text/html\r\nx: y",
					`text/${String.fromCodePoint(0x1_7f)}tuff`,
					`text/${String.fromCodePoint(0x21_2a)}`,
					`x/${"a".repeat(MAX_ARTIFACT_CONTENT_TYPE_LENGTH - 2)}`,
					`x/${"a".repeat(MAX_ARTIFACT_CONTENT_TYPE_LENGTH - 1)}`,
				],
			},
		}
		const FileShape = Schema.Struct({
			properties: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
		})
		const FileItems = Schema.Struct({
			properties: Schema.Struct({
				body: Schema.Struct({
					properties: Schema.Struct({
						files: Schema.Struct({
							items: Schema.Union([FileShape, Schema.Struct({ anyOf: Schema.Array(FileShape) })]),
						}),
					}),
				}),
			}),
		})
		const uploads = GENERATED_TOOLS.flatMap((tool) =>
			Option.match(Schema.decodeUnknownOption(FileItems)(tool.inputSchema), {
				onNone: () => [],
				onSome: (schema) => {
					const items = schema.properties.body.properties.files.items
					return ("anyOf" in items ? items.anyOf : [items]).map(
						(shape) => [tool.name, shape.properties] as const,
					)
				},
			}),
		)
		expect(uploads.map(([name]) => name)).toEqual([
			"artifacts_createArtifact",
			"artifacts_createArtifactVersion",
			"artifacts_createArtifactVersion",
		])
		for (const [name, properties] of uploads) {
			expect(properties["path"]?.["maxLength"]).toBe(MAX_ARTIFACT_PATH_LENGTH)
			expect(properties["content_type"]?.["pattern"]).toEqual(expect.any(String))
			for (const [field, { api, values }] of Object.entries(rules)) {
				const accepts = Schema.is(
					importInputSchema({
						type: "object",
						properties: { value: properties[field] ?? {} },
						required: ["value"],
					}),
				)
				const apiAccepts = Schema.is(api)
				const disagreements = values.filter((value) => accepts({ value }) !== apiAccepts(value))
				expect([name, field, disagreements]).toEqual([name, field, []])
			}
		}
		expect(Schema.is(ArtifactPath)(emoji.repeat(MAX_ARTIFACT_PATH_LENGTH))).toBe(true)
		expect(Schema.is(ArtifactPath)(emoji.repeat(MAX_ARTIFACT_PATH_LENGTH + 1))).toBe(false)
	})

	it.live("delivers a retry key to the API unchanged and refuses the rest before any call", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const client = yield* server.connect()
			const body = { name: "Assistant", model: "gpt-6.2-sol" }

			for (const idempotency_key of [" padded", "padded ", "line\nbreak", "caf\u00E9", ""]) {
				const refused = yield* callError(client, "agents_createAgent", { body, idempotency_key })
				expect(refused.error.type).toBe("invalid_request_error")
				expect(refused.error.message).toContain('["idempotency_key"]')
			}
			expect(server.apiRequests.length).toBe(0)

			for (const idempotency_key of ["k", "retry:1/a~b", "batch 42", "batch\t42", "a  b c"]) {
				const created = yield* callOk(client, "agents_createAgent", { body, idempotency_key })
				expect(server.apiRequests.at(-1)?.headers.get("idempotency-key")).toBe(idempotency_key)
				const retried = yield* callOk(client, "agents_createAgent", { body, idempotency_key })
				expect([idempotency_key, retried["id"]]).toEqual([idempotency_key, created["id"]])
			}
		}).pipe(Effect.scoped),
	)

	it.live("forwards the caller's credential to the API and holds none of its own", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer

			const client = yield* server.connect()
			yield* callOk(client, "environments_createEnvironment", { body: { name: "default" } })
			expect(server.apiRequests.at(-1)?.headers.get("authorization")).toBe(`Bearer ${TEST_API_KEY}`)

			const operations = server.apiRequests.length
			const stale = { authorization: "Bearer ck_stale_key" }
			for (const request of [
				listToolsRequest("/mcp", stale),
				callToolRequest("environments_createEnvironment", { body: { name: "default" } }, stale),
			]) {
				const refused = yield* server.fetch(request)
				expect(refused.status).toBe(401)
				expect(refused.headers.get("www-authenticate")).toBe("Bearer")
				expect(yield* Effect.promise(() => refused.json())).toEqual({
					type: "error",
					error: { type: "authentication_error", message: "Invalid or missing API key." },
				})
			}
			expect(server.apiRequests.length).toBe(operations)

			const stranger = yield* Effect.flip(
				Effect.flatMap(server.connect({ apiKey: "ck_stale_key" }), (client) => client.listTools()),
			)
			expect(stranger.reason).toMatchObject({ _tag: "HttpError", status: 401 })

			const accepted = yield* server.fetch(
				callToolRequest(
					"environments_createEnvironment",
					{ body: { name: "default" } },
					{ "x-api-key": TEST_API_KEY },
				),
			)
			expect(accepted.status).toBe(200)
			expect(accepted.headers.get("www-authenticate")).toBeNull()

			const unconfigured = {
				type: "error",
				error: { type: "service_unavailable", message: "API authentication is not configured." },
			}
			const routeMissing = {
				type: "error",
				error: { type: "not_found_error", message: "Route GET /v1/auth/verify not found." },
			}
			const answers: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
				["unreachable", () => Promise.reject(new Error("unreachable"))],
				[
					"503 no key configured",
					() => Promise.resolve(Response.json(unconfigured, { status: 503 })),
				],
				["500", () => Promise.resolve(Response.json({}, { status: 500 }))],
				["429", () => Promise.resolve(Response.json({}, { status: 429 }))],
				[
					"404 from an API without the check",
					() => Promise.resolve(Response.json(routeMissing, { status: 404 })),
				],
				["200 that is not JSON", () => Promise.resolve(new Response("<html>"))],
				["200 that is not the API's", () => Promise.resolve(Response.json({}))],
				["200 with another type", () => Promise.resolve(Response.json({ type: "agent" }))],
			]
			for (const [label, answer] of answers) {
				const unverified = yield* server.fetch(
					listToolsRequest("/mcp", { authorization: `Bearer ${TEST_API_KEY}` }),
					{ fetch: answer },
				)
				expect([label, unverified.status]).toEqual([label, 503])
			}
		}).pipe(Effect.scoped),
	)

	it.live("requires a credential on every route but the health check", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer

			for (const path of ["/mcp", "/mcp/", "/MCP", "/%6dcp", "//mcp", "/mcp/?x=1"]) {
				const anonymous = yield* server.fetch(listToolsRequest(path))
				expect([path, anonymous.status]).toEqual([path, 401])
				expect(anonymous.headers.get("www-authenticate")).toBe("Bearer")

				expect(anonymous.headers.get("cache-control")).toBe("no-store")

				const admitted = yield* server.fetch(
					listToolsRequest(path, { authorization: `Bearer ${TEST_API_KEY}` }),
				)
				expect([path, admitted.status]).toEqual([path, 200])
				expect(admitted.headers.get("cache-control")).toBe("no-store")
			}
			for (const authorization of ["Bearer", "Bearer ", "bearer", " "]) {
				const empty = yield* server.fetch(listToolsRequest("/mcp", { authorization }))
				expect([authorization, empty.status]).toEqual([authorization, 401])
			}
			expect(server.apiRequests.length).toBe(0)

			for (const path of ["/health", "/health?probe=1"]) {
				const health = yield* server.fetch(new Request(`${MCP_ORIGIN}${path}`))
				expect([path, health.status]).toEqual([path, 200])
				expect(health.headers.get("cache-control")).toBeNull()
			}
			const posted = yield* server.fetch(
				new Request(`${MCP_ORIGIN}/health`, { method: "POST", body: "x".repeat(1024) }),
			)
			expect(posted.status).toBe(401)

			for (const path of ["//", "//health", "//x/health", "/health/"]) {
				const anonymous = yield* server.fetch(new Request(`${MCP_ORIGIN}${path}`))
				expect([path, anonymous.status]).toEqual([path, 401])
			}
			const emptySegment = yield* server.fetch(
				new Request(`${MCP_ORIGIN}//`, { headers: { "x-api-key": TEST_API_KEY } }),
			)
			expect(emptySegment.status).toBe(404)

			const unknown = yield* server.fetch(new Request(`${MCP_ORIGIN}/v1/agents`))
			expect(unknown.status).toBe(401)
			const unknownWithKey = yield* server.fetch(
				new Request(`${MCP_ORIGIN}/v1/agents`, { headers: { "x-api-key": TEST_API_KEY } }),
			)
			expect(unknownWithKey.status).toBe(404)
		}).pipe(Effect.scoped),
	)

	it.live("takes no repository token: a model would have to write it", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const client = yield* server.connect()
			const refused = yield* callError(client, "sessions_createSession", {
				body: {
					agent: { type: "agent", id: "agent_1", version: 1 },
					environment_id: "env_1",
					resources: [
						{
							type: "github_repository",
							url: "https://github.com/acme/api",
							authorization_token: "ghp_written_by_a_model",
						},
					],
				},
			})
			expect(refused.error.type).toBe("invalid_request_error")
			expect(refused.error.message).toContain("authorization_token")
			expect(server.apiRequests.length).toBe(0)
		}).pipe(Effect.scoped),
	)

	it.live("answers an invalid call with its first error, however many it contains", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const invalidBlocks = Array.from({ length: 50_000 }, () => 1)
			const request = callToolRequest(
				"sessions_sendSessionEvents",
				{
					path: { session_id: "sess_1" },
					body: { events: [{ type: "user.message", content: invalidBlocks }] },
				},
				{ authorization: `Bearer ${TEST_API_KEY}` },
			)
			const response = yield* server.fetch(request)
			const text = yield* Effect.promise(() => response.text())
			expect(text).toContain("invalid_request_error")
			expect(text).toContain("content")
			expect(text.length).toBeLessThan(2000)
			expect(server.apiRequests.length).toBe(0)
		}).pipe(Effect.scoped),
	)

	it.live("says a write's outcome is unknown when the API gives no usable reply", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const brokenBody = () =>
				new ReadableStream<Uint8Array>({
					start: (controller) => {
						controller.error(new Error("connection reset"))
					},
				})
			const replies: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
				["no connection", () => Promise.reject(new Error("unreachable"))],
				["body lost", () => Promise.resolve(new Response(brokenBody(), { status: 201 }))],
				["empty body", () => Promise.resolve(new Response("", { status: 201 }))],
				["not JSON", () => Promise.resolve(new Response("<html>", { status: 201 }))],
				["not an object", () => Promise.resolve(new Response("[1,2]", { status: 200 }))],
				["foreign error", () => Promise.resolve(new Response("{}", { status: 502 }))],
			]
			const authorization = `Bearer ${TEST_API_KEY}`
			for (const [label, reply] of replies) {
				const outcome = (request: Request) =>
					server.fetch(request, afterCredentialCheck(reply)).pipe(
						Effect.flatMap((response) => Effect.promise(() => response.text())),
						Effect.map((text) => [label, text.includes('"isError":true'), text] as const),
					)
				const write = yield* outcome(
					callToolRequest(
						"environments_createEnvironment",
						{ body: { name: "default" } },
						{ authorization },
					),
				)
				expect(write.slice(0, 2)).toEqual([label, true])
				expect(write[2]).toContain("whether this call took effect is unknown")
				expect(write[2]).not.toContain("idempotency_key")

				const read = yield* outcome(
					callToolRequest(
						"environments_getEnvironment",
						{ path: { environment_id: "env_1" } },
						{ authorization },
					),
				)
				expect(read.slice(0, 2)).toEqual([label, true])
				expect(read[2]).toContain("Retrying is safe")
			}
		}).pipe(Effect.scoped),
	)

	it.live("substitutes every declared path parameter, whatever its name", () =>
		Effect.gen(function* () {
			const urls: Array<string> = []
			const handler = makeToolHandler(
				HttpClient.make((request, url) => {
					urls.push(url.pathname)
					return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})))
				}).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://api.test"))),
				{
					name: "things_getPart",
					title: "Get a part",
					description: "Get a part",
					method: "GET",
					path: "/v1/things/{thing-id}/parts/{part.id}",
					readOnly: true,
					idempotent: true,
					destructive: false,
					inputSchema: {
						type: "object",
						properties: {
							path: {
								type: "object",
								properties: { "thing-id": { type: "string" }, "part.id": { type: "string" } },
								required: ["thing-id", "part.id"],
								additionalProperties: false,
							},
						},
						required: ["path"],
						additionalProperties: false,
					},
				},
			)
			yield* handler({ path: { "thing-id": "t 1", "part.id": "$&" } })
			expect(urls).toEqual(["/v1/things/t%201/parts/%24%26"])
		}),
	)

	it.live("sends each call to the API bound to its own request", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const reached: Array<string> = []
			const binding = (label: string) => ({
				fetch: ((input, init) => {
					reached.push(`${label} ${isCredentialCheck(input) ? "credential check" : "operation"}`)
					return server.apiFetch(input, init)
				}) satisfies typeof globalThis.fetch,
			})
			for (const label of ["first", "second"]) {
				const response = yield* server.fetch(
					callToolRequest(
						"environments_createEnvironment",
						{ body: { name: "default" } },
						{ authorization: `Bearer ${TEST_API_KEY}` },
					),
					binding(label),
				)
				expect(response.status).toBe(200)
			}
			expect(reached).toEqual([
				"first credential check",
				"first operation",
				"second credential check",
				"second operation",
			])
		}).pipe(Effect.scoped),
	)

	it.live("bounds the request body before parsing it", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const authorization = `Bearer ${TEST_API_KEY}`
			const oversized = JSON.stringify({ pad: "x".repeat(MAX_MCP_BODY_BYTES) })

			const declared = yield* server.fetch(
				listToolsRequest(
					"/mcp",
					{ authorization, "content-length": String(oversized.length) },
					oversized,
				),
			)
			expect(declared.status).toBe(413)

			const undeclared = yield* server.fetch(listToolsRequest("/mcp", { authorization }, oversized))
			expect(undeclared.status).toBe(413)
			expect(undeclared.headers.get("cache-control")).toBe("no-store")

			const atTheLimit = yield* server.fetch(
				listToolsRequest("/mcp", { authorization }, LIST_TOOLS.padEnd(MAX_MCP_BODY_BYTES, " ")),
			)
			expect(atTheLimit.status).toBe(200)
			expect(server.apiRequests.length).toBe(0)

			expect(MAX_MCP_BODY_BYTES).toBeGreaterThanOrEqual(
				Math.max(MAX_AGENT_BODY_BYTES, MAX_EVENTS_BODY_BYTES, MAX_REQUEST_BODY_BYTES) + 64 * 1024,
			)
			const client = yield* server.connect()
			const largest = yield* callOk(client, "agents_createAgent", {
				body: {
					name: "Assistant",
					model: "gpt-6.2-sol",
					system: "\u{1F600}".repeat(MAX_AGENT_SYSTEM_LENGTH / 2),
				},
			})
			expect(largest["type"]).toBe("agent")

			expect(MAX_MCP_BODY_BYTES).toBeGreaterThanOrEqual(MAX_ARTIFACT_BODY_BYTES + 64 * 1024)
			const escaped = `${String.fromCodePoint(0x5c)}u0436`.repeat(MAX_INLINE_FILE_BYTES / 2)
			const files = Array.from(
				{ length: MAX_INLINE_TOTAL_BYTES / MAX_INLINE_FILE_BYTES },
				(_, index) => `{"path":"f${index}.txt","content":"${escaped}"}`,
			)
			const upload = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"artifacts_createArtifact","arguments":{"body":{"name":"A","files":[${files.join(",")}]}},"_meta":${JSON.stringify(CLIENT_META)}}}`
			expect(upload.length).toBeGreaterThan(MAX_INLINE_TOTAL_BYTES * 2.9)
			const template = callToolRequest("artifacts_createArtifact", {}, { authorization })
			const uploaded = yield* server.fetch(
				new Request(template.url, { method: "POST", headers: template.headers, body: upload }),
			)
			expect(uploaded.status).toBe(200)
			const uploadedText = yield* Effect.promise(() => uploaded.text())
			expect(uploadedText).toContain(`"total_bytes":${MAX_INLINE_TOTAL_BYTES}`)
		}).pipe(Effect.scoped),
	)

	it.live("serves only the stateless protocol revision", () =>
		Effect.gen(function* () {
			const server = yield* makeTestServer
			const legacy = yield* Effect.result(server.connect({ protocol: McpProtocol.v2025_11_25 }))
			expect(legacy._tag).toBe("Failure")
		}).pipe(Effect.scoped),
	)
})
