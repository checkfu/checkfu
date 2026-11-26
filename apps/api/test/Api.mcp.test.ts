import { AdmitSessionDecision } from "@checkfu/domain/Session/AdmitSession.decision"
import { describe, expect, it } from "@effect/vitest"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations"
import fc from "fast-check"
import { createCommandId, idempotentCommandId } from "../src/Http/HttpHelpers.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	MAX_TOOL_CATALOG_BYTES,
	MAX_TOOL_LIST_BYTES,
	mcpExtension,
	mcpRegistry,
	withinCatalog,
} from "../src/Pi/PiMcp.ts"
import type { McpServerEntry } from "../src/Pi/PiMcp.ts"
import type { McpCallOutcome, McpToolDescriptor } from "../src/Pi/PiMcpTypes.ts"
import {
	MAX_PUBLIC_TOOL_NAME_LENGTH,
	MODEL_TOOL_NAME,
	assignToolNames,
} from "../src/Pi/PiToolNames.ts"
import type { ToolNames } from "../src/Pi/PiToolNames.ts"
import { MODEL_TEXT_LIMITS } from "../src/Pi/PiToolText.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { makeVaultsTestLayer } from "./helpers/VaultsHarness.ts"

const DOCS = "https://docs.mcp.example/mcp"
const TOKEN = "tok_live_mcp_SECRET_1b2c"

const limited = (allowed_hosts: ReadonlyArray<string>) => ({
	type: "cloud",
	networking: {
		type: "limited",
		allow_mcp_servers: false,
		allow_package_managers: false,
		allowed_hosts,
	},
})

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
		vaults: ReturnType<typeof makeVaultsTestLayer>,
	) => Effect.Effect<A, never, Hosted | Scope.Scope>,
	wrapAdmit?: (
		admit: typeof AdmitSessionDecision.Service,
	) => Effect.Effect<typeof AdmitSessionDecision.Service, never, Hosted>,
): Promise<A> => {
	const vaults = makeVaultsTestLayer()
	const { layer, closeAll } = makePiDurableTestLayer(
		async (model) => makeAssistantReply(model, null, "ok", 1, 1),
		{ vaults: vaults.layer },
	)
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const realAdmit = yield* AdmitSessionDecision
				const admit = wrapAdmit === undefined ? realAdmit : yield* wrapAdmit(realAdmit)
				const { fetch: apiFetch } = yield* makeApiHandler.pipe(
					Effect.provideService(AdmitSessionDecision, admit),
				)
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
					vaults,
				)
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
	}
}

const agentWith = (call: Call, mcp_servers: ReadonlyArray<unknown>) =>
	Effect.map(
		call("POST", "/v1/agents", { name: "Researcher", model: "gpt-4o-mini", mcp_servers }),
		(res) => {
			expect(res.status).toBe(201)
			return res.body as { id: string; version: number; mcp_servers: ReadonlyArray<unknown> }
		},
	)

const environment = (call: Call, config?: unknown) =>
	Effect.map(
		call("POST", "/v1/environments", {
			name: "Cloud",
			...(config === undefined ? {} : { config }),
		}),
		(res) => {
			expect(res.status).toBe(201)
			return res.body as { id: string }
		},
	)

const credentialIn = (call: Call, url = DOCS) =>
	Effect.gen(function* () {
		const vault = yield* call("POST", "/v1/vaults", { display_name: "Team" })
		expect(vault.status).toBe(201)
		const credential = yield* call("POST", `/v1/vaults/${vault.body.id}/credentials`, {
			auth: { type: "static_bearer", token: TOKEN, mcp_server_url: url },
		})
		expect(credential.status).toBe(201)
		return { vault: vault.body.id as string, credential: credential.body.id as string }
	})

describe("MCP servers on agents", () => {
	it("stores each version's servers with the version, normalized", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [
					{ type: "url", name: "docs", url: "https://docs.mcp.example/mcp#top" },
				])
				expect(agent.mcp_servers).toEqual([{ type: "url", name: "docs", url: DOCS }])
				const updated = yield* call("POST", `/v1/agents/${agent.id}`, {
					version: 1,
					mcp_servers: [],
				})
				expect(updated.body).toMatchObject({ version: 2, mcp_servers: [] })
				const head = yield* call("GET", `/v1/agents/${agent.id}`)
				expect(head.body).toMatchObject({ version: 2, mcp_servers: [] })
			}),
		)
	})

	it("refuses two servers whose tools would share names, and names that would blur the boundary", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const twice = yield* call("POST", "/v1/agents", {
					name: "Twice",
					model: "gpt-4o-mini",
					mcp_servers: [
						{ type: "url", name: "docs", url: DOCS },
						{ type: "url", name: "docs", url: "https://other.mcp.example/mcp" },
					],
				})
				expect(twice.status).toBe(400)
				expect(twice.body.error.message).toContain('"docs"')
				for (const name of ["a__b", "_docs", "docs_", "x".repeat(33)]) {
					const res = yield* call("POST", "/v1/agents", {
						name: "Blurred",
						model: "gpt-4o-mini",
						mcp_servers: [{ type: "url", name, url: DOCS }],
					})
					expect(res.status).toBe(400)
				}
				const plain = yield* call("POST", "/v1/agents", {
					name: "Plain",
					model: "gpt-4o-mini",
					mcp_servers: [{ type: "url", name: "docs", url: "http://docs.mcp.example/mcp" }],
				})
				expect(plain.status).toBe(400)
			}),
		)
	})
})

describe("Session credentials", () => {
	it("gives a server the one credential across the session's vaults, refuses two, and takes the one named", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [{ type: "url", name: "docs", url: DOCS }])
				const env = yield* environment(call)
				const first = yield* credentialIn(call)
				const second = yield* credentialIn(call)
				const create = (extra: Record<string, ReadonlyArray<unknown>>) =>
					call("POST", "/v1/sessions", { agent: agent.id, environment_id: env.id, ...extra })
				const pair = (credential_id: string) => [{ mcp_server_name: "docs", credential_id }]

				const none = yield* create({})
				expect(none.status).toBe(201)
				expect(none.body.mcp_server_credentials).toEqual([])

				const one = yield* create({ vault_ids: [first.vault, first.vault] })
				const placed = (held: { vault: string; credential: string }) => [
					{ mcp_server_name: "docs", credential_id: held.credential, vault_id: held.vault },
				]
				expect(one.body.mcp_server_credentials).toEqual(placed(first))

				const both = yield* create({ vault_ids: [first.vault, second.vault] })
				expect(both.status).toBe(400)
				expect(both.body.error.message).toContain('"docs"')

				const named = yield* create({
					vault_ids: [first.vault, second.vault],
					mcp_server_credentials: pair(second.credential),
				})
				expect(named.status).toBe(201)
				expect(named.body.mcp_server_credentials).toEqual(placed(second))
				const read = yield* call("GET", `/v1/sessions/${named.body.id}`)
				expect(read.body.mcp_server_credentials).toEqual(placed(second))

				const elsewhere = yield* credentialIn(call, "https://elsewhere.mcp.example/mcp")
				for (const refused of [
					pair(elsewhere.credential),
					pair("cred_missing"),
					[{ mcp_server_name: "files", credential_id: first.credential }],
					[...pair(first.credential), ...pair(second.credential)],
				]) {
					expect((yield* create({ mcp_server_credentials: refused })).status).toBe(400)
				}
				expect(JSON.stringify([none.body, one.body, named.body])).not.toContain(TOKEN)
			}),
		)
	})

	it("binds a server to the credential holding its URL while that credential's token is still being stored", async () => {
		await world((call, vaults) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [{ type: "url", name: "docs", url: DOCS }])
				const env = yield* environment(call)
				const vault = (yield* call("POST", "/v1/vaults", { display_name: "Team" })).body
					.id as string
				const path = `/v1/vaults/${vault}/credentials`
				vaults.unreachable.add(vault)
				const storing = yield* call("POST", path, {
					auth: { type: "static_bearer", token: TOKEN, mcp_server_url: DOCS },
				})
				expect(storing.status).toBe(503)
				const credential = /vcrd_[0-9a-f]+/u.exec(JSON.stringify(storing.body))?.[0] ?? ""
				expect((yield* call("GET", `${path}/${credential}`)).body.custody).toBe("storing")

				const session = yield* call("POST", "/v1/sessions", {
					agent: agent.id,
					environment_id: env.id,
					vault_ids: [vault],
				})
				expect(session.status).toBe(201)
				expect(session.body.mcp_server_credentials).toEqual([
					{ mcp_server_name: "docs", credential_id: credential, vault_id: vault },
				])

				vaults.unreachable.clear()
				const stored = yield* call("POST", `${path}/${credential}`, {
					auth: { type: "static_bearer", token: TOKEN },
				})
				expect(stored.status).toBe(200)
				expect((yield* call("GET", `${path}/${credential}`)).body.custody).toBe("held")
				expect(vaults.secretOf(credential)).toBe(TOKEN)
			}),
		)
	})

	it("refuses early a server the environment's network rules do not allow", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [{ type: "url", name: "docs", url: DOCS }])
				const closed = yield* environment(call, limited(["api.openai.com"]))
				const refused = yield* call("POST", "/v1/sessions", {
					agent: agent.id,
					environment_id: closed.id,
				})
				expect(refused.status).toBe(400)
				expect(refused.body.error.message).toContain("docs.mcp.example")
				const open = yield* environment(call, limited(["docs.mcp.example"]))
				const allowed = yield* call("POST", "/v1/sessions", {
					agent: agent.id,
					environment_id: open.id,
				})
				expect(allowed.status).toBe(201)
			}),
		)
	})

	it("refuses a session in an environment that does not exist, whatever the agent declares", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [{ type: "url", name: "docs", url: DOCS }])
				const missing = yield* call("POST", "/v1/sessions", {
					agent: agent.id,
					environment_id: "env_missing",
				})
				expect(missing.status).toBe(404)
			}),
		)
	})

	it("admits the version whose servers it read, and none that appears between the read and admission", async () => {
		let beforeAdmission: Effect.Effect<unknown> = Effect.void
		const admitted: Array<number | null> = []
		await world(
			(call) =>
				Effect.gen(function* () {
					const env = yield* environment(call)
					const held = yield* credentialIn(call)
					const docs = [{ type: "url", name: "docs", url: DOCS }]
					const create = (agent: string, extra: { readonly agent_version?: number } = {}) =>
						call("POST", "/v1/sessions", {
							agent,
							environment_id: env.id,
							vault_ids: [held.vault],
							...extra,
						})

					expect((yield* create("agent_missing")).status).toBe(404)

					const bare = yield* agentWith(call, [])
					const gained = call("POST", `/v1/agents/${bare.id}`, { version: 1, mcp_servers: docs })
					beforeAdmission = gained
					const early = yield* create(bare.id, { agent_version: 2 })
					expect(early.status).toBe(404)
					expect(admitted).toEqual([])
					expect((yield* gained).status).toBe(200)
					const later = yield* create(bare.id, { agent_version: 2 })
					expect(later.body.mcp_server_credentials).toEqual([
						{ mcp_server_name: "docs", credential_id: held.credential, vault_id: held.vault },
					])

					const bound = yield* agentWith(call, docs)
					beforeAdmission = call("POST", `/v1/agents/${bound.id}`, {
						version: 1,
						mcp_servers: [{ type: "url", name: "other", url: "https://other.mcp.example/mcp" }],
					})
					const head = yield* create(bound.id)
					expect(head.status).toBe(201)
					expect(head.body.agent.version).toBe(1)
					expect(head.body.mcp_server_credentials).toEqual([
						{ mcp_server_name: "docs", credential_id: held.credential, vault_id: held.vault },
					])
					expect(admitted).toEqual([2, 1])
				}),
			(realAdmit) =>
				Effect.succeed({
					...realAdmit,
					send: (command, options) => {
						admitted.push(command.agent_version)
						const racing = beforeAdmission
						beforeAdmission = Effect.void
						return Effect.andThen(racing, realAdmit.send(command, options))
					},
				}),
		)
	})

	it("answers a keyed retry with the session as admitted, after its vault, its agent and its network rules changed", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const agent = yield* agentWith(call, [{ type: "url", name: "docs", url: DOCS }])
				const env = yield* environment(call)
				const held = yield* credentialIn(call)
				const key = { "idempotency-key": "admitted-retry-1" }
				const body = {
					agent: agent.id,
					environment_id: env.id,
					title: "Retry",
					vault_ids: [held.vault],
				}
				const first = yield* call("POST", "/v1/sessions", body, key)
				expect(first.status).toBe(201)
				expect(first.body.mcp_server_credentials).toEqual([
					{ mcp_server_name: "docs", credential_id: held.credential, vault_id: held.vault },
				])
				expect((yield* call("POST", `/v1/vaults/${held.vault}/archive`)).status).toBe(200)
				const gained = yield* call("POST", `/v1/agents/${agent.id}`, {
					version: 1,
					mcp_servers: [{ type: "url", name: "other", url: "https://other.mcp.example/mcp" }],
				})
				expect(gained.body.version).toBe(2)
				const tightened = yield* call("POST", `/v1/environments/${env.id}`, {
					version: 1,
					config: limited([]),
				})
				expect(tightened.status).toBe(200)
				const retry = yield* call("POST", "/v1/sessions", body, key)
				expect(retry.status).toBe(first.status)
				expect(retry.body).toEqual(first.body)
				const other = yield* call("POST", "/v1/sessions", { ...body, title: "Other" }, key)
				expect(other.status).toBe(409)
			}),
		)
	})

	it("keeps the fingerprint of a create keyed before sessions and agents took MCP fields", async () => {
		const sent: Array<string | undefined> = []
		await world(
			(call) =>
				Effect.gen(function* () {
					const digest = yield* Digest.Digest
					const key = { "idempotency-key": "pre-upgrade-1" }
					const named = { name: "Researcher", model: "gpt-4o-mini" }
					const created = yield* call("POST", "/v1/agents", named, key)
					expect(created.status).toBe(201)
					const again = yield* call("POST", "/v1/agents", { ...named, mcp_servers: [] }, key)
					expect([again.status, again.body]).toEqual([created.status, created.body])
					expect(
						yield* createCommandId(digest, "agent", "pre-upgrade-1", {
							name: "Researcher",
							model: { id: "gpt-4o-mini" },
							system: null,
							description: null,
							mcp_servers: [],
						}),
					).toBe(
						yield* idempotentCommandId(digest, "create-agent", [
							"create",
							"agent",
							"pre-upgrade-1",
							'{"description":null,"model":{"id":"gpt-4o-mini"},"name":"Researcher","system":null}',
						]),
					)

					const env = yield* environment(call)
					const body = { agent: created.body.id, environment_id: env.id }
					const first = yield* call("POST", "/v1/sessions", body, key)
					const empty = yield* call(
						"POST",
						"/v1/sessions",
						{ ...body, vault_ids: [], mcp_server_credentials: [] },
						key,
					)
					expect([empty.status, empty.body]).toEqual([first.status, first.body])
					const before = yield* idempotentCommandId(digest, "create-session", [
						"create",
						"session",
						"pre-upgrade-1",
						`{"agent_id":"${created.body.id}","agent_version":null,"environment_id":"${env.id}","title":null}`,
					])
					expect(sent).toEqual([before, before])
				}),
			(realAdmit) =>
				Effect.succeed({
					...realAdmit,
					send: (command, options) => {
						sent.push(options?.commandId)
						return realAdmit.send(command, options)
					},
				}),
		)
	})
})

describe("MCP servers a command would not carry", () => {
	it("answers 400, never 500, for servers whose normalized form passes a limit", async () => {
		await world((call) =>
			Effect.gen(function* () {
				const grows = `https://docs.mcp.example/${"é".repeat(700)}`
				const long = yield* call("POST", "/v1/agents", {
					name: "Researcher",
					model: "gpt-4o-mini",
					mcp_servers: [{ type: "url", name: "docs", url: grows }],
				})
				expect(long.status).toBe(400)
				const escaped = `https://docs.mcp.example/mcp?q=${"\\".repeat(1990)}`
				const many = yield* call("POST", "/v1/agents", {
					name: "Researcher",
					model: "gpt-4o-mini",
					mcp_servers: Array.from({ length: 20 }, (_, i) => ({
						type: "url",
						name: `docs-${i}`,
						url: escaped,
					})),
				})
				expect(many.status).toBe(400)
				const agent = yield* agentWith(call, [])
				const updated = yield* call("POST", `/v1/agents/${agent.id}`, {
					version: 1,
					mcp_servers: [{ type: "url", name: "docs", url: grows }],
				})
				expect(updated.status).toBe(400)
			}),
		)
	})
})

describe("MCP tool registry", () => {
	const binding = { name: "docs", url: DOCS, credential_id: null, vault_id: null }
	const descriptor = (name: string) => ({
		name,
		description: `Tool ${name}`,
		inputSchema: { type: "object" },
	})

	const listed = (...names: ReadonlyArray<string>) => [
		{ binding, tools: { status: "listed" as const, tools: names.map(descriptor) } },
	]
	const modelNameOf = (registry: ReturnType<typeof mcpRegistry>, tool: string): string =>
		[...registry.byName].find(([, registered]) => registered.tool.name === tool)?.[0] ?? ""

	type SampledSchema = NonNullable<Parameters<typeof renderToolSample>[0]["inputSchema"]>

	it("keeps the combined catalog a script starts with under its budget, and says which servers it left out", () => {
		const servers: ReadonlyArray<McpServerEntry> = Array.from({ length: 9 }, (_, server) => ({
			binding: {
				name: `s${server}`,
				url: `https://s${server}.mcp.example/mcp`,
				credential_id: null,
				vault_id: null,
			},
			tools: {
				status: "listed",
				tools: Array.from({ length: 30 }, (_, tool) => ({
					name: `tool_${tool}`,
					description: "d".repeat(8000),
					inputSchema: { type: "object", properties: { q: { type: "string" } } },
				})),
			},
		}))
		for (const { tools } of servers) {
			expect(new TextEncoder().encode(JSON.stringify(tools)).byteLength).toBeLessThan(
				MAX_TOOL_LIST_BYTES,
			)
		}
		const kept = withinCatalog(servers)
		const listedNow = kept.filter(({ tools }) => tools.status === "listed")
		const left = kept.filter(({ tools }) => tools.status === "unavailable")
		expect(listedNow.length).toBeGreaterThan(0)
		expect(left.length).toBeGreaterThan(0)
		expect(kept.map(({ tools }) => tools.status)).toEqual([
			...listedNow.map(() => "listed"),
			...left.map(() => "unavailable"),
		])
		const registry = mcpRegistry(kept)
		const dispatch = async (): Promise<McpCallOutcome> => ({
			ok: true,
			content: [],
			isError: false,
		})
		const extensions = kept.map(({ binding, tools }) =>
			mcpExtension(binding, tools, registry, dispatch),
		)
		const written = extensions
			.flatMap((extension) => extension.tools ?? [])
			.reduce((total, tool) => {
				const sample = renderToolSample({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.parameters as SampledSchema,
					outputSchema: (tool.structuredOutputSchema ?? { type: "string" }) as SampledSchema,
				})
				return (
					total +
					new TextEncoder().encode(
						JSON.stringify({
							name: tool.name,
							jsName: toCodemodeIdentifier(tool.name),
							description: sample,
						}),
					).byteLength
				)
			}, 0)
		expect(written).toBeLessThanOrEqual(MAX_TOOL_CATALOG_BYTES)
		for (const [index, { tools }] of kept.entries()) {
			if (tools.status === "unavailable") {
				expect(tools.reason).toContain("combined tool catalog is too large")
				expect(extensions[index]?.tools).toEqual([])
				expect(extensions[index]?.namespace?.description).toContain(
					"combined tool catalog is too large",
				)
			}
		}
	})

	it("gives a long or unusual tool name a stable alias the model can call", async () => {
		const long = `search_${"really_".repeat(12)}long_name`
		const dotted = "files.read"
		const registry = mcpRegistry(listed(long, dotted, "search", `${long}2`))
		for (const tool of [long, dotted]) {
			const alias = modelNameOf(registry, tool)
			expect(alias).toMatch(MODEL_TOOL_NAME)
			expect(alias.startsWith("mcp__docs__")).toBe(true)
			expect(modelNameOf(mcpRegistry(listed("other", tool)), tool)).toBe(alias)
		}
		expect(modelNameOf(registry, "search")).toBe("mcp__docs__search")
		expect(modelNameOf(registry, long)).not.toBe(modelNameOf(registry, `${long}2`))

		const alias = modelNameOf(registry, long)
		expect(registry.toolOf(alias)).toEqual({ server: "docs", tool: long, permission: "ask" })
		const called: Array<string> = []
		const extension = mcpExtension(
			binding,
			{ status: "listed", tools: [descriptor(long), descriptor("search")] },
			registry,
			async (_binding, tool) => {
				called.push(tool.name)
				return { ok: true, content: [{ type: "text", text: "found" }], isError: false }
			},
		)
		expect(extension.namespace?.name).toBe("docs")
		const registration = extension.tools?.find((tool) => tool.name === alias)
		expect(registration?.deferred).toBe(true)
		const result = await registration!.execute({}, {} as never, {} as never)
		expect(called).toEqual([long])
		expect(result).toMatchObject({ output: [{ type: "text", text: "found" }], isError: false })
	})

	it("keeps two tools apart that a script would spell the same, and names a tool with a long name within the log's bound", async () => {
		const endless = `report_${"x".repeat(400)}`
		const registry = mcpRegistry(listed("find-item", "find_item", "plain", endless, `${endless}y`))
		const names = [...registry.byName.values()].map((registered) => registered.names)
		expect(new Set(names.map((name) => name.model)).size).toBe(5)
		expect(new Set(names.map((name) => name.script)).size).toBe(5)
		expect(modelNameOf(registry, "plain")).toBe("mcp__docs__plain")
		expect(modelNameOf(registry, "find-item")).not.toBe("mcp__docs__find-item")
		expect(modelNameOf(registry, "find_item")).not.toBe("mcp__docs__find_item")
		const called: Array<string> = []
		const extension = mcpExtension(binding, listed()[0]!.tools, registry, async (_b, tool) => {
			called.push(tool.name)
			return { ok: true, content: [], isError: false }
		})
		for (const tool of ["find-item", "find_item"]) {
			const name = modelNameOf(registry, tool)
			expect(registry.toolOf(name)).toEqual({ server: "docs", tool, permission: "ask" })
			await extension.tools
				?.find((offered) => offered.name === name)
				?.execute({}, {} as never, {} as never)
		}
		expect(called).toEqual(["find-item", "find_item"])
		expect(new Set(names.map((name) => toCodemodeIdentifier(name.model))).size).toBe(5)
		const logged = [endless, `${endless}y`].map(
			(tool) => registry.toolOf(modelNameOf(registry, tool))?.tool ?? "",
		)
		expect(logged.every((name) => name.length <= MAX_PUBLIC_TOOL_NAME_LENGTH)).toBe(true)
		expect(new Set(logged).size).toBe(2)
	})

	it("names any tools so that no two share a model name, a script name or a public name, whatever their order", () => {
		const name = fc.oneof(
			fc.constantFrom(
				"find-item",
				"find_item",
				"find.item",
				"",
				"a",
				"9lives",
				"é",
				"x".repeat(300),
			),
			fc.string({ maxLength: 12 }),
			fc.string({ minLength: 250, maxLength: 270 }),
		)
		const tool = fc.record({
			prefix: fc.constantFrom("", "mcp__docs__", "mcp__my-docs__", "mcp__my_docs__"),
			name,
		})
		fc.assert(
			fc.property(fc.array(tool, { maxLength: 24 }), (tools) => {
				const named = assignToolNames(tools)
				const distinct = new Set(tools.map((given) => JSON.stringify([given.prefix, given.name])))
				expect(named).toHaveLength(distinct.size)
				expect(new Set(named.map((names) => names.model)).size).toBe(named.length)
				expect(new Set(named.map((names) => names.script)).size).toBe(named.length)
				expect(
					new Set(named.map((names) => JSON.stringify([names.prefix, names.public]))).size,
				).toBe(named.length)
				for (const names of named) {
					expect(names.model).toMatch(MODEL_TOOL_NAME)
					expect(names.script).toBe(toCodemodeIdentifier(names.model))
					expect(names.public.length).toBeGreaterThan(0)
					expect(names.public.length).toBeLessThanOrEqual(MAX_PUBLIC_TOOL_NAME_LENGTH)
				}
				const byTool = (all: ReadonlyArray<ToolNames>) =>
					new Map(all.map((names) => [JSON.stringify([names.prefix, names.name]), names]))
				expect(byTool(assignToolNames(tools.toReversed()))).toEqual(byTool(named))
			}),
		)
	})

	it("lets every custom tool keep its name, and gives way to it whatever else is offered", () => {
		const custom = fc.record({
			prefix: fc.constant(""),
			name: fc.oneof(
				fc.constantFrom("find-item", "find_item", "mcp-_docs__find", "lookup"),
				fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/u).filter((name) => !name.startsWith("mcp__")),
			),
			kept: fc.constant(true),
		})
		const server = fc.record({
			prefix: fc.constantFrom("mcp__docs__", "mcp__my-docs__"),
			name: fc.oneof(
				fc.constantFrom("find", "find-item", "find_item", "x".repeat(300)),
				fc.string({ maxLength: 12 }),
			),
		})
		fc.assert(
			fc.property(
				fc.uniqueArray(custom, {
					maxLength: 8,
					selector: (tool) => toCodemodeIdentifier(tool.name),
				}),
				fc.array(server, { maxLength: 16 }),
				(customs, servers) => {
					const named = assignToolNames([...servers, ...customs])
					const kept = named.filter((names) => names.kept === true)
					expect(kept.map((names) => names.model).toSorted()).toEqual(
						customs.map((tool) => tool.name).toSorted(),
					)
					for (const names of kept) {
						expect(names.public).toBe(names.name)
					}
					expect(new Set(named.map((names) => names.model)).size).toBe(named.length)
					expect(new Set(named.map((names) => names.script)).size).toBe(named.length)
					const byTool = (all: ReadonlyArray<ToolNames>) =>
						new Map(all.map((names) => [JSON.stringify([names.prefix, names.name]), names]))
					expect(byTool(assignToolNames([...customs, ...servers].toReversed()))).toEqual(
						byTool(named),
					)
				},
			),
		)
	})

	it("names a server's tool apart from a custom tool a script would spell the same", () => {
		const tools = { status: "listed" as const, tools: [descriptor("find")] }
		const plain = mcpRegistry([{ binding, tools }])
		expect([...plain.byName.keys()]).toEqual(["mcp__docs__find"])
		const beside = mcpRegistry(
			[{ binding, tools }],
			[
				{
					type: "custom",
					name: "mcp-_docs__find",
					description: "The caller's own",
					input_schema: { type: "object" },
				},
			],
		)
		const [name] = [...beside.byName.keys()]
		expect(name).not.toBe("mcp__docs__find")
		expect(toCodemodeIdentifier(name ?? "")).not.toBe(toCodemodeIdentifier("mcp-_docs__find"))
		expect(beside.toolOf(name ?? "")).toMatchObject({ server: "docs", tool: "find" })
	})

	it("gives the model a result that came only as a structured value, and a script the value itself", async () => {
		const value = { rows: [{ id: 1 }], total: 1 }
		const run = async (tool: McpToolDescriptor, outcome: McpCallOutcome) => {
			const tools = { status: "listed" as const, tools: [tool] }
			const registry = mcpRegistry([{ binding, tools }])
			const [registration] = mcpExtension(binding, tools, registry, async () => outcome).tools ?? []
			return registration!.execute({}, {} as never, {} as never)
		}
		const only = { ok: true as const, content: [], structuredContent: value, isError: false }
		expect(await run(descriptor("lookup"), only)).toEqual({
			output: [{ type: "text", text: JSON.stringify(value) }],
			isError: false,
		})
		expect(await run({ ...descriptor("lookup"), outputSchema: { type: "object" } }, only)).toEqual({
			output: [{ type: "text", text: JSON.stringify(value) }],
			isError: false,
			structuredOutput: value,
		})
		expect(
			await run(descriptor("lookup"), {
				...only,
				content: [{ type: "text", text: "one row" }],
			}),
		).toMatchObject({ output: [{ type: "text", text: "one row" }] })
		const huge = await run(descriptor("lookup"), {
			...only,
			structuredContent: { text: "x".repeat(MODEL_TEXT_LIMITS.maxBytes * 2) },
		})
		const [block] = "output" in huge ? (huge.output ?? []) : []
		expect(block?.type === "text" && block.text.length).toBeLessThan(MODEL_TEXT_LIMITS.maxBytes * 2)
		const dropped = await run(
			{ ...descriptor("lookup"), outputSchema: { type: "object" } },
			{ ok: true, content: [{ type: "text", text: "left out" }], isError: true },
		)
		expect(dropped).toEqual({ output: [{ type: "text", text: "left out" }], isError: true })
	})

	it("tells the model why a server's tools are missing, without hiding the other servers'", () => {
		const other = {
			name: "files",
			url: "https://files.mcp.example/mcp",
			credential_id: null,
			vault_id: null,
		}
		const servers = [
			{
				binding,
				tools: { status: "unavailable" as const, reason: "its tool list is too large" },
			},
			{ binding: other, tools: { status: "listed" as const, tools: [descriptor("read")] } },
		]
		const registry = mcpRegistry(servers)
		const [docs, files] = servers.map((server) =>
			mcpExtension(server.binding, server.tools, registry, async () => ({
				ok: false,
				message: "unused",
			})),
		)
		expect(docs?.tools).toEqual([])
		expect(docs?.namespace?.description).toContain("its tool list is too large")
		expect(files?.tools?.map((tool) => tool.name)).toEqual(["mcp__files__read"])
	})
})
