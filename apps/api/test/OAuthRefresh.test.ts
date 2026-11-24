import { afterAll, describe, expect, it } from "vitest"
import { makeConnectionProxy } from "../src/Connection/ConnectionProxy.ts"
import { makeMcpUpstream } from "../src/Connection/McpUpstream.ts"
import {
	MAX_TOKEN_RESPONSE_BYTES,
	REFRESH_RETRY_DELAYS_MS,
	REFRESH_SKEW_MS,
	STORE_RETRY_DELAYS_MS,
	makeOAuthRefresher,
} from "../src/Connection/OAuthRefresh.ts"
import { makeSecretCustody } from "../src/Connection/SecretCustody.ts"
import type { HeldRefresh, HeldSecret } from "../src/Connection/SecretCustody.ts"
import { startFakeMcpServer } from "./workerd/FakeMcpServer.ts"
import type { FakeMcpServer } from "./workerd/FakeMcpServer.ts"

const TOKEN_ENDPOINT = "https://auth.example.com/oauth/token"
const MCP = "https://mcp.example.com/mcp"
const HOUR = 3_600_000

type Mode = "ok" | "invalid_grant" | "server_error" | "html_error" | "redirect" | "huge" | "endless"

interface TokenRequest {
	readonly url: string
	readonly form: Record<string, string>
	readonly authorization: string | null
}

/**
 * An authorization server as a fetch function. Each refresh token works once:
 * presenting a spent one is refused, as a server that rotates them does.
 */
const authorizationServer = () => {
	const requests: Array<TokenRequest> = []
	let issued = 0
	let valid = "refresh_0"
	let mode: Mode = "ok"
	let held: Array<() => void> | undefined
	const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json", ...headers },
		})
	const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input)
		const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")))
		requests.push({ url, form, authorization: new Headers(init?.headers).get("authorization") })
		if (held !== undefined) {
			const waiting = held
			await new Promise<void>((resolve) => {
				waiting.push(resolve)
			})
		}
		if (mode === "redirect" && !url.endsWith("/elsewhere")) {
			if (init?.redirect !== "manual") {
				throw new Error("the token request was sent with redirects enabled")
			}
			return answer(307, "", { location: "/elsewhere" })
		}
		if (mode === "server_error") {
			return answer(500, { error: "server_error" })
		}
		if (mode === "html_error") {
			return answer(502, "<html>bad gateway</html>", { "content-type": "text/html" })
		}
		if (mode === "huge") {
			return answer(200, "x".repeat(MAX_TOKEN_RESPONSE_BYTES + 1))
		}
		if (mode === "invalid_grant" || form["refresh_token"] !== valid) {
			return answer(400, { error: "invalid_grant", error_description: "refresh token is spent" })
		}
		issued += 1
		valid = `refresh_${issued}`
		return answer(200, {
			access_token: `access_${issued}`,
			token_type: "Bearer",
			// A number, as the SDK checks, but one no date can hold once added to the clock.
			expires_in: mode === "endless" ? 1e20 : 3600,
			refresh_token: valid,
		})
	}
	return {
		fetchFn,
		requests,
		set: (next: Mode) => {
			mode = next
		},
		/** Holds every answer until `release`, so callers pile up behind one request. */
		hold: () => {
			held = []
		},
		release: () => {
			const waiting = held ?? []
			held = undefined
			for (const resolve of waiting) {
				resolve()
			}
		},
	}
}

const REFRESH: HeldRefresh = {
	token_endpoint: TOKEN_ENDPOINT,
	client_id: "client_1",
	scope: null,
	auth: { type: "none" },
	refresh_token: "refresh_0",
}

const oauth = (
	overrides: Partial<Extract<HeldSecret, { type: "mcp_oauth" }>> = {},
): HeldSecret => ({
	type: "mcp_oauth",
	access_token: "access_0",
	expires_at: HOUR,
	refresh: REFRESH,
	refresh_failed: false,
	...overrides,
})

/** A connection's custody and refresher over a map, with a clock and an authorization server. */
const connection = async (
	secret: HeldSecret,
	options: {
		readonly attemptTimeoutMs?: number
		/** Runs during each wait between attempts, when a replacement or erasure can land. */
		readonly duringWait?: (custody: ReturnType<typeof makeSecretCustody>) => Promise<void>
	} = {},
) => {
	const server = authorizationServer()
	const stored = new Map<string, string>()
	const slept: Array<number> = []
	const warnings: Array<string> = []
	let now = 0
	let failPut = false
	let failPuts = 0
	const custody = makeSecretCustody(
		{
			get: (key) => stored.get(key),
			put: (key, value) => {
				if (key === "secret" && (failPut || failPuts > 0)) {
					failPuts = Math.max(0, failPuts - 1)
					throw new Error("storage write failed")
				}
				stored.set(key, value)
			},
			clear: () => {
				stored.clear()
				return Promise.resolve()
			},
			setAlarm: () => Promise.resolve(),
			deleteAlarm: () => Promise.resolve(),
		},
		() => now,
	)
	await custody.store(secret, MCP)
	await custody.keep()
	const refresher = makeOAuthRefresher({
		read: custody.read,
		revision: custody.revision,
		write: custody.refreshed,
		exclusive: custody.exclusive,
		resource: custody.target,
		now: () => now,
		warn: (message) => {
			warnings.push(message)
		},
		fetchFn: server.fetchFn,
		...(options.attemptTimeoutMs === undefined
			? {}
			: { attemptTimeoutMs: options.attemptTimeoutMs }),
		sleep: async (ms) => {
			slept.push(ms)
			await options.duringWait?.(custody)
		},
	})
	return {
		server,
		custody,
		refresher,
		slept,
		stored,
		warnings,
		at: (time: number) => {
			now = time
		},
		failWrites: (fail: boolean) => {
			failPut = fail
		},
		/** Fails the next `count` writes of the secret, then lets them through. */
		failNextWrites: (count: number) => {
			failPuts = count
		},
	}
}

const EXPIRING = HOUR - REFRESH_SKEW_MS

const tick = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 10)
	})

describe("a connection's OAuth token", () => {
	it("is used as it is while it has time left", async () => {
		const { refresher, server, at } = await connection(oauth())
		at(EXPIRING - 1)
		expect(await refresher.token()).toEqual({ ok: true, token: "access_0" })
		expect(server.requests).toEqual([])
	})

	it("is refreshed before it expires, and the rotated refresh token is kept", async () => {
		const { refresher, server, custody, at } = await connection(oauth())
		at(EXPIRING)
		expect(await refresher.token()).toEqual({ ok: true, token: "access_1" })
		expect(server.requests).toEqual([
			{
				url: TOKEN_ENDPOINT,
				form: {
					grant_type: "refresh_token",
					refresh_token: "refresh_0",
					resource: MCP,
					client_id: "client_1",
				},
				authorization: null,
			},
		])
		expect(custody.read()).toEqual(
			oauth({
				access_token: "access_1",
				expires_at: EXPIRING + HOUR,
				refresh: { ...REFRESH, refresh_token: "refresh_1" },
			}),
		)
		expect(custody.report()).toEqual({
			refreshes: 1,
			revision: 2,
			expires_at: EXPIRING + HOUR,
			refresh_failed: false,
		})
		expect(custody.unreported()).toBe(true)

		at(EXPIRING + HOUR)
		expect(await refresher.token()).toEqual({ ok: true, token: "access_2" })
		expect(server.requests[1]?.form["refresh_token"]).toBe("refresh_1")
	})

	it("authenticates the client the way the credential says", async () => {
		const basic = await connection(
			oauth({
				refresh: {
					...REFRESH,
					scope: "repo read:org",
					auth: { type: "client_secret_basic", client_secret: "shh_basic" },
				},
			}),
		)
		basic.at(EXPIRING)
		expect((await basic.refresher.token()).ok).toBe(true)
		expect(basic.server.requests[0]).toEqual({
			url: TOKEN_ENDPOINT,
			form: {
				grant_type: "refresh_token",
				refresh_token: "refresh_0",
				scope: "repo read:org",
				resource: MCP,
			},
			authorization: `Basic ${btoa("client_1:shh_basic")}`,
		})

		const post = await connection(
			oauth({
				refresh: { ...REFRESH, auth: { type: "client_secret_post", client_secret: "shh_post" } },
			}),
		)
		post.at(EXPIRING)
		expect((await post.refresher.token()).ok).toBe(true)
		expect(post.server.requests[0]).toEqual({
			url: TOKEN_ENDPOINT,
			form: {
				grant_type: "refresh_token",
				refresh_token: "refresh_0",
				resource: MCP,
				client_id: "client_1",
				client_secret: "shh_post",
			},
			authorization: null,
		})
	})

	it("is refreshed once however many callers need it at the same time", async () => {
		const { refresher, server, at } = await connection(oauth())
		at(EXPIRING)
		server.hold()
		const callers = Array.from({ length: 10 }, () => refresher.token())
		await tick()
		server.release()
		expect(await Promise.all(callers)).toEqual(
			Array.from({ length: 10 }, () => ({ ok: true, token: "access_1" })),
		)
		expect(server.requests).toHaveLength(1)
	})

	it("is never handed out before the refresh that produced it is stored", async () => {
		const lost = await connection(oauth())
		lost.at(EXPIRING)
		lost.failWrites(true)
		const outcome = await lost.refresher.token().catch(() => "rejected" as const)
		expect(outcome === "rejected" || !outcome.ok || outcome.token !== "access_1").toBe(true)
		expect(lost.custody.read()).toMatchObject({ access_token: "access_0" })

		// An erasure waits for the attempt that is out, then nothing is handed out again.
		const erased = await connection(oauth())
		erased.at(EXPIRING)
		erased.server.hold()
		const waiting = erased.refresher.token()
		await tick()
		const erasing = erased.custody.erase()
		erased.server.release()
		expect(await waiting).toEqual({ ok: true, token: "access_1" })
		await erasing
		expect(erased.custody.read()).toBeNull()
		expect(await erased.refresher.token()).toEqual({
			ok: false,
			reason: "credential_unavailable",
		})
	})

	it("stores a granted token again when storage fails, without spending the refresh token twice", async () => {
		const { refresher, server, custody, at, slept, failNextWrites } = await connection(oauth())
		at(EXPIRING)
		// The write of the granted tokens fails once; the exchange is not made again for it.
		failNextWrites(1)
		expect(await refresher.token()).toEqual({ ok: true, token: "access_1" })
		expect(server.requests).toHaveLength(1)
		expect(slept).toEqual([STORE_RETRY_DELAYS_MS[0]])
		expect(custody.read()).toMatchObject({
			access_token: "access_1",
			refresh: { refresh_token: "refresh_1" },
		})
	})

	it("stops refreshing once the authorization server refuses, until new tokens arrive", async () => {
		const { refresher, server, custody, at, slept } = await connection(oauth())
		at(EXPIRING)
		server.set("invalid_grant")
		expect(await refresher.token()).toEqual({ ok: false, reason: "reauthorization_required" })
		expect(slept).toEqual([])
		expect(custody.read()).toMatchObject({ refresh_failed: true, access_token: "access_0" })
		expect(custody.report()).toMatchObject({ refreshes: 1, refresh_failed: true })

		server.set("ok")
		expect(await refresher.token()).toEqual({ ok: false, reason: "reauthorization_required" })
		expect(await refresher.recover("access_0")).toBe("reauthorization_required")
		expect(server.requests).toHaveLength(1)

		expect(
			await custody.replace({
				type: "mcp_oauth",
				access_token: "access_new",
				expires_at: EXPIRING + 2 * HOUR,
				refresh_token: null,
			}),
		).toBe(3)
		expect(custody.unreported()).toBe(false)
		expect(await refresher.token()).toEqual({ ok: true, token: "access_new" })
		expect(server.requests).toHaveLength(1)
	})

	it("retries an authorization server that is failing, without giving up on the credential", async () => {
		const { refresher, server, custody, at, slept } = await connection(oauth())
		at(EXPIRING)
		server.set("server_error")
		// Still valid for a minute: the old token goes on being used.
		expect(await refresher.token()).toEqual({ ok: true, token: "access_0" })
		expect(slept).toEqual(REFRESH_RETRY_DELAYS_MS)
		expect(server.requests).toHaveLength(REFRESH_RETRY_DELAYS_MS.length + 1)
		expect(custody.read()).toEqual(oauth())
		expect(custody.unreported()).toBe(false)

		at(HOUR)
		server.set("html_error")
		expect(await refresher.token()).toEqual({ ok: false, reason: "refresh_unavailable" })
		expect(custody.read()).toMatchObject({ refresh_failed: false })

		server.set("ok")
		expect(await refresher.token()).toEqual({ ok: true, token: "access_1" })
	})

	it("does not follow a redirect from the token endpoint", async () => {
		const { refresher, server, custody, at } = await connection(oauth())
		at(HOUR)
		server.set("redirect")
		expect(await refresher.token()).toEqual({ ok: false, reason: "refresh_unavailable" })
		expect(server.requests.map((request) => request.url)).toEqual(
			Array.from({ length: REFRESH_RETRY_DELAYS_MS.length + 1 }, () => TOKEN_ENDPOINT),
		)
		expect(custody.read()).toMatchObject({ refresh_failed: false, access_token: "access_0" })
	})

	it("reads no more of a token response than a token response needs", async () => {
		const { refresher, server, custody, at } = await connection(oauth())
		at(HOUR)
		server.set("huge")
		expect(await refresher.token()).toEqual({ ok: false, reason: "refresh_unavailable" })
		expect(custody.read()).toMatchObject({ refresh_failed: false })
	})

	it("lets tokens that arrive during a refresh stand, applied after it", async () => {
		const { refresher, server, custody, at } = await connection(oauth())
		at(EXPIRING)
		server.hold()
		const waiting = refresher.token()
		await tick()
		const replacing = custody.replace({
			type: "mcp_oauth",
			access_token: "access_new",
			expires_at: 5 * HOUR,
			refresh_token: "refresh_new",
		})
		server.release()
		expect(await waiting).toEqual({ ok: true, token: "access_1" })
		expect(await replacing).toBe(3)
		expect(custody.read()).toMatchObject({
			access_token: "access_new",
			refresh: { refresh_token: "refresh_new" },
		})
	})

	it("keeps the rotated refresh token when only the access token is replaced during a refresh", async () => {
		const { refresher, server, custody, at } = await connection(oauth())
		at(EXPIRING)
		server.hold()
		const waiting = refresher.token()
		await tick()
		// No refresh token in the replacement: the one the refresh is about to receive must survive it.
		const replacing = custody.replace({
			type: "mcp_oauth",
			access_token: "access_new",
			expires_at: EXPIRING + 30 * 60_000,
			refresh_token: null,
		})
		server.release()
		await waiting
		await replacing
		expect(custody.read()).toMatchObject({
			access_token: "access_new",
			refresh: { refresh_token: "refresh_1" },
		})
		// refresh_0 is spent; the next renewal works only with the rotated one.
		at(EXPIRING + 30 * 60_000)
		expect(await refresher.token()).toEqual({ ok: true, token: "access_2" })
		expect(server.requests.map((request) => request.form["refresh_token"])).toEqual([
			"refresh_0",
			"refresh_1",
		])
	})

	it("sends no refresh token that was erased or replaced while it waited to try again", async () => {
		const erased = await connection(oauth(), { duringWait: (custody) => custody.erase() })
		erased.at(EXPIRING)
		erased.server.set("server_error")
		expect(await erased.refresher.token()).toEqual({
			ok: false,
			reason: "credential_unavailable",
		})
		expect(erased.server.requests).toHaveLength(1)

		const replaced = await connection(oauth(), {
			duringWait: async (custody) => {
				await custody.replace({
					type: "mcp_oauth",
					access_token: "access_new",
					expires_at: 5 * HOUR,
					refresh_token: "refresh_new",
				})
			},
		})
		replaced.at(EXPIRING)
		replaced.server.set("server_error")
		expect(await replaced.refresher.token()).toEqual({ ok: true, token: "access_new" })
		expect(replaced.server.requests.map((request) => request.form["refresh_token"])).toEqual([
			"refresh_0",
		])
	})

	it("stores no expiry a date cannot hold, and keeps the token usable", async () => {
		const { refresher, server, custody, at, warnings } = await connection(oauth())
		at(EXPIRING)
		server.set("endless")
		expect(await refresher.token()).toEqual({ ok: true, token: "access_1" })
		expect(custody.read()).toMatchObject({ access_token: "access_1", expires_at: null })
		expect(custody.report()).toMatchObject({ expires_at: null })
		expect(warnings).toHaveLength(1)
	})

	it("form-encodes a Basic client id and secret before encoding them", async () => {
		const { refresher, server, at } = await connection(
			oauth({
				refresh: {
					...REFRESH,
					client_id: "client:1 two",
					auth: { type: "client_secret_basic", client_secret: "sécret✓" },
				},
			}),
		)
		at(EXPIRING)
		expect((await refresher.token()).ok).toBe(true)
		const header = server.requests[0]?.authorization ?? ""
		expect(header).toBe(`Basic ${btoa("client%3A1+two:s%C3%A9cret%E2%9C%93")}`)
		const [id, secret] = atob(header.slice("Basic ".length)).split(":")
		expect([id, secret].map((part) => new URLSearchParams(`v=${part}`).get("v"))).toEqual([
			"client:1 two",
			"sécret✓",
		])
	})

	it("gives up on a token endpoint that stops answering, and can try again", async () => {
		const { refresher, server, at } = await connection(oauth(), { attemptTimeoutMs: 20 })
		at(EXPIRING)
		server.hold()
		expect(await refresher.token()).toEqual({ ok: true, token: "access_0" })
		expect(server.requests).toHaveLength(REFRESH_RETRY_DELAYS_MS.length + 1)
		at(HOUR)
		expect(await refresher.token()).toEqual({ ok: false, reason: "refresh_unavailable" })
		// Nothing is left waiting: the next caller starts a request of its own.
		expect(server.requests).toHaveLength(2 * (REFRESH_RETRY_DELAYS_MS.length + 1))
		server.release()
	})

	it("lets a replacement that keeps the access token stand over a refresh that was out", async () => {
		const { refresher, server, custody, at } = await connection(oauth())
		at(EXPIRING)
		server.hold()
		const pending = refresher.token()
		await tick()
		const replacing = custody.replace({
			type: "mcp_oauth",
			access_token: "access_0",
			expires_at: 2 * HOUR,
			refresh_token: "refresh_new",
		})
		server.release()
		expect(await pending).toEqual({ ok: true, token: "access_1" })
		expect(await replacing).toBe(3)
		const held = custody.read()
		expect(held).toMatchObject({ access_token: "access_0", expires_at: 2 * HOUR })
		expect(held?.type === "mcp_oauth" ? held.refresh?.refresh_token : null).toBe("refresh_new")
	})

	it("does not mark a replacement failed for a refusal of the tokens it replaced", async () => {
		const { refresher, server, custody, at } = await connection(oauth())
		at(EXPIRING)
		server.set("invalid_grant")
		server.hold()
		const pending = refresher.token()
		await tick()
		const replacing = custody.replace({
			type: "mcp_oauth",
			access_token: "access_0",
			expires_at: 2 * HOUR,
			refresh_token: "refresh_new",
		})
		server.release()
		// The refusal is stored first, for the old tokens; the replacement then clears it.
		expect(await pending).toEqual({ ok: false, reason: "reauthorization_required" })
		expect(await replacing).toBe(3)
		expect(custody.read()).toMatchObject({ refresh_failed: false })
		expect(await refresher.token()).toEqual({ ok: true, token: "access_0" })
	})

	it("hands out no token erased or expired while the authorization server was down", async () => {
		const erased = await connection(oauth())
		erased.at(EXPIRING)
		erased.server.set("server_error")
		erased.server.hold()
		const gone = erased.refresher.token()
		await tick()
		// The erasure waits for the attempt that is out, and lands before the next one.
		const erasing = erased.custody.erase()
		erased.server.release()
		await erasing
		expect(await gone).toEqual({ ok: false, reason: "credential_unavailable" })
		expect(erased.server.requests).toHaveLength(1)

		const expired = await connection(oauth())
		expired.at(EXPIRING)
		expired.server.set("server_error")
		expired.server.hold()
		const late = expired.refresher.token()
		await tick()
		expired.at(HOUR + 1)
		expired.server.release()
		expect(await late).toEqual({ ok: false, reason: "refresh_unavailable" })
	})

	it("uses a token with no refresh as it is, and a bearer token always", async () => {
		const bare = await connection(oauth({ refresh: null }))
		bare.at(2 * HOUR)
		expect(await bare.refresher.token()).toEqual({ ok: true, token: "access_0" })
		expect(await bare.refresher.recover("access_0")).toBe("none")

		const bearer = await connection({ type: "static_bearer", token: "tok" })
		expect(await bearer.refresher.token()).toEqual({ ok: true, token: "tok" })
		expect(await bearer.refresher.recover("tok")).toBe("none")
		expect(bearer.custody.report()).toBeNull()
	})

	it("names every secret it holds, so none is returned", async () => {
		const { refresher } = await connection(
			oauth({
				refresh: { ...REFRESH, auth: { type: "client_secret_post", client_secret: "shh" } },
			}),
		)
		expect(refresher.secrets()).toEqual(["access_0", "refresh_0", "shh"])
	})

	it("keeps what it is sent to and refreshed by when its tokens are replaced", async () => {
		const { custody } = await connection(oauth())
		expect(await custody.replace({ type: "static_bearer", token: "tok" })).toBeNull()
		expect(
			await custody.replace({
				type: "mcp_oauth",
				access_token: "access_new",
				expires_at: null,
				refresh_token: "refresh_new",
			}),
		).toBe(2)
		expect(custody.read()).toEqual(
			oauth({
				access_token: "access_new",
				expires_at: null,
				refresh: { ...REFRESH, refresh_token: "refresh_new" },
			}),
		)
		expect(custody.target()).toBe(MCP)

		const bare = await connection(oauth({ refresh: null }))
		expect(
			await bare.custody.replace({
				type: "mcp_oauth",
				access_token: "a",
				expires_at: null,
				refresh_token: "r",
			}),
		).toBeNull()
	})
})

describe("a connection's MCP client with an OAuth token", () => {
	const servers: Array<FakeMcpServer> = []
	afterAll(async () => {
		await Promise.all(servers.map((started) => started.close()))
	})

	const world = async (secret: HeldSecret) => {
		const mcp = await startFakeMcpServer(["access_0"])
		servers.push(mcp)
		const held = await connection(secret)
		const proxy = makeConnectionProxy(() => ({ url: mcp.url, auth: held.refresher }))
		const upstream = makeMcpUpstream(mcp.url, proxy.forward)
		return { mcp, upstream, ...held }
	}

	it("refreshes and tries once more when the server stops accepting the token", async () => {
		const { mcp, upstream, server } = await world(oauth({ expires_at: null }))
		expect(await upstream.callTool("echo", { text: "1" })).toMatchObject({ ok: true })

		mcp.accept(["access_1"])
		expect(await upstream.callTool("echo", { text: "2" })).toEqual({
			ok: true,
			content: [{ type: "text", text: "echo:2" }],
			isError: false,
		})
		expect(server.requests).toHaveLength(1)
		expect(mcp.calls.map((call) => call.token)).toEqual(["access_0", "access_1"])

		// A refreshed token the server still refuses is not refreshed again for the same call.
		mcp.accept(["access_9"])
		expect(await upstream.callTool("echo", { text: "3" })).toMatchObject({
			ok: false,
			reason: "unauthorized",
		})
		expect(server.requests).toHaveLength(2)
		await upstream.close()
	})

	it("fails closed, saying what to do, when the token cannot be renewed", async () => {
		const { mcp, upstream, server, at } = await world(oauth())
		at(HOUR)
		server.set("invalid_grant")
		const refused = await upstream.callTool("echo", { text: "1" })
		expect(refused).toMatchObject({ ok: false, reason: "reauthorization_required" })
		expect(refused.ok ? "" : refused.message).toContain("re-authorized")
		expect(await upstream.listTools()).toMatchObject({
			ok: false,
			reason: "reauthorization_required",
		})
		expect(mcp.tokens).toEqual([])
		expect(server.requests).toHaveLength(1)
		await upstream.close()
	})

	it("says so when a refused token's refresh is refused too", async () => {
		const { mcp, upstream, server } = await world(oauth({ expires_at: null }))
		mcp.accept(["access_other"])
		server.set("invalid_grant")
		expect(await upstream.callTool("echo", { text: "1" })).toMatchObject({
			ok: false,
			reason: "reauthorization_required",
		})
		await upstream.close()
	})
})
