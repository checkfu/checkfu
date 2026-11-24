import * as InMemory from "@alchemy.run/domain/InMemory"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import type * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { makeVaultsTestLayer } from "./helpers/VaultsHarness.ts"

const TRACKER = "https://mcp.tracker.example/mcp"
const WIKI = "https://mcp.wiki.example/mcp"

interface Fields {
	readonly [field: string]: Schema.Json
}

interface Answer {
	readonly status: number
	readonly body: Schema.JsonObject
}

const world = () => {
	// The Vaults model, which holds the server sets, runs on a platform of its own.
	const store = InMemory.make()
	const base = makePiDurableTestLayer(
		async (model) => makeAssistantReply(model, null, "ok", 1, 1),
		undefined,
		undefined,
		undefined,
		makeVaultsTestLayer(store.layer).layer,
	)
	const run = async <A, E>(
		body: (api: {
			readonly call: (method: string, path: string, payload?: unknown) => Effect.Effect<Answer>
			readonly fetch: Parameters<typeof sendRequest>[0]
		}) => Effect.Effect<A, E, Layer.Success<typeof base.layer>>,
	): Promise<A> => {
		try {
			return await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					return yield* body({
						fetch: apiFetch,
						call: (method, path, payload) =>
							Effect.gen(function* () {
								const res = yield* sendRequest(apiFetch, {
									method,
									path,
									headers: AUTH_HEADERS,
									...(payload === undefined ? {} : { body: payload }),
								})
								return {
									status: res.status,
									body: (yield* Effect.promise(() => res.json())) as Schema.JsonObject,
								}
							}),
					})
				}).pipe(Effect.scoped, Effect.provide(base.layer)),
			)
		} finally {
			await base.closeAll()
		}
	}
	return { run, requests: base.requests, control: store.control }
}

type Call = (method: string, path: string, payload?: unknown) => Effect.Effect<Answer>

const created = (call: Call, path: string, payload: unknown) =>
	Effect.map(call("POST", path, payload), (answer) => {
		expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(300)
		return String(answer.body["id"])
	})

const credentialIn = (call: Call, url: string, token = "tok_secret") =>
	Effect.gen(function* () {
		const vault = yield* created(call, "/v1/vaults", { display_name: "vault" })
		const credential = yield* created(call, `/v1/vaults/${vault}/credentials`, {
			auth: { type: "static_bearer", token, mcp_server_url: url },
		})
		return { vault, credential }
	})

const agentWith = (call: Call, servers: ReadonlyArray<{ name: string; url: string }>) =>
	created(call, "/v1/agents", {
		name: "Agent",
		model: "gpt-4o-mini",
		mcp_servers: servers.map((server) => ({ type: "url", ...server })),
	})

const errorMessage = (answer: Answer): string => JSON.stringify(answer.body)

describe("MCP servers on agents", () => {
	it("versions an agent's servers with the rest of its configuration", async () => {
		await world().run(({ call }) =>
			Effect.gen(function* () {
				const made = yield* call("POST", "/v1/agents", {
					name: "Agent",
					model: "gpt-4o-mini",
					mcp_servers: [{ type: "url", name: "tracker", url: `${TRACKER}#section` }],
				})
				expect(made.status).toBe(201)
				expect(made.body["mcp_servers"]).toEqual([{ type: "url", name: "tracker", url: TRACKER }])
				const id = String(made.body["id"])

				const renamed = yield* call("POST", `/v1/agents/${id}`, { version: 1, name: "Renamed" })
				expect(renamed.body).toMatchObject({
					version: 2,
					mcp_servers: [{ type: "url", name: "tracker", url: TRACKER }],
				})

				const same = yield* call("POST", `/v1/agents/${id}`, {
					version: 2,
					mcp_servers: [{ type: "url", name: "tracker", url: TRACKER }],
				})
				expect(same.body).toMatchObject({ version: 2 })

				const replaced = yield* call("POST", `/v1/agents/${id}`, {
					version: 2,
					mcp_servers: [{ type: "url", name: "wiki", url: WIKI }],
				})
				expect(replaced.body).toMatchObject({
					version: 3,
					mcp_servers: [{ type: "url", name: "wiki", url: WIKI }],
				})

				const cleared = yield* call("POST", `/v1/agents/${id}`, { version: 3, mcp_servers: [] })
				expect(cleared.body).toMatchObject({ version: 4, mcp_servers: [] })
				expect((yield* call("GET", `/v1/agents/${id}`)).body["mcp_servers"]).toEqual([])
			}),
		)
	})

	it("refuses servers it could not tell apart or would not connect to", async () => {
		await world().run(({ call }) =>
			Effect.gen(function* () {
				const agent = (servers: ReadonlyArray<unknown>) =>
					call("POST", "/v1/agents", { name: "Agent", model: "gpt-4o-mini", mcp_servers: servers })
				const twice = yield* agent([
					{ type: "url", name: "tracker", url: TRACKER },
					{ type: "url", name: "tracker", url: WIKI },
				])
				expect(twice.status).toBe(400)
				expect(errorMessage(twice)).toContain("used more than once")
				expect((yield* agent([{ type: "url", name: "a b", url: TRACKER }])).status).toBe(400)
				expect(
					(yield* agent([{ type: "url", name: "plain", url: "http://mcp.example/mcp" }])).status,
				).toBe(400)
				expect(
					(yield* agent([{ type: "url", name: "creds", url: "https://user:pw@mcp.example/mcp" }]))
						.status,
				).toBe(400)
			}),
		)
	})
})

describe("Binding an agent's MCP servers when a session is created", () => {
	it("binds the one credential a vault stores for the server and leaves the others bare", async () => {
		const { run, requests } = world()
		await run(({ call, fetch }) =>
			Effect.gen(function* () {
				const { vault, credential } = yield* credentialIn(call, TRACKER)
				const agent = yield* agentWith(call, [
					{ name: "tracker", url: TRACKER },
					{ name: "wiki", url: WIKI },
				])
				const environment = yield* created(call, "/v1/environments", { name: "Env" })
				const session = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: environment,
					vault_ids: [vault],
				})
				expect(session.status, errorMessage(session)).toBe(201)
				const bound = [
					{ name: "tracker", url: TRACKER, credential_id: credential },
					{ name: "wiki", url: WIKI, credential_id: null },
				]
				expect(session.body["mcp_servers"]).toEqual(bound)
				const id = String(session.body["id"])
				expect((yield* call("GET", `/v1/sessions/${id}`)).body["mcp_servers"]).toEqual(bound)

				yield* sendAndSettle(fetch, id, ["hello"], 1)
				expect(requests.at(-1)?.mcp_servers).toEqual(bound)
			}),
		)
	})

	it("refuses to pick between two credentials for one server, and binds the one it is told to", async () => {
		await world().run(({ call }) =>
			Effect.gen(function* () {
				const first = yield* credentialIn(call, TRACKER, "tok_first")
				const second = yield* credentialIn(call, TRACKER, "tok_second")
				const agent = yield* agentWith(call, [{ name: "tracker", url: TRACKER }])
				const environment = yield* created(call, "/v1/environments", { name: "Env" })
				const create = (extra: Fields) =>
					call("POST", "/v1/sessions", {
						agent,
						environment_id: environment,
						vault_ids: [first.vault, second.vault],
						...extra,
					})

				const ambiguous = yield* create({})
				expect(ambiguous.status).toBe(400)
				expect(errorMessage(ambiguous)).toContain(
					String.raw`MCP server \"tracker\" matches more than one`,
				)
				expect(errorMessage(ambiguous)).toContain(first.credential)
				expect(errorMessage(ambiguous)).toContain(second.credential)

				const chosen = yield* create({
					mcp_server_credentials: [
						{ mcp_server_name: "tracker", credential_id: second.credential },
					],
				})
				expect(chosen.status, errorMessage(chosen)).toBe(201)
				expect(chosen.body["mcp_servers"]).toEqual([
					{ name: "tracker", url: TRACKER, credential_id: second.credential },
				])
			}),
		)
	})

	it("refuses an explicit binding that does not fit the server", async () => {
		await world().run(({ call }) =>
			Effect.gen(function* () {
				const tracker = yield* credentialIn(call, TRACKER)
				const wiki = yield* credentialIn(call, WIKI)
				const agent = yield* agentWith(call, [{ name: "tracker", url: TRACKER }])
				const environment = yield* created(call, "/v1/environments", { name: "Env" })
				const bind = (mcp_server_name: string, credential_id: string) =>
					call("POST", "/v1/sessions", {
						agent,
						environment_id: environment,
						mcp_server_credentials: [{ mcp_server_name, credential_id }],
					})

				const otherServer = yield* bind("tracker", wiki.credential)
				expect(otherServer.status).toBe(400)
				expect(errorMessage(otherServer)).toContain(`is stored for ${WIKI}`)

				const unknownServer = yield* bind("search", tracker.credential)
				expect(unknownServer.status).toBe(400)
				expect(errorMessage(unknownServer)).toContain("not one of the agent's MCP servers")

				const noSuch = yield* bind("tracker", "vcrd_missing")
				expect(noSuch.status).toBe(400)
				expect(errorMessage(noSuch)).toContain("is not an active credential")

				const archived = yield* call(
					"POST",
					`/v1/vaults/${tracker.vault}/credentials/${tracker.credential}/archive`,
				)
				expect(archived.status).toBe(200)
				const afterArchive = yield* bind("tracker", tracker.credential)
				expect(afterArchive.status).toBe(400)
				expect(errorMessage(afterArchive)).toContain("is not an active credential")

				const missingVault = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: environment,
					vault_ids: ["vlt_missing"],
				})
				expect(missingVault.status).toBe(404)
			}),
		)
	})

	it("binds the servers of the version the session pins", async () => {
		await world().run(({ call }) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [{ name: "tracker", url: TRACKER }])
				const updated = yield* call("POST", `/v1/agents/${agent}`, {
					version: 1,
					mcp_servers: [{ type: "url", name: "wiki", url: WIKI }],
				})
				expect(updated.body).toMatchObject({ version: 2 })
				const environment = yield* created(call, "/v1/environments", { name: "Env" })
				const pinned = yield* call("POST", "/v1/sessions", {
					agent: { id: agent, version: 1 },
					environment_id: environment,
				})
				expect(pinned.body["mcp_servers"]).toEqual([
					{ name: "tracker", url: TRACKER, credential_id: null },
				])
				const latest = yield* call("POST", "/v1/sessions", {
					agent,
					environment_id: environment,
				})
				expect(latest.body).toMatchObject({
					agent: { id: agent, version: 2 },
					mcp_servers: [{ name: "wiki", url: WIKI, credential_id: null }],
				})
			}),
		)
	})

	it("refuses a session whose environment does not let it reach a server", async () => {
		await world().run(({ call }) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [{ name: "tracker", url: TRACKER }])
				const environment = (networking: Fields) =>
					created(call, "/v1/environments", {
						name: "Env",
						config: { type: "cloud", networking: { type: "limited", ...networking } },
					})
				const session = (environment_id: string) =>
					call("POST", "/v1/sessions", { agent, environment_id })

				const closed = yield* session(
					yield* environment({
						allow_mcp_servers: false,
						allow_package_managers: false,
						allowed_hosts: ["other.example"],
					}),
				)
				expect(closed.status).toBe(400)
				expect(errorMessage(closed)).toContain("mcp.tracker.example")

				const listed = yield* session(
					yield* environment({
						allow_mcp_servers: false,
						allow_package_managers: false,
						allowed_hosts: ["MCP.tracker.example"],
					}),
				)
				expect(listed.status, errorMessage(listed)).toBe(201)

				const open = yield* session(
					yield* environment({
						allow_mcp_servers: true,
						allow_package_managers: false,
						allowed_hosts: [],
					}),
				)
				expect(open.status, errorMessage(open)).toBe(201)
			}),
		)
	})

	it("returns the committed session for a retried create and binds nothing again", async () => {
		const test = world()
		await test.run(({ call, fetch }) =>
			Effect.gen(function* () {
				const agent = yield* created(call, "/v1/agents", { name: "Agent", model: "gpt-4o-mini" })
				const environment = yield* created(call, "/v1/environments", { name: "Env" })
				const { vault } = yield* credentialIn(call, TRACKER)
				const body = { agent, environment_id: environment, vault_ids: [vault] }
				const create = () =>
					Effect.flatMap(
						sendRequest(fetch, {
							method: "POST",
							path: "/v1/sessions",
							headers: { ...AUTH_HEADERS, "idempotency-key": "retried-create" },
							body,
						}),
						(res) =>
							Effect.map(
								Effect.promise(() => res.json()),
								(json) => ({ status: res.status, body: json as Schema.JsonObject }),
							),
					)
				const first = yield* create()
				expect(first.status, errorMessage(first)).toBe(201)
				expect(first.body).toMatchObject({ agent: { id: agent, version: 1 }, mcp_servers: [] })

				// The agent gains a server its pinned version never declared, and the vault goes away.
				const updated = yield* call("POST", `/v1/agents/${agent}`, {
					version: 1,
					mcp_servers: [{ type: "url", name: "tracker", url: TRACKER }],
				})
				expect(updated.body).toMatchObject({ version: 2 })
				expect((yield* call("POST", `/v1/vaults/${vault}/archive`)).status).toBe(200)

				const retried = yield* create()
				expect(retried.status, errorMessage(retried)).toBeLessThan(300)
				expect(retried.body).toMatchObject({
					id: first.body["id"],
					agent: { id: agent, version: 1 },
					mcp_servers: [],
				})
				const sessionSets = test.control.commits.filter(
					(commit) => commit.aggregate === "McpServerSet" && commit.id === first.body["id"],
				)
				expect(sessionSets).toEqual([])
			}),
		)
	})

	it("leaves no server sets behind for updates that change nothing", async () => {
		const test = world()
		await test.run(({ call }) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [{ name: "tracker", url: TRACKER }])
				const sets = () =>
					test.control.commits.filter((commit) => commit.aggregate === "McpServerSet").length
				const before = sets()
				for (const _ of [1, 2, 3]) {
					const same = yield* call("POST", `/v1/agents/${agent}`, { version: 1, name: "Agent" })
					expect(same.body).toMatchObject({ version: 1 })
				}
				expect(sets()).toBe(before)
				const renamed = yield* call("POST", `/v1/agents/${agent}`, { version: 1, name: "Renamed" })
				expect(renamed.body).toMatchObject({
					version: 2,
					mcp_servers: [{ type: "url", name: "tracker", url: TRACKER }],
				})
				expect(sets()).toBe(before + 1)
			}),
		)
	})

	it("binds an automation session's servers at its first turn", async () => {
		await world().run(({ call, fetch }) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [{ name: "tracker", url: TRACKER }])
				const environment = yield* created(call, "/v1/environments", { name: "Env" })
				const createdAutomation = yield* sendRequest(fetch, {
					method: "POST",
					path: "/v1/automations",
					headers: { ...AUTH_HEADERS, "idempotency-key": "automation-with-servers" },
					body: {
						name: "Report",
						agent,
						environment_id: environment,
						initial_events: [
							{ type: "user.message", content: [{ type: "text", text: "Report." }] },
						],
						schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "UTC" },
					},
				})
				expect(createdAutomation.status).toBe(201)
				const automation = String(
					((yield* Effect.promise(() => createdAutomation.json())) as Schema.JsonObject)["id"],
				)
				const run = yield* call("POST", `/v1/automations/${automation}/run`)
				expect(run.status, errorMessage(run)).toBe(201)
				const session = yield* call("GET", `/v1/sessions/sess_${automation}_1`).pipe(
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
					mcp_servers: [{ name: "tracker", url: TRACKER, credential_id: null }],
				})
			}),
		)
	})
})

describe("When an agent's MCP tools ask first", () => {
	const ASK = { type: "always_ask" }
	const ALLOW = { type: "always_allow" }

	it("keeps each server's policy with the agent's version and returns it as it was given", async () => {
		await world().run(({ call }) =>
			Effect.gen(function* () {
				const tools = [
					{
						type: "mcp_toolset",
						mcp_server_name: "tracker",
						default_config: { permission_policy: ALLOW },
						configs: [{ name: "close_issue", permission_policy: ASK }],
					},
				]
				const made = yield* call("POST", "/v1/agents", {
					name: "Agent",
					model: "gpt-4o-mini",
					mcp_servers: [
						{ type: "url", name: "tracker", url: TRACKER },
						{ type: "url", name: "wiki", url: WIKI },
					],
					tools,
				})
				expect(made.status, errorMessage(made)).toBe(201)
				expect(made.body["tools"]).toEqual(tools)
				expect(made.body["mcp_servers"]).toEqual([
					{ type: "url", name: "tracker", url: TRACKER },
					{ type: "url", name: "wiki", url: WIKI },
				])
				const id = String(made.body["id"])

				// Replacing the servers keeps the policy of the one that stays.
				const fewer = yield* call("POST", `/v1/agents/${id}`, {
					version: 1,
					mcp_servers: [{ type: "url", name: "tracker", url: TRACKER }],
				})
				expect(fewer.body).toMatchObject({ version: 2, tools })

				// Replacing the tools replaces every policy, and mints a version of its own.
				const wikiOnly = [
					{
						type: "mcp_toolset",
						mcp_server_name: "tracker",
						default_config: { permission_policy: ASK },
					},
				]
				const replaced = yield* call("POST", `/v1/agents/${id}`, { version: 2, tools: wikiOnly })
				expect(replaced.body).toMatchObject({ version: 3, tools: wikiOnly })

				const cleared = yield* call("POST", `/v1/agents/${id}`, { version: 3, tools: [] })
				expect(cleared.body).toMatchObject({ version: 4, tools: [] })
			}),
		)
	})

	it("refuses a toolset for a server the agent does not have, or a second one for the same server", async () => {
		await world().run(({ call }) =>
			Effect.gen(function* () {
				const agent = (tools: ReadonlyArray<Fields>) =>
					call("POST", "/v1/agents", {
						name: "Agent",
						model: "gpt-4o-mini",
						mcp_servers: [{ type: "url", name: "tracker", url: TRACKER }],
						tools,
					})
				const unknown = yield* agent([{ type: "mcp_toolset", mcp_server_name: "wiki" }])
				expect(unknown.status).toBe(400)
				expect(errorMessage(unknown)).toContain("wiki")

				const twice = yield* agent([
					{ type: "mcp_toolset", mcp_server_name: "tracker" },
					{ type: "mcp_toolset", mcp_server_name: "tracker" },
				])
				expect(twice.status).toBe(400)
				expect(errorMessage(twice)).toContain("more than one mcp_toolset")

				const repeated = yield* agent([
					{
						type: "mcp_toolset",
						mcp_server_name: "tracker",
						configs: [
							{ name: "search", permission_policy: ASK },
							{ name: "search", permission_policy: ALLOW },
						],
					},
				])
				expect(repeated.status).toBe(400)

				const auto = yield* agent([
					{
						type: "mcp_toolset",
						mcp_server_name: "tracker",
						default_config: { permission_policy: { type: "auto" } },
					},
				])
				expect(auto.status).toBe(400)
			}),
		)
	})

	it("refuses servers and policies too large together before claiming the create", async () => {
		await world().run(({ fetch }) =>
			Effect.gen(function* () {
				const servers = ["a", "b", "c"].map((name) => ({
					type: "url",
					name,
					url: `https://mcp.${name}.example/mcp`,
				}))
				const policies = servers.map((server) => ({
					type: "mcp_toolset",
					mcp_server_name: server.name,
					configs: Array.from({ length: 128 }, (_, index) => ({
						name: `${"tool_".repeat(40)}${index}`,
						permission_policy: { type: "always_ask" },
					})),
				}))
				const create = (body: unknown) =>
					Effect.flatMap(
						sendRequest(fetch, {
							method: "POST",
							path: "/v1/agents",
							headers: { ...AUTH_HEADERS, "idempotency-key": "large-agent" },
							body,
						}),
						(res) =>
							Effect.map(
								Effect.promise(() => res.json()),
								(json) => ({ status: res.status, body: json as Schema.JsonObject }),
							),
					)
				const large = yield* create({
					name: "Agent",
					model: "gpt-4o-mini",
					mcp_servers: servers,
					tools: policies,
				})
				expect(large.status, errorMessage(large)).toBe(400)
				expect(errorMessage(large)).toContain("at most 65536 fit")
				// Nothing was claimed, so the same key still creates the agent it is sent with next.
				const small = yield* create({ name: "Agent", model: "gpt-4o-mini", mcp_servers: servers })
				expect(small.status, errorMessage(small)).toBe(201)
			}),
		)
	})
})
