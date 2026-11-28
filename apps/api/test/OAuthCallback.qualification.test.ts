import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import dashboard from "../../app/worker.ts"
import { makeCustodyDatabase } from "./helpers/CustodyDatabase.ts"
import { openOAuthCallbackFixture } from "./helpers/OAuthCallbackFixture.ts"
import type { OAuthCallbackSettings } from "./helpers/OAuthCallbackFixture.ts"

const origin = "https://dashboard.example.test"
const resource = "https://tool.example.test/mcp"
const issuer = "https://issuer.example.test"
const redirect = origin + "/connections/callback"
const key = "fixture-owner"
const clientSecret = "fixture-confidential-client"
const code = "fixture-provider-code"
const reply = {
	access_token: "fixture-private-access",
	refresh_token: "fixture-private-refresh",
	token_type: "Bearer",
	scope: "tools:read",
}

const post = (path: string, cookie: string, requestOrigin = origin) =>
	new Request(origin + path, { method: "POST", headers: { cookie, origin: requestOrigin } })

const login = async () => {
	const response = await dashboard.fetch(
		new Request(origin + "/auth/sign-in", {
			method: "POST",
			headers: { origin },
			body: new URLSearchParams({ key }),
		}),
		{
			CHECKFU_API_KEY: key,
			API: { fetch: async () => Response.json({ type: "authentication_verified" }) },
			ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
		},
	)
	expect(response.status).toBe(204)
	const cookie = response.headers.get("set-cookie")?.split(";")[0]
	assert.ok(cookie)
	return cookie
}

interface Provider {
	readonly resource?: string
	readonly issuer?: string
	readonly endpoint?: string
	readonly redirectMetadata?: boolean
	readonly exchange?: () => Promise<Response>
}

const fixture = (
	provider: Provider = {},
	checked: Partial<OAuthCallbackSettings> = {},
	sqliteFile?: string,
) => {
	let db = makeCustodyDatabase(sqliteFile)
	const fetched: Array<string> = []
	const exchanges: Array<Request> = []
	let now = Date.now()
	const reopen = () =>
		openOAuthCallbackFixture(db.sql, {
			origin,
			resource,
			issuer,
			apiKey: key,
			clientId: "client-fixture",
			clientSecret,
			scope: reply.scope,
			now: () => now,
			fetch: async (input, init) => {
				const request = new Request(input, init)
				const url = request.url
				fetched.push(url)
				expect(request.redirect).toBe("manual")
				switch (url) {
					case "https://tool.example.test/.well-known/oauth-protected-resource/mcp":
						return provider.redirectMetadata
							? new Response(null, {
									status: 302,
									headers: { location: "https://elsewhere.example.test/metadata" },
								})
							: Response.json({
									resource: provider.resource ?? resource,
									authorization_servers: [issuer],
								})
					case issuer + "/.well-known/oauth-authorization-server":
						return Response.json({
							issuer: provider.issuer ?? issuer,
							authorization_endpoint: issuer + "/authorize",
							token_endpoint: provider.endpoint ?? issuer + "/token",
							authorization_response_iss_parameter_supported: true,
							code_challenge_methods_supported: ["S256"],
						})
					case issuer + "/token":
						exchanges.push(request)
						return provider.exchange?.() ?? Response.json(reply)
					default:
						throw new Error("The fixture sent an unexpected request.")
				}
			},
			...checked,
		})
	const open = reopen()
	return {
		db,
		fetched,
		exchanges,
		reopen,
		open,
		restart: () => {
			db.close()
			db = makeCustodyDatabase(sqliteFile)
			return reopen()
		},
		close: () => db.close(),
		advance: (ms: number) => {
			now += ms
		},
	}
}

type CallbackFixture = ReturnType<typeof fixture>
const credential = "cred_fixture"
const begin = async (open: CallbackFixture["open"], owner: string, id = credential) => {
	const started = await open.start(post("/connections/start", owner), id)
	expect(started.status).toBe(303)
	const location = started.headers.get("location")
	const header = started.headers.get("set-cookie")
	assert.ok(location && header)
	expect(header).toContain("HttpOnly; Secure; SameSite=Lax")
	const authorization = new URL(location)
	expect(authorization.origin + authorization.pathname).toBe(issuer + "/authorize")
	expect(authorization.searchParams.get("redirect_uri")).toBe(redirect)
	expect(authorization.searchParams.get("resource")).toBe(resource)
	expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
	const attempt = header.split(";")[0]
	const state = authorization.searchParams.get("state")
	assert.ok(attempt && state)
	return {
		attempt,
		state,
		authorization,
		callback: (edits?: (url: URL) => void, binding = attempt) => {
			const url = new URL(redirect)
			url.search = new URLSearchParams({ state, iss: issuer, code }).toString()
			edits?.(url)
			return new Request(url, { headers: { cookie: binding } })
		},
		confirm: (session = owner) => post("/connections/confirm", session + "; " + attempt),
	}
}

describe("owner-bound OAuth callback qualification", () => {
	it("stages the callback once and confirms the same browser after reopening SQLite", async ({
		onTestFinished,
	}) => {
		const directory = await mkdtemp(join(tmpdir(), "checkfu-oauth-"))
		const { open, exchanges, restart, close } = fixture({}, {}, join(directory, "owner.sqlite"))
		onTestFinished(async () => {
			close()
			await rm(directory, { recursive: true, force: true })
		})
		const [owner, other] = await Promise.all([login(), login()])
		expect(owner).not.toBe(other)
		const first = await begin(open, owner)
		const second = await begin(open, other)
		expect(open.callback(first.callback(undefined, second.attempt)).status).toBe(400)
		expect(open.callback(first.callback(undefined, "")).status).toBe(400)
		const passed = open.callback(first.callback())
		expect(passed.status).toBe(303)
		expect(passed.headers.get("location")).toBe("/connections/confirm")
		expect(passed.headers.get("cache-control")).toBe("no-store")
		expect(passed.headers.get("referrer-policy")).toBe("no-referrer")
		expect(open.callback(first.callback()).status).toBe(400)
		expect((await open.confirm(first.confirm(other))).status).toBe(409)
		expect((await open.confirm(post("/connections/confirm", first.attempt))).status).toBe(401)
		expect(exchanges).toHaveLength(0)
		const restarted = restart()
		expect((await restarted.confirm(first.confirm())).status).toBe(204)
		expect((await restarted.confirm(first.confirm())).status).toBe(409)
		expect(exchanges).toHaveLength(1)
		const req = exchanges[0]
		assert.ok(req)
		const sent = new URLSearchParams(await req.text())
		expect(sent.get("code")).toBe(code)
		expect(sent.get("resource")).toBe(resource)
		expect(sent.get("redirect_uri")).toBe(redirect)
		const verifier = sent.get("code_verifier")
		assert.ok(verifier)
		const challenge = Buffer.from(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		).toString("base64url")
		expect(challenge).toBe(first.authorization.searchParams.get("code_challenge"))
		const persisted = restart()
		expect(persisted.custody.tokenFor(credential, resource)).toBe(reply.access_token)
		expect(persisted.custody.tokenFor(credential, "https://other.example.test/mcp")).toBeNull()
		const publicValue = JSON.stringify(persisted.custody.overview(credential))
		for (const secret of [code, verifier, clientSecret, reply.access_token, reply.refresh_token]) {
			expect(publicValue).not.toContain(secret)
			expect(passed.headers.get("location")).not.toContain(secret)
		}
	})

	it("refuses a mismatched callback path or issuer, then consumes a denial without exchanging", async () => {
		const { open, exchanges } = fixture()
		const flow = await begin(open, await login())
		for (const edit of [
			(url: URL) => {
				url.pathname += "/"
			},
			(url: URL) => {
				url.searchParams.delete("iss")
			},
			(url: URL) => {
				url.searchParams.set("iss", issuer + "/")
			},
			(url: URL) => {
				url.searchParams.append("iss", issuer)
			},
		]) {
			expect(open.callback(flow.callback(edit)).status).toBe(400)
		}
		const denied = flow.callback((url) => {
			url.searchParams.delete("code")
			url.searchParams.set("error", "access_denied")
		})
		expect(open.callback(denied).status).toBe(303)
		expect(open.callback(flow.callback()).status).toBe(400)
		expect((await open.confirm(flow.confirm())).status).toBe(409)
		expect(exchanges).toHaveLength(0)
	})

	it.each([
		{
			label: "private protected resource",
			configured: { resource: "https://127.0.0.1/mcp" },
			advertised: {},
			calls: 0,
		},
		{
			label: "mismatched protected resource",
			configured: {},
			advertised: { resource: "https://different.example.test" },
			calls: 1,
		},
		{
			label: "redirected metadata",
			configured: {},
			advertised: { redirectMetadata: true },
			calls: 1,
		},
		{
			label: "unexpected issuer",
			configured: {},
			advertised: { issuer: issuer + "/other" },
			calls: 2,
		},
		{
			label: "private token destination",
			configured: {},
			advertised: { endpoint: "https://127.0.0.1/token" },
			calls: 2,
		},
	])("rejects $label before redirecting the browser", async ({ configured, advertised, calls }) => {
		const { open, fetched, exchanges } = fixture(advertised, configured)
		expect((await open.start(post("/connections/start", await login()), credential)).status).toBe(
			400,
		)
		expect(fetched).toHaveLength(calls)
		expect(exchanges).toHaveLength(0)
	})

	it("refuses an expired attempt and a valid attempt presented from the wrong origin", async () => {
		const { open, db, exchanges, advance } = fixture()
		const owner = await login()
		const flow = await begin(open, owner)
		expect(open.callback(flow.callback()).status).toBe(303)
		expect(
			(await open.confirm(post("/connections/confirm", owner + "; " + flow.attempt, issuer)))
				.status,
		).toBe(401)
		expect(Array.from(db.sql.exec("SELECT code FROM oauth_attempts"))).toEqual([{ code }])
		advance(300_001)
		expect((await open.confirm(flow.confirm())).status).toBe(409)
		open.expire()
		expect(Array.from(db.sql.exec("SELECT * FROM oauth_attempts"))).toEqual([])
		expect(exchanges).toHaveLength(0)
	})

	it.each(["erase credential", "seal vault"] as const)(
		"clears staged private attempts when ending custody via %s",
		async (cut) => {
			const { open, reopen, db, exchanges } = fixture()
			const owner = await login()
			const otherId = "cred_other"
			const staged = await begin(open, owner)
			const other = await begin(open, owner, otherId)
			expect(open.callback(staged.callback()).status).toBe(303)
			expect(open.callback(other.callback()).status).toBe(303)
			if (cut === "erase credential") {
				reopen().custody.erase(credential)
			} else {
				reopen().custody.seal()
			}
			expect(Array.from(db.sql.exec("SELECT credential, code FROM oauth_attempts"))).toEqual(
				cut === "erase credential" ? [{ credential: otherId, code }] : [],
			)
			expect((await reopen().confirm(staged.confirm())).status).toBe(409)
			expect(exchanges).toHaveLength(0)
		},
	)

	it.each(["erase credential", "seal vault", "commit fails"] as const)(
		"allows one exchange and refuses a late result when %s",
		async (cut) => {
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<Response>()
			const { open, reopen, db, exchanges } = fixture({
				exchange: () => {
					entered.resolve()
					return release.promise
				},
			})
			const flow = await begin(open, await login())
			expect(open.callback(flow.callback()).status).toBe(303)
			const pending = open.confirm(flow.confirm())
			await entered.promise
			expect((await reopen().confirm(flow.confirm())).status).toBe(409)
			if (cut === "erase credential") {
				reopen().custody.erase(credential)
			} else if (cut === "seal vault") {
				reopen().custody.seal()
			} else {
				db.failCommit()
			}
			release.resolve(Response.json(reply))
			if (cut === "commit fails") {
				await expect(pending).rejects.toThrow("stopped before COMMIT")
			} else {
				expect((await pending).status).toBe(409)
			}
			expect((await reopen().confirm(flow.confirm())).status).toBe(409)
			expect(exchanges).toHaveLength(1)
			expect(reopen().custody.tokenFor(credential, resource)).toBeNull()
			expect(Array.from(db.sql.exec("SELECT * FROM oauth_grants"))).toEqual([])
			expect(Array.from(db.sql.exec("SELECT code, verifier FROM oauth_attempts"))).toEqual(
				cut === "commit fails" ? [{ code: null, verifier: null }] : [],
			)
		},
	)
})
