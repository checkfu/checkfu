import { afterEach, describe, expect, it, vi } from "vitest"
import worker from "../worker.ts"

const KEY = "sk-test"
const ORIGIN = "https://app.example"

const makeEnv = (apiKey: string | null = KEY) => {
	const seen: Array<Request> = []
	const api = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init)
		seen.push(request)
		const accepted = request.headers.get("authorization") === `Bearer ${KEY}`
		return Promise.resolve(new Response(null, { status: accepted ? 200 : 401 }))
	}
	const assets = (): Promise<Response> => Promise.resolve(new Response("index"))
	return {
		env: {
			API: { fetch: api },
			ASSETS: { fetch: assets },
			...(apiKey === null ? {} : { CHECKFU_API_KEY: apiKey }),
		},
		seen,
	}
}

const signIn = (key: string, origin = ORIGIN) =>
	new Request(`${ORIGIN}/auth/sign-in`, {
		method: "POST",
		headers: { origin },
		body: new URLSearchParams({ key }),
	})

const sessionCookie = async (env: ReturnType<typeof makeEnv>["env"]): Promise<string> => {
	const response = await worker.fetch(signIn(KEY), env)
	const header = response.headers.get("set-cookie") ?? ""
	return header.split(";")[0] ?? ""
}

const session = (env: ReturnType<typeof makeEnv>["env"], cookie?: string) =>
	worker.fetch(
		new Request(`${ORIGIN}/auth/session`, cookie === undefined ? {} : { headers: { cookie } }),
		env,
	)

afterEach(() => {
	vi.useRealTimers()
})

describe("app worker", () => {
	it("signs in with a session cookie that does not carry the API key", async () => {
		const { env } = makeEnv()
		const response = await worker.fetch(signIn(KEY), env)
		expect(response.status).toBe(204)
		const header = response.headers.get("set-cookie") ?? ""
		expect(header).toMatch(/^__Host-checkfu_session=\d+\.[\w-]+; Path=\/;/u)
		expect(header).not.toContain(KEY)
		for (const flag of ["HttpOnly", "Secure", "SameSite=Strict"]) {
			expect(header).toContain(flag)
		}
	})

	it("refuses a wrong key without a cookie, and any sign-in without a configured key", async () => {
		const wrong = await worker.fetch(signIn("wrong"), makeEnv().env)
		expect(wrong.status).toBe(401)
		expect(wrong.headers.get("set-cookie")).toBeNull()
		const unconfigured = await worker.fetch(signIn(KEY), makeEnv(null).env)
		expect(unconfigured.status).toBe(503)
		expect(unconfigured.headers.get("set-cookie")).toBeNull()
	})

	it("refuses a cross-origin sign-in", async () => {
		const { env, seen } = makeEnv()
		const response = await worker.fetch(signIn(KEY, "https://evil.example"), env)
		expect(response.status).toBe(403)
		expect(seen).toHaveLength(0)
	})

	it("adds its own key for a signed-in session and drops caller credentials", async () => {
		const { env, seen } = makeEnv()
		const cookie = await sessionCookie(env)
		await worker.fetch(
			new Request(`${ORIGIN}/v1/agents`, {
				headers: {
					cookie: `other=1; ${cookie}`,
					authorization: "Bearer caller",
					"x-api-key": "caller",
				},
			}),
			env,
		)
		const forwarded = seen[0]
		expect(forwarded?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
		expect(forwarded?.headers.get("x-api-key")).toBeNull()
		expect(forwarded?.headers.get("cookie")).toBeNull()
	})

	it("forwards no credential without a valid session, whatever the cookie holds", async () => {
		const { env, seen } = makeEnv()
		const valid = await sessionCookie(env)
		const [, token = ""] = valid.split("=")
		const [expires] = token.split(".")
		for (const cookie of [
			undefined,
			`__Host-checkfu_session=${KEY}`,
			`__Host-checkfu_session=${expires}.AAAA`,
			"__Host-checkfu_session=%E0%A4%A",
			"__Host-checkfu_session=1.!!!",
			`checkfu_key=${KEY}`,
		]) {
			const response = await worker.fetch(
				new Request(`${ORIGIN}/v1/agents`, {
					headers: { authorization: `Bearer ${KEY}`, ...(cookie === undefined ? {} : { cookie }) },
				}),
				env,
			)
			expect(response.status).toBe(401)
			expect((await session(env, cookie)).status).toBe(401)
		}
		expect(seen.every((request) => request.headers.get("authorization") === null)).toBe(true)
	})

	it("ends a session when it expires or the key is rotated", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-11-01T00:00:00Z"))
		const { env } = makeEnv()
		const cookie = await sessionCookie(env)
		expect((await session(env, cookie)).status).toBe(204)
		expect((await session(makeEnv("sk-rotated").env, cookie)).status).toBe(401)
		vi.setSystemTime(new Date("2026-11-09T00:00:00Z"))
		expect((await session(env, cookie)).status).toBe(401)
	})

	it("tells caches not to keep a session check", async () => {
		const { env } = makeEnv()
		const cookie = await sessionCookie(env)
		for (const each of [cookie, "__Host-checkfu_session=stale", undefined]) {
			expect((await session(env, each)).headers.get("cache-control")).toBe("no-store")
		}
	})

	it("clears the cookie on sign-out", async () => {
		const { env } = makeEnv()
		const response = await worker.fetch(
			new Request(`${ORIGIN}/auth/sign-out`, { method: "POST", headers: { origin: ORIGIN } }),
			env,
		)
		expect(response.headers.get("set-cookie")).toContain("__Host-checkfu_session=; ")
		expect(response.headers.get("set-cookie")).toContain("Max-Age=0")
	})

	it("refuses a cross-origin write through the proxy", async () => {
		const { env, seen } = makeEnv()
		const cookie = await sessionCookie(env)
		const response = await worker.fetch(
			new Request(`${ORIGIN}/v1/agents`, {
				method: "POST",
				headers: { origin: "https://evil.example", cookie },
			}),
			env,
		)
		expect(response.status).toBe(403)
		expect(seen).toHaveLength(0)
	})

	it("serves the app for every other path", async () => {
		const { env } = makeEnv()
		const response = await worker.fetch(new Request(`${ORIGIN}/sessions/abc`), env)
		expect(await response.text()).toBe("index")
	})

	it("gives each local instance its own hostname, by port, and never signs in elsewhere", async () => {
		const { env, seen } = makeEnv()
		for (const [from, to] of [
			["http://localhost:1340/sessions?x=1", "http://app-1340.localhost:1340/sessions?x=1"],
			["http://127.0.0.1:1340/", "http://app-1340.localhost:1340/"],
			["http://app.localhost:1341/agents", "http://app-1341.localhost:1341/agents"],
			["http://app-1340.localhost:1341/", "http://app-1341.localhost:1341/"],
		] as const) {
			const moved = await worker.fetch(new Request(from), env)
			expect(moved.status).toBe(307)
			expect(moved.headers.get("location")).toBe(to)
			const origin = new URL(from).origin
			const refused = await worker.fetch(
				new Request(`${origin}/auth/sign-in`, {
					method: "POST",
					headers: { origin },
					body: new URLSearchParams({ key: KEY }),
				}),
				env,
			)
			expect(refused.status).toBe(421)
			expect(refused.headers.get("set-cookie")).toBeNull()
		}
		const home = await worker.fetch(new Request("http://app-1340.localhost:1340/sessions"), env)
		expect(await home.text()).toBe("index")
		expect(seen).toHaveLength(0)
	})

	it("reads at most a small form-encoded body before checking a key", async () => {
		const { env, seen } = makeEnv()
		const post = (body: BodyInit, contentType: string) =>
			worker.fetch(
				new Request(`${ORIGIN}/auth/sign-in`, {
					method: "POST",
					headers: { origin: ORIGIN, "content-type": contentType },
					body,
				}),
				env,
			)
		expect(
			(await post(`key=${"k".repeat(10_000)}`, "application/x-www-form-urlencoded")).status,
		).toBe(413)
		const form = new FormData()
		form.set("key", KEY)
		expect((await post(form, "multipart/form-data; boundary=x")).status).toBe(415)
		expect(seen).toHaveLength(0)
	})
})
