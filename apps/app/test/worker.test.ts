import { describe, expect, it } from "vitest"
import worker from "../worker.ts"

const KEY = "sk-test"
const ORIGIN = "https://app.example"

const makeEnv = () => {
	const seen: Array<Request> = []
	const api = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init)
		seen.push(request)
		const accepted = request.headers.get("authorization") === `Bearer ${KEY}`
		return Promise.resolve(new Response(null, { status: accepted ? 200 : 401 }))
	}
	const assets = (): Promise<Response> => Promise.resolve(new Response("index"))
	return { env: { API: { fetch: api }, ASSETS: { fetch: assets } }, seen }
}

const signIn = (key: string, origin = ORIGIN) =>
	new Request(`${ORIGIN}/auth/sign-in`, {
		method: "POST",
		headers: { origin },
		body: new URLSearchParams({ key }),
	})

describe("app worker", () => {
	it("sets an HttpOnly cookie for an accepted key", async () => {
		const { env } = makeEnv()
		const response = await worker.fetch(signIn(KEY), env)
		expect(response.status).toBe(204)
		const cookie = response.headers.get("set-cookie") ?? ""
		expect(cookie).toContain(`checkfu_key=${KEY}`)
		expect(cookie).toContain("HttpOnly")
		expect(cookie).toContain("Secure")
		expect(cookie).toContain("SameSite=Strict")
	})

	it("refuses a key the API rejects, without a cookie", async () => {
		const { env } = makeEnv()
		const response = await worker.fetch(signIn("wrong"), env)
		expect(response.status).toBe(401)
		expect(response.headers.get("set-cookie")).toBeNull()
	})

	it("refuses a cross-origin sign-in", async () => {
		const { env, seen } = makeEnv()
		const response = await worker.fetch(signIn(KEY, "https://evil.example"), env)
		expect(response.status).toBe(403)
		expect(seen).toHaveLength(0)
	})

	it("sends the cookie's key to the API and drops caller credentials", async () => {
		const { env, seen } = makeEnv()
		await worker.fetch(
			new Request(`${ORIGIN}/v1/agents`, {
				headers: {
					cookie: `other=1; checkfu_key=${KEY}`,
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

	it("forwards no credential without a cookie", async () => {
		const { env, seen } = makeEnv()
		const response = await worker.fetch(
			new Request(`${ORIGIN}/v1/agents`, { headers: { authorization: `Bearer ${KEY}` } }),
			env,
		)
		expect(seen[0]?.headers.get("authorization")).toBeNull()
		expect(response.status).toBe(401)
	})

	it("refuses a cross-origin write through the proxy", async () => {
		const { env, seen } = makeEnv()
		const response = await worker.fetch(
			new Request(`${ORIGIN}/v1/agents`, {
				method: "POST",
				headers: { origin: "https://evil.example", cookie: `checkfu_key=${KEY}` },
			}),
			env,
		)
		expect(response.status).toBe(403)
		expect(seen).toHaveLength(0)
	})

	it("reports whether the cookie's key is still accepted", async () => {
		const { env } = makeEnv()
		const session = (cookie?: string) =>
			worker.fetch(
				new Request(`${ORIGIN}/auth/session`, cookie === undefined ? {} : { headers: { cookie } }),
				env,
			)
		expect((await session(`checkfu_key=${KEY}`)).status).toBe(204)
		expect((await session("checkfu_key=stale")).status).toBe(401)
		expect((await session()).status).toBe(401)
	})

	it("clears the cookie on sign-out", async () => {
		const { env } = makeEnv()
		const response = await worker.fetch(
			new Request(`${ORIGIN}/auth/sign-out`, { method: "POST", headers: { origin: ORIGIN } }),
			env,
		)
		expect(response.headers.get("set-cookie")).toContain("Max-Age=0")
	})

	it("serves the app for every other path", async () => {
		const { env } = makeEnv()
		const response = await worker.fetch(new Request(`${ORIGIN}/sessions/abc`), env)
		expect(await response.text()).toBe("index")
	})
})
