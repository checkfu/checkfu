import type { EnvironmentNetworking } from "@checkfu/domain/Environment/EnvironmentTypes"
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import fc from "fast-check"
import { REDACTED, scrubValue, secretForms } from "../src/Connection/Scrub.ts"
import { makeSecretCustody } from "../src/Connection/SecretCustody.ts"
import { makeVaultConnection, makeVaultMcp } from "../src/Connection/VaultMcp.ts"
import type { VaultMcp } from "../src/Connection/VaultMcp.ts"
import { MAX_TOOL_LIST_BYTES, mcpExtension, mcpRegistry } from "../src/Pi/PiMcp.ts"
import { MODEL_TEXT_LIMITS } from "../src/Pi/PiToolText.ts"
import { connectMcp, describeMcpFailure } from "../src/Pi/PiMcpClient.ts"
import { makeSessionMcp, vaultsOver } from "../src/Pi/PiMcpSession.ts"
import type { SessionMcp, SessionVaults } from "../src/Pi/PiMcpSession.ts"
import {
	MAX_MCP_RESPONSE_BYTES,
	MCP_CREDENTIAL_EMPTY,
	MCP_CREDENTIAL_ENDED,
	McpCall,
	McpCallOutcome,
	McpListOutcome,
	mcpCallScope,
} from "../src/Pi/PiMcpTypes.ts"
import type { McpToolDescriptor } from "../src/Pi/PiMcpTypes.ts"
import { startFakeMcpServer } from "./workerd/FakeMcpServer.ts"
import { makeCustodyDatabase } from "./helpers/CustodyDatabase.ts"
import { startScriptedMcpServer } from "./workerd/ScriptedMcpServer.ts"

const TOKEN = "tok/live+SECRET&do not=leak"
const URL_ = "https://docs.mcp.example/mcp"

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})

const within = <A>(work: Promise<A>, ms = 5000) =>
	Promise.race([work, sleep(ms).then(() => "still waiting" as const)])

const spellings = (secret: string) => [
	secret,
	encodeURIComponent(secret),
	new URLSearchParams({ s: secret }).toString().slice(2),
	JSON.stringify(secret).slice(1, -1),
	JSON.stringify(secret)
		.slice(1, -1)
		.replaceAll("/", String.raw`\/`),
]

type Stored = Record<string, { readonly target: string; readonly token: string } | "empty">

const custodyOf = (stored: Stored) => ({
	read: (credentialId: string) => {
		const kept = stored[credentialId]
		return kept === undefined || kept === "empty"
			? null
			: { secret: { type: "static_bearer" as const, token: kept.token }, target: kept.target }
	},
	ended: (credentialId: string) => stored[credentialId] === undefined,
})

const echo: McpToolDescriptor = {
	name: "echo",
	description: "Echo a text back.",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
}
const leak: McpToolDescriptor = { ...echo, name: "leak" }

const asCall = Schema.decodeUnknownSync(McpCallOutcome)
const asList = Schema.decodeUnknownSync(McpListOutcome)
const asJson = Schema.decodeUnknownSync(Schema.Json)

describe("The scrubber", () => {
	const visible = fc
		.array(
			fc.integer({ min: 0x21, max: 0x7e }).map((code) => String.fromCodePoint(code)),
			{ minLength: 8, maxLength: 20 },
		)
		.map((characters) => characters.join(""))
	const digits = fc
		.array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 24 })
		.map((numbers) => numbers.join(""))
	const token = fc.oneof(
		visible,
		digits,
		fc.constantFrom("redacted", "[redacted]", "*****" + "***"),
	)

	it("leaves no spelling of any token in what is written of any value", () => {
		fc.assert(
			fc.property(
				token,
				fc.jsonValue(),
				fc.array(fc.tuple(fc.nat(8), fc.string(), fc.string()), { maxLength: 6 }),
				(secret, value, leaks) => {
					const forms = secretForms(secret)
					const spelled = leaks.map(
						([form, before, after]) => `${before}${forms[form % forms.length] ?? ""}${after}`,
					)
					const scrubbed = scrubValue([secret])({
						value: asJson(value),
						spelled,
						keyed: Object.fromEntries(spelled.map((text, index) => [text, index])),
						apart: [secret.slice(0, 4), secret.slice(4)],
						numbers: [Number(secret), Number(`${secret}0`)].filter(Number.isFinite),
						nested: JSON.stringify({ deeper: JSON.stringify(spelled) }),
					})
					const written = JSON.stringify(scrubbed)
					for (const form of forms) {
						expect(written).not.toContain(form)
					}
				},
			),
			{ numRuns: 400 },
		)
	})

	it("returns a value that spells no token as it came", () => {
		fc.assert(
			fc.property(visible, fc.jsonValue(), (secret, value) => {
				const written = JSON.stringify(value)
				fc.pre(!Number.isFinite(Number(secret)))
				fc.pre(secretForms(secret).every((form) => !written.includes(form)))
				expect(JSON.stringify(scrubValue([secret])(asJson(value)))).toBe(written)
			}),
		)
	})

	it("redacts a number that reads as a token of digits, in any notation and at any length", () => {
		expect(JSON.stringify(scrubValue(["12300000"])(JSON.parse("[1.23e7, 7]")))).toBe(
			`["${REDACTED}",7]`,
		)
		const long = "12345678901234567890123"
		expect(JSON.stringify(scrubValue([long])(JSON.parse(`{"n":${long}}`)))).toBe(
			`{"n":"${REDACTED}"}`,
		)
		expect(JSON.stringify(scrubValue(["4815162342"])({ other: 48_151_623_420 }))).toBe(
			`{"other":"${REDACTED}0"}`,
		)
	})

	it("uses a mark that spells no token, and drops what only the document's own punctuation spells", () => {
		expect(scrubValue(["redacted"])("a redacted b")).toBe("a ***** b")
		expect(scrubValue(['abc","de'])(["abc", "de"])).toBe(REDACTED)
		expect(scrubValue([String.raw`a\\b12345`])(String.raw`a\b12345`)).toBe(REDACTED)
	})
})

describe("A vault speaking MCP", () => {
	const closing: Array<{ readonly close: () => Promise<void> }> = []
	afterEach(async () => {
		await Promise.all(closing.splice(0).map((server) => server.close()))
	})
	const scripted = async (options: Parameters<typeof startScriptedMcpServer>[0] = {}) => {
		const server = await startScriptedMcpServer(options)
		closing.push(server)
		return server
	}
	let calls = 0
	const callId = () => `call-${(calls += 1)}`

	it("sends only to the stored URL, with the stored token and MCP's own headers, following no redirect", async () => {
		const seen: Array<{ url: string; init: RequestInit }> = []
		const fetchFn = (async (url: string, init: RequestInit) => {
			seen.push({ url, init })
			return new Response(null, { status: 302, headers: { location: "https://evil.example/" } })
		}) as typeof fetch
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: URL_, token: TOKEN } }), fetchFn)
		expect(
			asCall(await vault.call("cred_1", "s", "https://evil.example/mcp", echo, {}, callId())),
		).toMatchObject({ ok: false, message: expect.stringContaining("different MCP server") })
		expect(seen).toEqual([])
		expect(asCall(await vault.call("cred_1", "s", URL_, echo, {}, callId())).ok).toBe(false)
		expect(seen.length).toBeGreaterThan(0)
		expect(seen.every((sent) => sent.url === URL_)).toBe(true)
		for (const { init } of seen) {
			const headers = new Headers(init.headers)
			expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
			expect(headers.get("mcp-protocol-version")).not.toBeNull()
			expect(headers.get("cookie")).toBeNull()
			expect(init.redirect).toBe("manual")
			expect(init.signal).toBeInstanceOf(AbortSignal)
		}
	})

	it("connects again with the new token once a credential's token is replaced", async () => {
		const server = await scripted()
		const custody = makeSecretCustody(makeCustodyDatabase().sql)
		const vault = makeVaultMcp(custody)
		const connection = makeVaultConnection(custody, vault)
		const ROTATED = "tok_rotated_SECRET_9f8e"
		await connection.put("cred_1", { type: "static_bearer", token: TOKEN }, server.url, "create")
		expect(
			asCall(await within(vault.call("cred_1", "s", server.url, echo, {}, callId()))),
		).toMatchObject({
			ok: true,
		})
		expect(server.methods.filter((method) => method === "initialize")).toHaveLength(1)
		await connection.put("cred_1", { type: "static_bearer", token: ROTATED }, server.url, "replace")
		expect(
			asCall(await within(vault.call("cred_1", "s", server.url, echo, {}, callId()))),
		).toMatchObject({
			ok: true,
		})
		expect(server.methods.filter((method) => method === "initialize")).toHaveLength(2)
		expect(server.tokens.at(-1)).toBe(ROTATED)
	})

	it("removes every spelling of the token from a result, its structured content, its keys and an error", async () => {
		for (const stream of [undefined, "held"] as const) {
			const server = await scripted(stream === undefined ? {} : { stream })
			const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
			const answer = await within(vault.call("cred_1", "s", server.url, leak, {}, callId()))
			expect(asCall(answer)).toMatchObject({ ok: true, isError: false })
			expect(server.tokens.at(-1)).toBe(TOKEN)
			const all = JSON.stringify(answer)
			for (const form of spellings(TOKEN)) {
				expect(all).not.toContain(form)
			}
			expect(all).toContain(REDACTED)
		}

		const failing = (async () => {
			throw new Error(`connect ${TOKEN} refused`)
		}) as typeof fetch
		const failed = await makeVaultMcp(
			custodyOf({ cred_1: { target: URL_, token: TOKEN } }),
			failing,
		).call("cred_1", "s", URL_, echo, {}, callId())
		expect(asCall(failed).ok).toBe(false)
		expect(JSON.stringify(failed)).not.toContain(TOKEN)
	})

	it("redacts a token of digits that comes back as a number, and still reads the answer it belongs to", async () => {
		const numeric = "4815162342"
		const server = await scripted({ stream: "held" })
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: numeric } }))
		const answer = asCall(await within(vault.call("cred_1", "s", server.url, leak, {}, callId())))
		expect(answer).toMatchObject({ ok: true })
		expect(JSON.stringify(answer)).not.toContain(numeric)
		expect(answer.ok && answer.structuredContent).toMatchObject({ number: REDACTED })
	})

	it("reports a structured result past the limit as an error that says the tool ran, keeping none of it", async () => {
		const server = await scripted()
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
		const typed = { ...echo, name: "huge", outputSchema: { type: "object" } }
		const answer = asCall(await within(vault.call("cred_1", "s", server.url, typed, {}, callId())))
		expect(answer).toMatchObject({
			ok: true,
			isError: true,
			content: [
				{ type: "text", text: expect.stringContaining("The tool ran, but its structured result") },
				{ type: "text", text: "a large table" },
			],
		})
		expect(answer.ok && "structuredContent" in answer).toBe(false)
	})

	it("keeps supported images with their canonical media type and explains the ones left out", async () => {
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k8noAAAAASUVORK5CYII="
		const server = await scripted({
			callContent: [
				{ type: "image", mimeType: "image/png", data: png },
				{ type: "image", mimeType: "IMAGE/PNG; name=chart", data: png },
				{ type: "image", mimeType: "image/svg+xml", data: btoa("<svg/>") },
			],
		})
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
		expect(
			asCall(await within(vault.call("cred_1", "s", server.url, echo, {}, callId()))),
		).toMatchObject({
			ok: true,
			content: [
				{ type: "image", mimeType: "image/png", data: png },
				{ type: "image", mimeType: "image/png", data: png },
				{ type: "text", text: expect.stringContaining("image/svg+xml image left out") },
			],
		})
	})

	it.each([false, true])("carries resource links in result order (mixed: %s)", async (mixed) => {
		const link = {
			type: "resource_link",
			name: "Quarterly report",
			uri: "report://archive/2026-q3",
			mimeType: "text/markdown",
		}
		const before = { type: "text", text: "Found one report." }
		const after = { type: "text", text: "End of results." }
		const server = await scripted({ callContent: mixed ? [before, link, after] : [link] })
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
		const answer = asCall(await within(vault.call("cred_1", "s", server.url, echo, {}, callId())))
		const rendered = { type: "text", text: JSON.stringify(link) }

		expect(answer).toMatchObject({
			ok: true,
			isError: false,
			content: mixed ? [before, rendered, after] : [rendered],
		})
		expect(server.methods.filter((method) => method.startsWith("resources/"))).toEqual([])
	})

	it("scrubs and bounds a resource link before the model sees it", async () => {
		const encoded = encodeURIComponent(TOKEN)
		const server = await scripted({
			callContent: [
				{
					type: "resource_link",
					name: `Report ${TOKEN}`,
					uri: `report://archive/${encoded}/${"x".repeat(MODEL_TEXT_LIMITS.maxBytes)}`,
				},
			],
		})
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
		const binding = { name: "docs", url: server.url, credential_id: "cred_1", vault_id: "vault_1" }
		const tools = { status: "listed" as const, tools: [echo] }
		const registry = mcpRegistry([{ binding, tools }])
		const [registration] =
			mcpExtension(binding, tools, registry, async () => {
				const outcome = asCall(await vault.call("cred_1", "s", server.url, echo, {}, callId()))
				const raw = JSON.stringify(outcome)
				expect(raw).not.toContain(TOKEN)
				expect(raw).not.toContain(encoded)
				expect(raw).toContain(REDACTED)
				return outcome
			}).tools ?? []
		if (registration === undefined) {
			throw new Error("The MCP tool was not registered")
		}
		const result = await registration.execute({}, {} as never, {} as never)
		expect(result).toMatchObject({
			output: [{ type: "text", text: expect.stringContaining("left out") }],
			isError: false,
		})
		const visible = JSON.stringify(result)
		expect(new TextEncoder().encode(visible).byteLength).toBeLessThan(MODEL_TEXT_LIMITS.maxBytes)
		expect(visible).not.toContain(TOKEN)
		expect(visible).not.toContain(encoded)
		expect(server.methods.filter((method) => method.startsWith("resources/"))).toEqual([])
	})

	it("answers from an event stream the server never closes, with its data in pieces between other lines", async () => {
		const server = await scripted({ stream: "held" })
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
		expect(
			asCall(await within(vault.call("cred_1", "s", server.url, echo, { text: "hi" }, callId()))),
		).toMatchObject({ ok: true, content: [{ type: "text", text: "echo:hi:scripted-1" }] })
	})

	it("answers a request the server makes of it during a call, and then gets the call's answer", async () => {
		const server = await scripted({ stream: "ping" })
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
		expect(
			asCall(await within(vault.call("cred_1", "s", server.url, echo, { text: "hi" }, callId()))),
		).toMatchObject({ ok: true, content: [{ type: "text", text: "echo:hi:scripted-1" }] })
	})

	it("does not speak to a server that offers only a protocol older than 2025-11-25, and says the request failed", async () => {
		const server = await scripted({ protocolVersion: "2025-06-18" })
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
		expect(
			asList(await within(vault.list("cred_1", "s", server.url, MAX_TOOL_LIST_BYTES, callId()))),
		).toMatchObject({ ok: false, message: expect.stringContaining("protocol version") })
		expect(server.methods).not.toContain("tools/list")
	})

	it("stops reading past what the call may read, and says the answer was too large", async () => {
		const pageBytes = 64 * 1024
		const huge = await scripted({ pages: 40, pageBytes })
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: huge.url, token: TOKEN } }))
		expect(
			asList(await vault.list("cred_1", "s", huge.url, MAX_TOOL_LIST_BYTES, callId())),
		).toMatchObject({ ok: false, tooLarge: true })
		expect(huge.methods.filter((method) => method === "tools/list").length).toBeLessThanOrEqual(
			Math.ceil(MAX_TOOL_LIST_BYTES / pageBytes) + 1,
		)

		const endless = (async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull: (controller) => {
						controller.enqueue(new TextEncoder().encode(`: ${"x".repeat(65_536)}\n\n`))
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch
		const flooded = asCall(
			await within(
				makeVaultMcp(custodyOf({ cred_1: { target: URL_, token: TOKEN } }), endless).call(
					"cred_1",
					"s",
					URL_,
					echo,
					{},
					callId(),
				),
			),
		)
		expect(flooded).toMatchObject({
			ok: false,
			tooLarge: true,
			message: expect.stringContaining(String(MAX_MCP_RESPONSE_BYTES)),
		})
	})

	it("sends nothing more for a call its session gave up on, whether the word comes during it or before it", async () => {
		const server = await scripted()
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
		const release = server.holdHandshakes()
		const during = callId()
		const calling = vault.call("cred_1", "s", server.url, echo, { text: "never" }, during)
		while (!server.methods.includes("initialize")) {
			await sleep(5)
		}
		vault.cancel(during)
		expect(asCall(await within(calling))).toMatchObject({ ok: false, interrupted: true })
		release()
		await sleep(50)
		expect(server.methods).not.toContain("tools/call")

		const before = callId()
		const sent = server.methods.length
		vault.cancel(before)
		expect(
			asCall(await vault.call("cred_1", "other", server.url, echo, { text: "never" }, before)),
		).toMatchObject({ ok: false, interrupted: true })
		expect(server.methods.slice(sent)).not.toContain("tools/call")
	})

	it("reads the secret as each request leaves: a rotation is used at once, and an erase stops the next request", async () => {
		const server = await scripted()
		let kept: { readonly token: string } | "empty" | "ended" = { token: TOKEN }
		const vault = makeVaultMcp({
			read: () =>
				typeof kept === "string"
					? null
					: { secret: { type: "static_bearer", token: kept.token }, target: server.url },
			ended: () => kept === "ended",
		})
		const call = async () =>
			asCall(await vault.call("cred_1", "s", server.url, echo, { text: "x" }, callId()))
		expect(await call()).toMatchObject({ ok: true })
		kept = { token: "tok_rotated_SECRET" }
		expect(await call()).toMatchObject({ ok: true })
		expect(server.tokens.at(-1)).toBe("tok_rotated_SECRET")
		expect(server.methods.filter((method) => method === "initialize")).toHaveLength(1)

		const sent = server.tokens.length
		kept = "empty"
		expect(await call()).toMatchObject({
			ok: false,
			message: expect.stringContaining("holds no secret"),
		})
		kept = "ended"
		await vault.drop("cred_1")
		expect(await call()).toMatchObject({
			ok: false,
			message: expect.stringContaining("archived or deleted"),
		})
		expect(server.tokens.length).toBe(sent)
	})
})

describe("A session's MCP servers", () => {
	const closing: Array<{ readonly close: () => Promise<void> }> = []
	afterEach(async () => {
		await Promise.all(closing.splice(0).map((server) => server.close()))
	})
	const real = async (options: Parameters<typeof startFakeMcpServer>[1] = {}) => {
		const server = await startFakeMcpServer([TOKEN], options)
		closing.push(server)
		return server
	}
	const scripted = async (options: Parameters<typeof startScriptedMcpServer>[0] = {}) => {
		const server = await startScriptedMcpServer(options)
		closing.push(server)
		return server
	}

	let sessions = 0
	const session = (
		stored: Record<string, string>,
		kv = new Map<string, string>(),
		state = { turn: 1 },
		vault: VaultMcp = makeVaultMcp(
			custodyOf(
				Object.fromEntries(
					Object.entries(stored).map(([credential, target]) => [
						credential,
						target === "empty" ? ("empty" as const) : { target, token: TOKEN },
					]),
				),
			),
		),
	) => {
		const vaultsAsked: Array<string> = []
		const mcp = makeSessionMcp({
			kv: { get: (key) => kv.get(key), put: (key, value) => kv.set(key, value) },
			vaults: vaultsOver(
				(vaultId) => {
					vaultsAsked.push(vaultId)
					return {
						mcpList: (...asked) => vault.list(...asked),
						mcpCall: (...asked) => vault.call(...asked),
						mcpCancel: async (id) => vault.cancel(id),
					}
				},
				`session-${(sessions += 1)}`,
				async () => "held",
			),
			admittedTurn: () => state.turn,
			agentTools: () => [],
		})
		const call = async (name: string, args: Schema.JsonObject, signal?: AbortSignal) => {
			const tool = mcp
				.extensions()
				.flatMap((extension) => extension.tools ?? [])
				.find((registered) => registered.name === name)
			expect(tool, name).toBeDefined()
			return tool!.execute(args, {} as never, { abortSignal: signal } as never)
		}
		const describe = (server: string): string =>
			mcp.extensions().find((extension) => extension.namespace?.name === server)?.namespace
				?.description ?? ""
		return { mcp, call, describe, kv, state, vaultsAsked }
	}
	it.each([
		["ended", MCP_CREDENTIAL_ENDED],
		["empty", MCP_CREDENTIAL_EMPTY],
	] as const)(
		"refuses a credential with %s access before contacting its connection",
		async (access, message) => {
			const denied = vaultsOver(
				() => {
					throw new Error("The connection must not be contacted")
				},
				"session",
				async () => access,
			)
			const result = await denied.list("vault", "credential", "https://mcp.example", 1, undefined)
			expect(result).toEqual({ ok: false, message })
		},
	)

	it("interrupts a credential request even while its authorization is waiting", async () => {
		const controller = new AbortController()
		const authorization = Promise.withResolvers<"held">()
		let connected = false
		const vaults = vaultsOver(
			() => {
				connected = true
				throw new Error("The connection must not be contacted")
			},
			"session",
			() => authorization.promise,
		)
		const listing = vaults.list("vault", "credential", "https://mcp.example", 1, controller.signal)
		controller.abort()
		expect(await listing).toMatchObject({ ok: false, interrupted: true })
		authorization.resolve("held")
		await authorization.promise
		expect(connected).toBe(false)
	})

	const turn = (
		servers: ReadonlyArray<{
			name: string
			url: string
			credential_id: string | null
			vault_id: string | null
		}>,
		networking: EnvironmentNetworking | null = null,
	) => ({ servers, networking })
	const prepare = async (mcp: SessionMcp, brought: ReturnType<typeof turn>, number = 1) => {
		expect(mcp.publish(number, brought)).toBe(true)
		await mcp.discover(number)
	}

	const failedDiscovery = (
		durationMs: number,
		message: string,
		list?: (attempt: number, signal: AbortSignal | undefined) => Promise<McpListOutcome>,
		listTimeoutMs?: number,
	) => {
		const kv = new Map<string, string>()
		const time = { now: 0, attempts: 0 }
		let turnNumber = 1
		const mcp = makeSessionMcp({
			kv: { get: (key) => kv.get(key), put: (key, value) => kv.set(key, value) },
			vaults: {
				list: async (_vault, _credential, _url, _limit, signal) => {
					time.attempts += 1
					time.now += durationMs
					return list === undefined ? { ok: false, message } : list(time.attempts, signal)
				},
				call: async () => {
					throw new Error("unexpected tool call")
				},
			},
			admittedTurn: () => turnNumber,
			agentTools: () => [],
			now: () => time.now,
			...(listTimeoutMs === undefined ? {} : { listTimeoutMs }),
		})
		const brought = turn([{ name: "docs", url: URL_, credential_id: "cred_1", vault_id: "vlt_1" }])
		return {
			mcp,
			time,
			discover: (number: number) => {
				turnNumber = number
				return prepare(mcp, brought, number)
			},
		}
	}

	it("refreshes tool descriptors on the first eligible new turn, including an empty catalog", async () => {
		const stored = new Map<string, string>()
		const binding = { name: "docs", url: URL_, credential_id: "cred_1", vault_id: "vlt_1" }
		let currentTurn = 1
		let clock = 0
		let attempts = 0
		let outcome: McpListOutcome = { ok: true, tools: [echo] }
		const called: Array<string> = []
		const open = () =>
			makeSessionMcp({
				kv: { get: (key) => stored.get(key), put: (key, value) => stored.set(key, value) },
				now: () => clock,
				admittedTurn: () => currentTurn,
				agentTools: () => [],
				vaults: {
					list: async () => {
						attempts++
						return outcome
					},
					call: async (_vault, _credential, _url, tool) => {
						called.push(tool.name)
						return { ok: true, content: [], isError: false }
					},
				},
			})
		let mcp = open()
		const admit = (number: number, credential = binding.credential_id) => {
			currentTurn = number
			return prepare(mcp, turn([{ ...binding, credential_id: credential }]), number)
		}
		const offered = () => mcp.extensions().flatMap((extension) => extension.tools ?? [])
		await admit(1)
		expect(offered().map((tool) => tool.name)).toEqual(["mcp__docs__echo"])
		outcome = {
			ok: true,
			tools: [
				{
					...echo,
					name: "changed",
					inputSchema: { type: "object", properties: { count: { type: "number" } } },
				},
			],
		}
		clock = 299_999
		await admit(2)
		mcp = open()
		clock++
		await admit(2)
		expect([attempts, offered()[0]?.name]).toEqual([1, "mcp__docs__echo"])
		await admit(3)
		const tools = offered()
		expect(tools.map((tool) => tool.name)).toEqual(["mcp__docs__changed"])
		expect(tools[0]?.parameters).toMatchObject({ properties: { count: { type: "number" } } })
		await tools[0]!.execute({ count: 1 }, {} as never, {} as never)
		expect(called).toEqual(["changed"])
		expect(attempts).toBe(2)
		outcome = { ok: true, tools: [] }
		clock += 300_000
		await admit(4)
		expect(offered()).toEqual([])
		outcome = { ok: true, tools: [echo] }
		clock += 300_000
		await admit(5)
		expect(offered()[0]?.name).toBe("mcp__docs__echo")
		outcome = { ok: false, message: MCP_CREDENTIAL_ENDED }
		await admit(6, "cred_rotated")
		expect(offered()).toEqual([])
		expect(mcp.extensions()[0]?.namespace?.description).toContain(MCP_CREDENTIAL_ENDED)
		outcome = { ok: false, tooLarge: true, message: "oversized" }
		await admit(7, "cred_rotated")
		expect(mcp.extensions()[0]?.namespace?.description).toContain("more than")
		expect(offered()).toEqual([])
		outcome = { ok: true, tools: [echo] }
		const attemptsAfterRefusal = attempts
		clock += 299_999
		await admit(8, "cred_rotated")
		clock++
		await admit(8, "cred_rotated")
		expect(attempts).toBe(attemptsAfterRefusal)
		expect(offered()).toEqual([])
		await admit(9, "cred_rotated")
		expect(attempts).toBe(attemptsAfterRefusal + 1)
		expect(offered()[0]?.name).toBe("mcp__docs__echo")
	})

	it("bounds the listing failure shown in a tool namespace", async () => {
		const { mcp, discover } = failedDiscovery(0, "Credential was refused: " + "x".repeat(5000))
		await discover(1)
		const description = mcp.extensions().at(0)?.namespace?.description ?? ""
		expect(description).toContain("its tools could not be listed (Credential was refused:")
		expect(description.length).toBeLessThan(600)
	})

	it("waits five minutes after a slow listing fails before asking again", async () => {
		const { mcp, time, discover } = failedDiscovery(6000, "The server could not be reached.")
		await discover(1)
		time.now += 10_000
		expect(mcp.undiscovered()).toBe(false)
		await discover(2)
		expect(time.attempts).toBe(1)
		time.now += 289_999
		expect(mcp.undiscovered()).toBe(false)
		time.now += 1
		await discover(2)
		expect(time.attempts).toBe(1)
		await discover(3)
		expect(time.attempts).toBe(2)
	})

	it("retries a fast listing failure on the next turn", async () => {
		const { mcp, time, discover } = failedDiscovery(0, "The server could not be reached.")
		await discover(1)
		expect(mcp.undiscovered()).toBe(false)
		await discover(1)
		expect(time.attempts).toBe(1)
		await discover(2)
		expect(time.attempts).toBe(2)
	})

	it("stops waiting and signals cancellation when a vault listing does not settle", async () => {
		const held = Promise.withResolvers<McpListOutcome>()
		let deadline: AbortSignal | undefined
		const { mcp, discover } = failedDiscovery(
			0,
			"",
			async (_attempt, signal) => {
				deadline = signal
				return held.promise
			},
			100,
		)
		try {
			await discover(1)
			expect(deadline?.aborted).toBe(true)
			expect(mcp.extensions().at(0)?.namespace?.description).toContain("within 0.1 seconds")
		} finally {
			held.resolve({ ok: false, message: "Too late" })
		}
	})

	it("ignores a slow listing failure from a superseded turn", async () => {
		const old = Promise.withResolvers<McpListOutcome>()
		const { mcp, time, discover } = failedDiscovery(0, "", async (attempt) =>
			attempt === 1 ? old.promise : { ok: false, message: "Failed quickly" },
		)
		const first = discover(1)
		time.now += 6000
		await discover(2)
		old.resolve({ ok: false, message: "Failed slowly" })
		await first
		expect(time.attempts).toBe(2)
		expect(mcp.undiscovered()).toBe(false)
		expect(mcp.extensions().at(0)?.namespace?.description).toContain("Failed quickly")
		await discover(3)
		expect(time.attempts).toBe(3)
	})

	it("lets a cancelled admission leave an overlapping catalog request", async () => {
		const reply = Promise.withResolvers<McpListOutcome>()
		const { mcp, discover, time } = failedDiscovery(0, "", async () => reply.promise)
		const first = discover(1)
		const cancelled = new AbortController()
		const duplicate = mcp.discover(1, cancelled.signal)
		cancelled.abort()
		try {
			await duplicate
			expect(time.attempts).toBe(1)
		} finally {
			reply.resolve({ ok: true, tools: [echo] })
			await first
		}
		expect(mcp.extensions()[0]?.tools?.[0]?.name).toBe("mcp__docs__echo")
	})

	it("shares an overlapping listing and keeps the slow failure cooldown", async () => {
		const first = Promise.withResolvers<McpListOutcome>()
		const { mcp, time, discover } = failedDiscovery(0, "", async () => first.promise)
		const slow = discover(1)
		time.now += 6000
		const fast = discover(1)
		first.resolve({ ok: false, message: "Failed slowly" })
		await slow
		await fast
		expect(time.attempts).toBe(1)
		expect(mcp.undiscovered()).toBe(false)
		expect(mcp.extensions().at(0)?.namespace?.description).toContain("Failed slowly")
	})

	it("gives each session its own upstream MCP session in the vault they share, and one handshake within a session", async () => {
		const server = await real({ stateful: true })
		const servers = [{ name: "docs", url: server.url, credential_id: "cred_1", vault_id: "vlt_1" }]
		const vault = makeVaultMcp(custodyOf({ cred_1: { target: server.url, token: TOKEN } }))
		const first = session({}, undefined, undefined, vault)
		const second = session({}, undefined, undefined, vault)
		await Promise.all([prepare(first.mcp, turn(servers)), prepare(second.mcp, turn(servers))])
		await Promise.all([
			first.call("mcp__docs__echo", { text: "hi" }),
			first.call("mcp__docs__echo", { text: "hi" }),
			second.call("mcp__docs__echo", { text: "hi" }),
		])
		expect(new Set(server.calls.map((c) => c.session)).size).toBe(2)
		expect(server.sessions()).toBe(2)
		expect(server.calls.every((c) => c.token === TOKEN)).toBe(true)
	})

	it.effect("passes a rate limit through instead of trying the legacy protocol", () =>
		Effect.gen(function* () {
			const sent: Array<string> = []
			const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
				sent.push(typeof init?.body === "string" ? init.body : "")
				return new Response("slow down", { status: 429, headers: { "retry-after": "30" } })
			}) as typeof fetch
			const error = yield* Effect.flip(
				connectMcp("https://docs.mcp.example/mcp", () => ({ token: null }), fetchFn).pipe(
					Effect.scoped,
					Effect.provideService(McpCall, mcpCallScope(1, MAX_MCP_RESPONSE_BYTES)),
				),
			)
			expect(sent.length).toBeGreaterThan(0)
			expect(sent.some((body) => body.includes('"initialize"'))).toBe(false)
			expect(error.reason).toMatchObject({ _tag: "HttpError", status: 429 })
			expect(describeMcpFailure(error)).toBe(
				"The MCP server is limiting requests (429). Try again after 30.",
			)
		}),
	)

	it("speaks to a server that offers only the modern protocol, and to one that offers only the legacy one", async () => {
		for (const modern of [true, false]) {
			const server = await real({ modern })
			const { mcp, call } = session({ cred_1: server.url })
			await prepare(
				mcp,
				turn([{ name: "docs", url: server.url, credential_id: "cred_1", vault_id: "vlt_1" }]),
			)
			expect(await call("mcp__docs__echo", { text: "v" })).toMatchObject({
				output: [{ type: "text", text: "echo:v" }],
				isError: false,
			})
		}
	})

	it("fetches a server that has no credential itself, and keeps a credential's token out of a leaking tool's result", async () => {
		const open = await startFakeMcpServer(null)
		closing.push(open)
		const secure = await real()
		const { mcp, call, vaultsAsked } = session({ cred_1: secure.url })
		await prepare(
			mcp,
			turn([
				{ name: "open", url: open.url, credential_id: null, vault_id: null },
				{ name: "secure", url: secure.url, credential_id: "cred_1", vault_id: "vlt_1" },
			]),
		)
		const asked = vaultsAsked.length
		await call("mcp__open__echo", { text: "plain" })
		expect(vaultsAsked.length).toBe(asked)
		expect(open.calls.map((c) => c.token)).toEqual([undefined])
		const leaked = JSON.stringify(await call("mcp__secure__leak", {}))
		expect(secure.calls.at(-1)?.token).toBe(TOKEN)
		for (const form of spellings(TOKEN)) {
			expect(leaked).not.toContain(form)
		}
	})

	it("sends nothing with a credential stored for another server, or one that is gone", async () => {
		const server = await real()
		const elsewhere = session({ cred_1: "https://elsewhere.mcp.example/mcp" })
		await prepare(
			elsewhere.mcp,
			turn([{ name: "docs", url: server.url, credential_id: "cred_1", vault_id: "vlt_1" }]),
		)
		expect(elsewhere.describe("docs")).toContain("different MCP server")
		const gone = session({})
		await prepare(
			gone.mcp,
			turn([{ name: "docs", url: server.url, credential_id: "cred_1", vault_id: "vlt_1" }]),
		)
		expect(gone.describe("docs")).toContain("archived or deleted")
		expect(gone.vaultsAsked.every((vault) => vault === "vlt_1")).toBe(true)
		expect(gone.vaultsAsked.length).toBeGreaterThan(0)
		expect(server.tokens).toEqual([])
	})

	it("says a credential holds no secret when its token never arrived, and one bound without its vault is not sent", async () => {
		const server = await real()
		const empty = session({ cred_1: "empty" })
		await prepare(
			empty.mcp,
			turn([{ name: "docs", url: server.url, credential_id: "cred_1", vault_id: "vlt_1" }]),
		)
		expect(empty.describe("docs")).toContain("holds no secret")
		expect(empty.describe("docs")).toContain("Send its token again")
		expect(empty.describe("docs")).not.toContain("archived")
		const placeless = session({ cred_1: server.url })
		await prepare(
			placeless.mcp,
			turn([{ name: "docs", url: server.url, credential_id: "cred_1", vault_id: null }]),
		)
		expect(placeless.vaultsAsked).toEqual([])
		expect(server.tokens).toEqual([])
	})

	it("refuses a host the environment's network rules do not allow, on the turn the rule arrives", async () => {
		const server = await scripted()
		const servers = [{ name: "docs", url: server.url, credential_id: null, vault_id: null }]
		const { host } = new URL(server.url)
		const limited = (allowed_hosts: ReadonlyArray<string>): EnvironmentNetworking => ({
			type: "limited",
			allow_mcp_servers: false,
			allow_package_managers: false,
			allowed_hosts,
		})
		const closed = session({})
		await prepare(closed.mcp, turn(servers, limited(["api.openai.com"])))
		expect(closed.describe("docs")).toContain("network rules do not allow")
		expect(server.methods).toEqual([])

		const { mcp, call } = session({})
		await prepare(mcp, turn(servers, limited([host])))
		expect(await call("mcp__docs__echo", { text: "in" })).toMatchObject({ isError: false })
		const sent = server.methods.length
		await prepare(mcp, turn(servers, limited([])))
		expect(await call("mcp__docs__echo", { text: "out" })).toMatchObject({
			output: [{ type: "text", text: expect.stringContaining("network rules do not allow") }],
			isError: true,
		})
		expect(server.methods.length).toBe(sent)
	})

	it("keeps a newer turn's network rules when an older turn's arrive late, and lists nothing for the older turn", async () => {
		const server = await scripted()
		const servers = [{ name: "docs", url: server.url, credential_id: null, vault_id: null }]
		const { host } = new URL(server.url)
		const limited = (allowed_hosts: ReadonlyArray<string>): EnvironmentNetworking => ({
			type: "limited",
			allow_mcp_servers: false,
			allow_package_managers: false,
			allowed_hosts,
		})
		const { mcp, kv, state, describe } = session({})
		state.turn = 2
		await prepare(mcp, turn(servers, limited([])), 2)
		const kept = kv.get("mcp-turn")
		expect(mcp.publish(1, turn(servers, limited([host])))).toBe(false)
		await mcp.discover(1)
		expect(kv.get("mcp-turn")).toBe(kept)
		expect(server.methods).toEqual([])
		expect(describe("docs")).toContain("network rules do not allow")
		expect(mcp.publish(2, turn(servers, limited([])))).toBe(true)
		state.turn = 3
		await prepare(mcp, turn(servers, limited([host])), 3)
		expect(server.methods).toContain("tools/list")
	})

	it("asks a credential's vault for nothing once the turn is interrupted, superseded or forbidden the host", async () => {
		const asked: Array<string> = []
		const state = { turn: 1 }
		const kv = new Map<string, string>()
		const vaults: SessionVaults = {
			list: async (vault, credential) => {
				asked.push(`list ${vault}/${credential}`)
				return { ok: true, tools: [echo] }
			},
			call: async (vault, credential) => {
				asked.push(`call ${vault}/${credential}`)
				return { ok: true, content: [], isError: false }
			},
		}
		const mcp = makeSessionMcp({
			kv: { get: (key) => kv.get(key), put: (key, value) => kv.set(key, value) },
			vaults,
			admittedTurn: () => state.turn,
			agentTools: () => [],
		})
		const binding = { name: "docs", url: URL_, credential_id: "cred_1", vault_id: "vlt_1" }
		const limited = (allowed_hosts: ReadonlyArray<string>): EnvironmentNetworking => ({
			type: "limited",
			allow_mcp_servers: false,
			allow_package_managers: false,
			allowed_hosts,
		})
		const call = (signal?: AbortSignal) =>
			mcp
				.extensions()
				.flatMap((extension) => extension.tools ?? [])
				.find((registered) => registered.name === "mcp__docs__echo")!
				.execute({}, {} as never, { abortSignal: signal } as never)

		state.turn = 2
		expect(mcp.publish(1, turn([binding]))).toBe(true)
		await mcp.discover(1)
		state.turn = 1
		const gone = new AbortController()
		gone.abort()
		await mcp.discover(1, gone.signal)
		expect(mcp.publish(1, turn([binding], limited([])))).toBe(true)
		await mcp.discover(1)
		expect(asked).toEqual([])

		state.turn = 2
		expect(mcp.publish(2, turn([binding]))).toBe(true)
		await mcp.discover(2)
		expect(asked).toEqual(["list vlt_1/cred_1"])
		expect(await call(gone.signal)).toMatchObject({
			output: [{ type: "text", text: expect.stringContaining("interrupted") }],
			isError: true,
		})
		expect(mcp.publish(2, turn([binding], limited([])))).toBe(true)
		expect(await call()).toMatchObject({
			output: [{ type: "text", text: expect.stringContaining("network rules do not allow") }],
			isError: true,
		})
		expect(asked).toEqual(["list vlt_1/cred_1"])
		expect(mcp.publish(2, turn([binding]))).toBe(true)
		expect(await call()).toMatchObject({ isError: false })
		expect(asked).toEqual(["list vlt_1/cred_1", "call vlt_1/cred_1"])
	})

	it("stops waiting for a vault and tells it which call to cut off when the turn is interrupted", async () => {
		const server = await scripted()
		const servers = [{ name: "docs", url: server.url, credential_id: "cred_1", vault_id: "vlt_1" }]
		const first = session({ cred_1: server.url })
		await prepare(first.mcp, turn(servers))
		const { call } = session({ cred_1: server.url }, first.kv)
		const listed = server.methods.length
		const release = server.holdHandshakes()
		const interrupt = new AbortController()
		const calling = call("mcp__docs__echo", { text: "never" }, interrupt.signal)
		while (!server.methods.slice(listed).includes("initialize")) {
			await sleep(5)
		}
		interrupt.abort()
		expect(await within(calling)).toMatchObject({
			output: [{ type: "text", text: expect.stringContaining("interrupted") }],
			isError: true,
		})
		release()
		await sleep(50)
		expect(server.methods.slice(listed)).toEqual(["server/discover", "initialize"])
	})

	it("sends no request for a turn that is no longer the session's current one", async () => {
		const server = await scripted()
		const { mcp, call, state } = session({})
		await prepare(
			mcp,
			turn([{ name: "docs", url: server.url, credential_id: null, vault_id: null }]),
		)
		const sent = server.methods.length
		const release = server.holdHandshakes()
		server.expireSessions()
		expect(await call("mcp__docs__echo", { text: "expired" })).toMatchObject({ isError: true })
		const late = call("mcp__docs__echo", { text: "late" })
		while (!server.methods.slice(sent).includes("initialize")) {
			await sleep(5)
		}
		state.turn = 2
		release()
		expect(await late).toMatchObject({
			output: [{ type: "text", text: expect.stringContaining("no longer the session's current") }],
			isError: true,
		})
		expect(server.methods.slice(sent)).toEqual(["tools/call", "server/discover", "initialize"])
	})

	it("sends no tool request when the turn is interrupted during a slow handshake", async () => {
		const server = await scripted()
		const servers = [{ name: "docs", url: server.url, credential_id: null, vault_id: null }]
		const first = session({})
		await prepare(first.mcp, turn(servers))
		const { call } = session({}, first.kv)
		const listed = server.methods.length
		const release = server.holdHandshakes()
		const interrupt = new AbortController()
		const calling = call("mcp__docs__echo", { text: "never" }, interrupt.signal)
		while (!server.methods.slice(listed).includes("initialize")) {
			await sleep(5)
		}
		interrupt.abort()
		expect(await calling).toMatchObject({
			output: [{ type: "text", text: expect.stringContaining("interrupted") }],
			isError: true,
		})
		release()
		await sleep(50)
		expect(server.methods.slice(listed)).toEqual(["server/discover", "initialize"])
	})

	it("does not keep a connection that failed: the next call connects again", async () => {
		const server = await real()
		const servers = [{ name: "docs", url: server.url, credential_id: "cred_1", vault_id: "vlt_1" }]
		const first = session({ cred_1: server.url })
		await prepare(first.mcp, turn(servers))
		const { call } = session({ cred_1: server.url }, first.kv)
		server.accept([])
		expect(await call("mcp__docs__echo", { text: "refused" })).toMatchObject({
			output: [{ type: "text", text: expect.stringContaining("401") }],
			isError: true,
		})
		server.accept([TOKEN])
		expect(await call("mcp__docs__echo", { text: "back" })).toMatchObject({
			output: [{ type: "text", text: "echo:back" }],
			isError: false,
		})
	})

	it("keeps the client when one call is answered with an error, and opens a new one when its session ends", async () => {
		const server = await scripted()
		const { mcp, call } = session({})
		await prepare(
			mcp,
			turn([{ name: "docs", url: server.url, credential_id: null, vault_id: null }]),
		)
		const [failed, echoed] = await Promise.all([
			call("mcp__docs__boom", {}),
			call("mcp__docs__echo", { text: "beside", delay_ms: 30 }),
		])
		expect(failed).toMatchObject({
			output: [{ type: "text", text: expect.stringContaining("boom failed") }],
			isError: true,
		})
		expect(echoed).toMatchObject({
			output: [{ type: "text", text: "echo:beside:scripted-1" }],
			isError: false,
		})
		expect(await call("mcp__docs__echo", { text: "after" })).toMatchObject({
			output: [{ type: "text", text: "echo:after:scripted-1" }],
		})
		expect(server.methods.filter((method) => method === "initialize")).toHaveLength(1)

		server.expireSessions()
		expect(await call("mcp__docs__echo", { text: "expired" })).toMatchObject({ isError: true })
		expect(await call("mcp__docs__echo", { text: "again" })).toMatchObject({
			output: [{ type: "text", text: "echo:again:scripted-2" }],
			isError: false,
		})
	})

	it("stops reading a tool list once it passes what a session keeps, from a vault or by itself, and does not ask again", async () => {
		const pageBytes = 64 * 1024
		for (const credential of [null, "cred_1"]) {
			const huge = await scripted({ pages: 40, pageBytes })
			const small = await scripted()
			const { mcp, call, describe } = session({ cred_1: huge.url })
			const hugeServer = {
				name: "huge",
				url: huge.url,
				credential_id: credential,
				vault_id: credential === null ? null : "vlt_1",
			}
			await prepare(
				mcp,
				turn([hugeServer, { name: "small", url: small.url, credential_id: null, vault_id: null }]),
			)
			expect(describe("huge")).toContain(String(MAX_TOOL_LIST_BYTES))
			const pagesRead = huge.methods.filter((method) => method === "tools/list").length
			expect(pagesRead).toBeLessThanOrEqual(Math.ceil(MAX_TOOL_LIST_BYTES / pageBytes) + 1)
			expect(await call("mcp__small__echo", { text: "fine" })).toMatchObject({ isError: false })
			await prepare(mcp, turn([hugeServer]))
			expect(huge.methods.filter((method) => method === "tools/list")).toHaveLength(pagesRead)
		}
	})
})
