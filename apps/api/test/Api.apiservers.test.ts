import { describe, expect, it } from "@effect/vitest"
import {
	MAX_API_SERVER_OPERATIONS,
	MAX_API_SPEC_JSON_BYTES,
	apiServerSetId,
} from "@checkfu/domain/Mcp/ApiServers"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import type * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import { idempotentId } from "../src/Http/HttpHelpers.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { makeVaultsTestLayer } from "./helpers/VaultsHarness.ts"

const SHOP = "https://api.shop.example/v1"

interface Fields {
	readonly [field: string]: Schema.Json
}

interface Answer {
	readonly status: number
	readonly body: Schema.JsonObject
}

type Call = (
	method: string,
	path: string,
	payload?: unknown,
	headers?: Record<string, string>,
) => Effect.Effect<Answer>

const world = () => {
	const vaults = makeVaultsTestLayer()
	const base = makePiDurableTestLayer(
		async (model) => makeAssistantReply(model, null, "ok", 1, 1),
		undefined,
		undefined,
		undefined,
		vaults.layer,
	)
	const run = async <A, E>(
		body: (call: Call) => Effect.Effect<A, E, Layer.Success<typeof base.layer>>,
	): Promise<A> => {
		try {
			return await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					return yield* body((method, path, payload, headers) =>
						Effect.gen(function* () {
							const res = yield* sendRequest(apiFetch, {
								method,
								path,
								headers: { ...AUTH_HEADERS, ...headers },
								...(payload === undefined ? {} : { body: payload }),
							})
							return {
								status: res.status,
								body: (yield* Effect.promise(() => res.json())) as Schema.JsonObject,
							}
						}),
					)
				}).pipe(Effect.scoped, Effect.provide(base.layer)),
			)
		} finally {
			await base.closeAll()
		}
	}
	return { run, vaults }
}

const operation = (operationId: string, tag: string) => ({
	operationId,
	summary: `MARKER ${operationId}`,
	tags: [tag],
	responses: { "200": { description: "ok" } },
})

const spec = (extra: Fields = {}): Fields => ({
	openapi: "3.0.3",
	info: { title: "Shop", version: "2" },
	paths: {
		"/pets": { get: operation("listPets", "pets"), post: operation("createPet", "pets") },
		"/orders": { get: operation("listOrders", "orders") },
	},
	...extra,
})

const shop = (extra: Fields = {}) => ({
	type: "openapi",
	name: "shop",
	base_url: SHOP,
	spec: spec(),
	...extra,
})

const agentBody = (extra: Fields) => ({ name: "Agent", model: "gpt-4o-mini", ...extra })

const created = (call: Call, path: string, payload: unknown) =>
	Effect.map(call("POST", path, payload), (answer) => {
		expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(300)
		return String(answer.body["id"])
	})

const apiKeyIn = (call: Call, baseUrl = SHOP, token = "key_secret") =>
	Effect.gen(function* () {
		const vault = yield* created(call, "/v1/vaults", { display_name: "vault" })
		const credential = yield* created(call, `/v1/vaults/${vault}/credentials`, {
			auth: {
				type: "api_key",
				base_url: baseUrl,
				token,
				placement: { in: "header", name: "X-Api-Key" },
			},
		})
		return { vault, credential }
	})

const environment = (call: Call, config?: Fields) =>
	created(call, "/v1/environments", { name: "Env", ...(config === undefined ? {} : { config }) })

const message = (answer: Answer): string => JSON.stringify(answer.body)

// A document is confirmed by a policy once the version's servers are recorded, not by the request.
const keptEventually = (vaults: ReturnType<typeof makeVaultsTestLayer>, catalogId: string) =>
	Effect.sync(() => vaults.catalogStatusOf(catalogId)).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("5 millis"),
			times: 400,
			until: (status) => status === "kept",
		}),
	)

describe("API servers on agents", () => {
	it("confirms a document after the request that stored it, even when the first try fails", async () => {
		const { run, vaults } = world()
		vaults.catalogKeepFailures.remaining = 1
		await run((call) =>
			Effect.gen(function* () {
				const made = yield* call("POST", "/v1/agents", agentBody({ api_servers: [shop()] }))
				expect(made.status, message(made)).toBe(201)
				const [catalogId] = vaults.catalogIds()
				expect(yield* keptEventually(vaults, catalogId ?? "")).toBe("kept")
				expect(vaults.catalogKeepFailures.remaining).toBe(0)
			}),
		)
	})

	it("stores a server's document once and answers with a summary of it", async () => {
		const { run, vaults } = world()
		await run((call) =>
			Effect.gen(function* () {
				const made = yield* call(
					"POST",
					"/v1/agents",
					agentBody({
						api_servers: [shop({ base_url: `${SHOP}/#docs`, exclude: { tags: ["orders"] } })],
						tools: [
							{
								type: "api_toolset",
								api_server_name: "shop",
								configs: [{ name: "createPet", permission_policy: { type: "always_allow" } }],
							},
						],
					}),
					{ "idempotency-key": "shop-agent" },
				)
				expect(made.status, message(made)).toBe(201)
				expect(made.body["api_servers"]).toEqual([
					{
						type: "openapi",
						name: "shop",
						base_url: SHOP,
						exclude: { tags: ["orders"] },
						spec: {
							title: "Shop",
							version: "2",
							operations: 2,
							digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
						},
					},
				])
				expect(made.body["tools"]).toEqual([
					{
						type: "api_toolset",
						api_server_name: "shop",
						configs: [{ name: "createPet", permission_policy: { type: "always_allow" } }],
					},
				])
				expect(message(made)).not.toContain("MARKER")

				const [catalogId] = vaults.catalogIds()
				expect(vaults.catalogIds()).toHaveLength(1)
				expect(vaults.catalogDocumentOf(catalogId ?? "")).toBe(JSON.stringify(spec()))
				expect(yield* keptEventually(vaults, catalogId ?? "")).toBe("kept")
				const tools = yield* Effect.promise(() => vaults.catalogOf(catalogId ?? "").tools())
				expect(tools.ok && tools.tools.map((tool) => tool.name)).toEqual(["listPets", "createPet"])

				// What the model records names the document; it never holds it.
				const versionId = yield* idempotentId(yield* Digest.Digest, "aver", [
					"create",
					"agent",
					"version",
					"shop-agent",
				])
				const recorded = yield* vaults.storedEvents("McpServerSet", apiServerSetId(versionId))
				expect(recorded).toHaveLength(1)
				expect(JSON.stringify(recorded)).toContain(catalogId)
				expect(JSON.stringify(recorded)).not.toContain("MARKER")

				const got = yield* call("GET", `/v1/agents/${String(made.body["id"])}`)
				expect(got.body["api_servers"]).toEqual(made.body["api_servers"])
			}),
		)
	})

	it("keeps a server's document across versions and replaces it only when sent again", async () => {
		const { run, vaults } = world()
		await run((call) =>
			Effect.gen(function* () {
				const id = yield* created(call, "/v1/agents", agentBody({ api_servers: [shop()] }))
				const [first] = vaults.catalogIds()

				const renamed = yield* call("POST", `/v1/agents/${id}`, { version: 1, name: "Renamed" })
				expect(renamed.body).toMatchObject({ version: 2, api_servers: [{ name: "shop" }] })
				expect(vaults.catalogIds()).toEqual([first])

				const policed = yield* call("POST", `/v1/agents/${id}`, {
					version: 2,
					tools: [
						{
							type: "api_toolset",
							api_server_name: "shop",
							default_config: { permission_policy: { type: "always_ask" } },
						},
					],
				})
				expect(policed.body).toMatchObject({
					version: 3,
					tools: [{ type: "api_toolset", api_server_name: "shop" }],
				})
				expect(vaults.catalogIds()).toEqual([first])

				const replaced = yield* call("POST", `/v1/agents/${id}`, {
					version: 3,
					api_servers: [shop({ spec: spec({ info: { title: "Shop", version: "3" } }) })],
				})
				expect(replaced.body).toMatchObject({
					version: 4,
					api_servers: [{ name: "shop", spec: { version: "3" } }],
					// A replaced server keeps the policy of the one it replaces.
					tools: [{ type: "api_toolset", api_server_name: "shop" }],
				})
				expect(vaults.catalogIds()).toHaveLength(2)

				const cleared = yield* call("POST", `/v1/agents/${id}`, { version: 4, api_servers: [] })
				expect(cleared.body).toMatchObject({ version: 5, api_servers: [], tools: [] })
			}),
		)
	})

	it("stores one document for every declaration of the same server", async () => {
		const { run, vaults } = world()
		await run((call) =>
			Effect.gen(function* () {
				yield* created(call, "/v1/agents", agentBody({ api_servers: [shop()] }))
				yield* created(call, "/v1/agents", agentBody({ api_servers: [shop()] }))
				expect(vaults.catalogIds()).toHaveLength(1)
				yield* created(
					call,
					"/v1/agents",
					agentBody({ api_servers: [shop({ base_url: `${SHOP}/v2` })] }),
				)
				expect(vaults.catalogIds()).toHaveLength(2)
			}),
		)
	})

	it("refuses a server it could not serve, and says why", async () => {
		const { run, vaults } = world()
		await run((call) =>
			Effect.gen(function* () {
				const refused = (extra: Fields) =>
					Effect.map(call("POST", "/v1/agents", agentBody(extra)), (answer) => {
						expect(answer.status, message(answer)).toBe(400)
						return message(answer)
					})
				const many = {
					openapi: "3.0.3",
					info: { title: "Many", version: "1" },
					paths: Object.fromEntries(
						Array.from({ length: MAX_API_SERVER_OPERATIONS + 1 }, (_unused, index) => [
							`/things/${index}`,
							{ get: operation(`getThing${index}`, "things") },
						]),
					),
				}

				expect(
					yield* refused({
						api_servers: [
							shop({ spec: spec({ "x-padding": "p".repeat(MAX_API_SPEC_JSON_BYTES) }) }),
						],
					}),
				).toContain(`larger than ${MAX_API_SPEC_JSON_BYTES} bytes`)
				expect(yield* refused({ api_servers: [shop({ spec: many })] })).toContain(
					`at most ${MAX_API_SERVER_OPERATIONS}`,
				)
				expect(
					yield* refused({
						api_servers: [
							shop({ spec: { swagger: "2.0", info: { title: "Old", version: "1" }, paths: {} } }),
						],
					}),
				).toContain(String.raw`The spec of API server \"shop\"`)
				expect(
					yield* refused({ api_servers: [shop({ include: { names: ["listPet"] } })] }),
				).toContain("include.names lists")
				expect(
					yield* refused({
						api_servers: [shop()],
						mcp_servers: [{ type: "url", name: "shop", url: "https://mcp.shop.example/mcp" }],
					}),
				).toContain("names both an API server and an MCP server")
				expect(yield* refused({ api_servers: [shop(), shop()] })).toContain(
					"is used more than once",
				)
				expect(yield* refused({ api_servers: [shop({ unexpected: true })] })).toContain(
					"unexpected",
				)
				expect(yield* refused({ api_servers: [shop({ base_url: `${SHOP}?tenant=1` })] })).toContain(
					"without a query string",
				)
				expect(
					yield* refused({ api_servers: [shop({ base_url: "ftp://shop.example" })] }),
				).toContain("base_url")
				expect(
					yield* refused({
						api_servers: [shop()],
						tools: [{ type: "api_toolset", api_server_name: "other" }],
					}),
				).toContain("which is not in api_servers")
				expect(vaults.catalogIds()).toEqual([])
			}),
		)
	})

	it("answers 503 and creates nothing when the document cannot be stored", async () => {
		const { run, vaults } = world()
		await run((call) =>
			Effect.gen(function* () {
				vaults.unreachableCatalogs.add("*")
				const made = yield* call("POST", "/v1/agents", agentBody({ api_servers: [shop()] }))
				expect(made.status).toBe(503)
				expect(message(made)).toContain("document storage is unavailable")
			}),
		)
	})

	it("stores no document for an update that is refused as stale", async () => {
		const { run, vaults } = world()
		await run((call) =>
			Effect.gen(function* () {
				const id = yield* created(call, "/v1/agents", agentBody({ api_servers: [shop()] }))
				const stale = yield* call("POST", `/v1/agents/${id}`, {
					version: 7,
					api_servers: [shop()],
				})
				expect(stale.status).toBe(409)
				expect(vaults.catalogIds()).toHaveLength(1)
			}),
		)
	})
})

describe("API keys in vaults", () => {
	it("stores a key with where it goes, and returns everything but the key", async () => {
		const { run, vaults } = world()
		await run((call) =>
			Effect.gen(function* () {
				const vault = yield* created(call, "/v1/vaults", { display_name: "vault" })
				const made = yield* call("POST", `/v1/vaults/${vault}/credentials`, {
					auth: {
						type: "api_key",
						base_url: `${SHOP}//#x`,
						token: "key_SECRET_one",
						placement: { in: "header", name: "Authorization", prefix: "Token " },
					},
				})
				expect(made.status, message(made)).toBe(201)
				expect(made.body["auth"]).toEqual({
					type: "api_key",
					base_url: SHOP,
					placement: { in: "header", name: "Authorization", prefix: "Token " },
				})
				expect(message(made)).not.toContain("key_SECRET_one")
				const id = String(made.body["id"])
				expect(vaults.held(id)).toEqual({
					type: "api_key",
					token: "key_SECRET_one",
					placement: { in: "header", name: "Authorization", prefix: "Token " },
				})
				expect(vaults.custodyOf(id).target()).toBe(SHOP)

				const rotated = yield* call("POST", `/v1/vaults/${vault}/credentials/${id}`, {
					auth: { type: "api_key", token: "key_SECRET_two" },
				})
				expect(rotated.status, message(rotated)).toBe(200)
				expect(vaults.held(id)).toMatchObject({
					token: "key_SECRET_two",
					placement: { in: "header", name: "Authorization", prefix: "Token " },
				})
				expect(JSON.stringify(yield* vaults.storedEvents("Credential", id))).not.toContain(
					"key_SECRET",
				)

				const other = yield* call("POST", `/v1/vaults/${vault}/credentials/${id}`, {
					auth: { type: "static_bearer", token: "tok" },
				})
				expect(other.status).toBe(400)
				const second = yield* call("POST", `/v1/vaults/${vault}/credentials`, {
					auth: {
						type: "api_key",
						base_url: SHOP,
						token: "key_SECRET_three",
						placement: { in: "query", name: "key" },
					},
				})
				expect(second.status).toBe(409)
			}),
		)
	})

	it("refuses a key it could not send safely", async () => {
		const { run } = world()
		await run((call) =>
			Effect.gen(function* () {
				const vault = yield* created(call, "/v1/vaults", { display_name: "vault" })
				const refused = (auth: Fields) =>
					Effect.map(
						call("POST", `/v1/vaults/${vault}/credentials`, {
							auth: { type: "api_key", base_url: SHOP, token: "key", ...auth },
						}),
						(answer) => {
							expect(answer.status, message(answer)).toBe(400)
							return message(answer)
						},
					)
				expect(yield* refused({ placement: { in: "header", name: "Host" } })).toContain(
					"the HTTP client sets that header",
				)
				expect(yield* refused({ placement: { in: "header", name: "Bad Name" } })).toContain(
					"placement",
				)
				expect(
					yield* refused({ placement: { in: "header", name: "X-Key", prefix: "a\nb" } }),
				).toContain("placement")
				expect(
					yield* refused({ placement: { in: "query", name: "k" }, base_url: `${SHOP}?a=1` }),
				).toContain("query string")
				expect(yield* refused({ placement: { in: "query", name: "k" }, extra: true })).toContain(
					"extra",
				)
				expect(yield* refused({})).toContain("placement")
			}),
		)
	})
})

describe("API servers in sessions", () => {
	it("binds a server to the one key stored for its base URL, and refuses to pick between two", async () => {
		const { run } = world()
		await run((call) =>
			Effect.gen(function* () {
				const agent = yield* created(call, "/v1/agents", agentBody({ api_servers: [shop()] }))
				const env = yield* environment(call)
				const one = yield* apiKeyIn(call)
				const two = yield* apiKeyIn(call)
				const elsewhere = yield* apiKeyIn(call, "https://api.other.example/v1")

				const none = yield* call("POST", "/v1/sessions", { agent, environment_id: env })
				expect(none.body["api_servers"]).toEqual([
					{ name: "shop", base_url: SHOP, credential_id: null },
				])

				const single = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: env,
					vault_ids: [one.vault, elsewhere.vault],
				})
				expect(single.status, message(single)).toBe(201)
				expect(single.body["api_servers"]).toEqual([
					{ name: "shop", base_url: SHOP, credential_id: one.credential },
				])
				const got = yield* call("GET", `/v1/sessions/${String(single.body["id"])}`)
				expect(got.body["api_servers"]).toEqual(single.body["api_servers"])

				const ambiguous = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: env,
					vault_ids: [one.vault, two.vault],
				})
				expect(ambiguous.status).toBe(400)
				expect(message(ambiguous)).toContain(
					String.raw`API server \"shop\" matches more than one credential`,
				)
				expect(message(ambiguous)).toContain("api_server_credentials")

				const bound = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: env,
					vault_ids: [one.vault, two.vault],
					api_server_credentials: [{ api_server_name: "shop", credential_id: two.credential }],
				})
				expect(bound.body["api_servers"]).toEqual([
					{ name: "shop", base_url: SHOP, credential_id: two.credential },
				])

				const wrongUrl = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: env,
					api_server_credentials: [
						{ api_server_name: "shop", credential_id: elsewhere.credential },
					],
				})
				expect(wrongUrl.status).toBe(400)
				expect(message(wrongUrl)).toContain("is stored for https://api.other.example/v1")

				const unknown = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: env,
					api_server_credentials: [{ api_server_name: "nope", credential_id: one.credential }],
				})
				expect(unknown.status).toBe(400)
				expect(message(unknown)).toContain("is not one of the agent's API servers")
			}),
		)
	})

	it("never gives an API a bearer token, nor an MCP server an API key", async () => {
		const { run } = world()
		await run((call) =>
			Effect.gen(function* () {
				// One URL serves both an API and an MCP server, and each kind of credential is stored for it.
				const agent = yield* created(
					call,
					"/v1/agents",
					agentBody({
						api_servers: [shop()],
						mcp_servers: [{ type: "url", name: "desk", url: SHOP }],
					}),
				)
				const env = yield* environment(call)
				const key = yield* apiKeyIn(call)
				const bearerVault = yield* created(call, "/v1/vaults", { display_name: "bearer" })
				const bearer = yield* created(call, `/v1/vaults/${bearerVault}/credentials`, {
					auth: { type: "static_bearer", token: "tok", mcp_server_url: SHOP },
				})

				const session = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: env,
					vault_ids: [key.vault, bearerVault],
				})
				expect(session.status, message(session)).toBe(201)
				expect(session.body["api_servers"]).toEqual([
					{ name: "shop", base_url: SHOP, credential_id: key.credential },
				])
				expect(session.body["mcp_servers"]).toEqual([
					{ name: "desk", url: SHOP, credential_id: bearer },
				])

				const crossed = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: env,
					api_server_credentials: [{ api_server_name: "shop", credential_id: bearer }],
				})
				expect(crossed.status).toBe(400)
				expect(message(crossed)).toContain("an API server can use")

				const crossedBack = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: env,
					mcp_server_credentials: [{ mcp_server_name: "desk", credential_id: key.credential }],
				})
				expect(crossedBack.status).toBe(400)
				expect(message(crossedBack)).toContain("an MCP server can use")
			}),
		)
	})

	it("refuses a session whose environment does not allow the API's host", async () => {
		const { run } = world()
		await run((call) =>
			Effect.gen(function* () {
				const agent = yield* created(call, "/v1/agents", agentBody({ api_servers: [shop()] }))
				const limited = (allowed_hosts: ReadonlyArray<string>) =>
					environment(call, {
						type: "cloud",
						networking: {
							type: "limited",
							// Allowing every MCP server says nothing about an API.
							allow_mcp_servers: true,
							allow_package_managers: false,
							allowed_hosts,
						},
					})
				const closed = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: yield* limited([]),
				})
				expect(closed.status).toBe(400)
				expect(message(closed)).toContain("does not allow API server")

				const open = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: yield* limited(["api.shop.example"]),
				})
				expect(open.status, message(open)).toBe(201)
			}),
		)
	})

	it("binds an automation session's API servers at its first turn", async () => {
		const { run } = world()
		await run((call) =>
			Effect.gen(function* () {
				const agent = yield* created(call, "/v1/agents", agentBody({ api_servers: [shop()] }))
				const env = yield* environment(call)
				const automation = yield* call(
					"POST",
					"/v1/automations",
					{
						name: "Report",
						agent,
						environment_id: env,
						initial_events: [
							{ type: "user.message", content: [{ type: "text", text: "Report." }] },
						],
						schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "UTC" },
					},
					{ "idempotency-key": "automation-with-api" },
				)
				expect(automation.status, message(automation)).toBe(201)
				const id = String(automation.body["id"])
				const ran = yield* call("POST", `/v1/automations/${id}/run`)
				expect(ran.status, message(ran)).toBe(201)
				const session = yield* call("GET", `/v1/sessions/sess_${id}_1`).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("5 millis"),
						times: 600,
						until: (answer) =>
							answer.status === 200 &&
							answer.body["status"] === "idle" &&
							answer.body["turn"] === 1,
					}),
				)
				expect(session.body).toMatchObject({
					status: "idle",
					turn: 1,
					api_servers: [{ name: "shop", base_url: SHOP, credential_id: null }],
				})
			}),
		)
	})
})
