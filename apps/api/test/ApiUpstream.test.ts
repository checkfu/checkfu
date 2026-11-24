import { describe, expect, it } from "@effect/vitest"
import {
	MAX_API_RESPONSE_BYTES,
	MAX_API_RESPONSE_TEXT_LENGTH,
	isUnderBaseUrl,
	makeApiUpstream,
} from "../src/Connection/ApiUpstream.ts"
import type { ApiTarget } from "../src/Connection/ApiUpstream.ts"

const BASE = "https://api.shop.example/v1"
const KEY = "key_SECRET_do_not_leak"

interface Sent {
	readonly url: string
	readonly method: string | undefined
	readonly headers: Readonly<Record<string, string>>
	readonly redirect: string | undefined
	readonly body: string | undefined
}

const upstream = (
	target: ApiTarget | null,
	answer: (sent: Sent) => Response = () => Response.json({ ok: true }),
) => {
	const sent: Array<Sent> = []
	const api = makeApiUpstream(
		() => target,
		(input, init) => {
			const request: Sent = {
				url: String(input),
				method: init?.method,
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
				redirect: init?.redirect,
				body: typeof init?.body === "string" ? init.body : undefined,
			}
			sent.push(request)
			return Promise.resolve(answer(request))
		},
	)
	return { api, sent }
}

const header: ApiTarget = {
	baseUrl: BASE,
	key: { token: KEY, placement: { in: "header", name: "X-Api-Key" } },
}

const get = (url: string, headers: Record<string, string> = {}) => ({
	method: "GET",
	url,
	headers,
})

describe("a connection's API client", () => {
	it("attaches the key where the credential says, after dropping any the request carries", async () => {
		const { api, sent } = upstream({
			baseUrl: BASE,
			key: { token: KEY, placement: { in: "header", name: "Authorization", prefix: "Bearer " } },
		})
		const outcome = await api.call(
			BASE,
			get(`${BASE}/pets`, {
				authorization: "Bearer theirs",
				Cookie: "session=theirs",
				"Proxy-Authorization": "theirs",
				"x-trace": "abc",
			}),
		)
		expect(outcome).toMatchObject({ ok: true, status: 200 })
		expect(sent).toEqual([
			{
				url: `${BASE}/pets`,
				method: "GET",
				headers: { authorization: `Bearer ${KEY}`, "x-trace": "abc" },
				redirect: "manual",
				body: undefined,
			},
		])
	})

	it("sets a query key itself, whatever the request put under that name", async () => {
		const { api, sent } = upstream({
			baseUrl: BASE,
			key: { token: KEY, placement: { in: "query", name: "api_key" } },
		})
		await api.call(BASE, get(`${BASE}/pets?api_key=theirs&limit=2`))
		expect(sent.map((request) => request.url)).toEqual([`${BASE}/pets?api_key=${KEY}&limit=2`])
	})

	it("drops a header the request names like the credential's own", async () => {
		const { api, sent } = upstream(header)
		await api.call(BASE, get(`${BASE}/pets`, { "x-api-key": "theirs" }))
		expect(sent[0]?.headers).toEqual({ "x-api-key": KEY })
	})

	it("sends nothing outside the base URL it was stored for", async () => {
		const { api, sent } = upstream(header)
		const refused = await Promise.all([
			api.call(BASE, get("https://evil.example/v1/pets")),
			api.call(BASE, get("https://api.shop.example/v2/pets")),
			api.call(BASE, get("https://api.shop.example/v10/pets")),
			api.call(BASE, get("http://api.shop.example/v1/pets")),
			api.call(BASE, get("https://user:pass@api.shop.example/v1/pets")),
			api.call(BASE, get("not a url")),
			// A caller that names another base URL does not move the connection's own.
			api.call("https://evil.example/v1", get("https://evil.example/v1/pets")),
		])
		expect(refused.map((outcome) => (outcome.ok ? "sent" : outcome.reason))).toEqual(
			refused.map(() => "wrong_server"),
		)
		expect(sent).toEqual([])
		expect(JSON.stringify(refused)).not.toContain(KEY)
	})

	it("answers a redirect instead of following it", async () => {
		const { api, sent } = upstream(
			header,
			() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
		)
		const outcome = await api.call(BASE, get(`${BASE}/pets`))
		expect(outcome).toMatchObject({ ok: true, status: 302 })
		expect(sent).toHaveLength(1)
		expect(sent[0]?.redirect).toBe("manual")
	})

	it("keeps the key out of a response that echoes it, plain or encoded", async () => {
		const awkward = "key with/odd+chars&more~"
		const { api, sent } = upstream(
			{ baseUrl: BASE, key: { token: awkward, placement: { in: "query", name: "k" } } },
			(request) => Response.json({ url: request.url, plain: awkward, header: `Bearer ${awkward}` }),
		)
		const outcome = await api.call(BASE, get(`${BASE}/echo`))
		expect(outcome.ok).toBe(true)
		// The key as it went out on the wire, read from the URL actually sent.
		const onTheWire = /[?&]k=([^&]*)/u.exec(sent[0]?.url ?? "")?.[1] ?? ""
		expect(onTheWire).not.toBe(encodeURIComponent(awkward))
		const text = JSON.stringify(outcome)
		for (const spelling of [awkward, encodeURIComponent(awkward), onTheWire]) {
			expect(text).not.toContain(spelling)
		}
		expect(text).toContain("[redacted]")
	})

	it("keeps the key out of a failure's message", async () => {
		const api = makeApiUpstream(
			() => header,
			() => Promise.reject(new Error(`connect failed for x-api-key ${KEY}`)),
		)
		const outcome = await api.call(BASE, get(`${BASE}/pets`))
		expect(outcome).toMatchObject({ ok: false, reason: "failed" })
		expect(JSON.stringify(outcome)).not.toContain(KEY)
	})

	it("cuts a long response and says so", async () => {
		const { api } = upstream(header, () => new Response("y".repeat(MAX_API_RESPONSE_BYTES * 2)))
		const outcome = await api.call(BASE, get(`${BASE}/big`))
		expect(outcome).toMatchObject({ ok: true, truncated: true })
		expect(outcome.ok && outcome.body.length).toBe(MAX_API_RESPONSE_TEXT_LENGTH)

		const short = upstream(header, () => new Response("y".repeat(MAX_API_RESPONSE_TEXT_LENGTH)))
		expect(await short.api.call(BASE, get(`${BASE}/small`))).toMatchObject({
			ok: true,
			truncated: false,
		})
	})

	it("does not let through the start of a key that the cut split", async () => {
		// Echoed copies of a long key shrink to their mark, so what follows the last whole one
		// is within what is returned.
		const long = `key_LONG_${"k".repeat(190)}`
		const copies = Math.ceil(MAX_API_RESPONSE_BYTES / long.length) + 1
		const { api } = upstream(
			{ baseUrl: BASE, key: { token: long, placement: { in: "header", name: "X-Api-Key" } } },
			() => new Response(long.repeat(copies)),
		)
		const outcome = await api.call(BASE, get(`${BASE}/big`))
		expect(outcome).toMatchObject({ ok: true, truncated: true })
		expect(MAX_API_RESPONSE_BYTES % long.length).toBeGreaterThan(8)
		expect(JSON.stringify(outcome)).not.toContain("key_LONG")
	})

	it("sends nothing once the credential is gone, and no key when it holds none", async () => {
		const gone = upstream(null)
		expect(await gone.api.call(BASE, get(`${BASE}/pets`))).toMatchObject({
			ok: false,
			reason: "credential_unavailable",
		})
		expect(gone.sent).toEqual([])

		const open = upstream({ baseUrl: BASE, key: null })
		await open.api.call(BASE, get(`${BASE}/pets`, { authorization: "Bearer theirs" }))
		expect(open.sent[0]?.headers).toEqual({})
	})

	it("counts a URL as under the base only on its origin and beneath its path", () => {
		const under = (url: string) => isUnderBaseUrl(new URL(url), BASE)
		expect(under(`${BASE}`)).toBe(true)
		expect(under(`${BASE}/pets/1?x=1`)).toBe(true)
		expect(under("https://api.shop.example/v1x")).toBe(false)
		expect(under("https://api.shop.example:8443/v1/pets")).toBe(false)
		expect(
			isUnderBaseUrl(new URL("https://api.shop.example/anything"), "https://api.shop.example/"),
		).toBe(true)
	})
})
