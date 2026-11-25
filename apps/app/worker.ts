interface Env {
	readonly API: { readonly fetch: typeof globalThis.fetch }
	readonly ASSETS: { readonly fetch: typeof globalThis.fetch }
	readonly CHECKFU_API_KEY?: string
}

const COOKIE = "__Host-checkfu_session"
const SESSION_SECONDS = 60 * 60 * 24 * 7
const MAX_SIGN_IN_BYTES = 4096
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

const localHost = (url: URL): string | undefined =>
	LOOPBACK.has(url.hostname) || url.hostname.endsWith(".localhost")
		? `app-${url.port === "" ? "local" : url.port}.localhost`
		: undefined
const NO_STORE = { "cache-control": "no-store" }
const utf8 = new TextEncoder()

const cookie = (value: string, maxAge: number): string =>
	`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`

const sessionKey = (apiKey: string) =>
	crypto.subtle.importKey("raw", utf8.encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	])

const base64url = (bytes: ArrayBuffer): string =>
	btoa(String.fromCodePoint(...new Uint8Array(bytes)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "")

const fromBase64url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
	try {
		const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"))
		return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0)
	} catch {
		return undefined
	}
}

const sessionPayload = (audience: string, expires: number) =>
	utf8.encode(`checkfu-dashboard-session:${audience}:${expires}`)

const issueSession = async (apiKey: string, audience: string, now: number): Promise<string> => {
	const expires = now + SESSION_SECONDS * 1000
	const mac = await crypto.subtle.sign(
		"HMAC",
		await sessionKey(apiKey),
		sessionPayload(audience, expires),
	)
	return `${expires}.${base64url(mac)}`
}

const sessionFrom = (request: Request): string | undefined => {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [name, value] = part.trim().split("=", 2)
		if (name === COOKIE && value !== undefined) {
			return value
		}
	}
	return undefined
}

const signedIn = async (request: Request, env: Env, now: number): Promise<boolean> => {
	const token = sessionFrom(request)
	if (token === undefined || env.CHECKFU_API_KEY === undefined || env.CHECKFU_API_KEY === "") {
		return false
	}
	const [expiresText, macText] = token.split(".", 2)
	const expires = Number(expiresText)
	const mac = macText === undefined ? undefined : fromBase64url(macText)
	if (!Number.isSafeInteger(expires) || expires <= now || mac === undefined) {
		return false
	}
	return crypto.subtle.verify(
		"HMAC",
		await sessionKey(env.CHECKFU_API_KEY),
		mac,
		sessionPayload(new URL(request.url).origin, expires),
	)
}

const sameKey = async (submitted: string, apiKey: string): Promise<boolean> => {
	const key = await sessionKey(apiKey)
	const expected = await crypto.subtle.sign("HMAC", key, utf8.encode(`sign-in:${apiKey}`))
	return crypto.subtle.verify("HMAC", key, expected, utf8.encode(`sign-in:${submitted}`))
}

const boundedText = async (request: Request): Promise<string | undefined> => {
	if (request.body === null) {
		return ""
	}
	const reader = request.body.getReader()
	const chunks: Array<Uint8Array> = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			const bytes = new Uint8Array(size)
			let offset = 0
			for (const chunk of chunks) {
				bytes.set(chunk, offset)
				offset += chunk.byteLength
			}
			return new TextDecoder().decode(bytes)
		}
		size += value.byteLength
		if (size > MAX_SIGN_IN_BYTES) {
			await reader.cancel()
			return undefined
		}
		chunks.push(value)
	}
}

const signIn = async (request: Request, env: Env, now: number): Promise<Response> => {
	if (env.CHECKFU_API_KEY === undefined || env.CHECKFU_API_KEY === "") {
		return new Response(null, { status: 503 })
	}
	if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
		return new Response(null, { status: 415 })
	}
	const body = await boundedText(request)
	if (body === undefined) {
		return new Response(null, { status: 413 })
	}
	const key = new URLSearchParams(body).get("key")?.trim()
	if (key === undefined || key === "") {
		return new Response(null, { status: 400 })
	}
	if (!(await sameKey(key, env.CHECKFU_API_KEY))) {
		return new Response(null, { status: 401 })
	}
	return new Response(null, {
		status: 204,
		headers: {
			"set-cookie": cookie(
				await issueSession(env.CHECKFU_API_KEY, new URL(request.url).origin, now),
				SESSION_SECONDS,
			),
		},
	})
}

const proxy = async (request: Request, env: Env, now: number): Promise<Response> => {
	const headers = new Headers(request.headers)
	headers.delete("cookie")
	headers.delete("x-api-key")
	headers.delete("authorization")
	if (env.CHECKFU_API_KEY !== undefined && (await signedIn(request, env, now))) {
		headers.set("authorization", `Bearer ${env.CHECKFU_API_KEY}`)
	}
	return env.API.fetch(new Request(request, { headers }))
}

export default {
	fetch: async (request: Request, env: Env): Promise<Response> => {
		const url = new URL(request.url)
		const now = Date.now()
		const unsafe = request.method !== "GET" && request.method !== "HEAD"
		const local = localHost(url)
		if (local !== undefined && url.hostname !== local) {
			if (unsafe) {
				return new Response(null, { status: 421 })
			}
			url.hostname = local
			return Response.redirect(url.href, 307)
		}
		if (unsafe && request.headers.get("origin") !== url.origin) {
			return new Response(null, { status: 403 })
		}
		if (url.pathname.startsWith("/v1/")) {
			return proxy(request, env, now)
		}
		if (url.pathname === "/auth/session" && request.method === "GET") {
			return new Response(null, {
				status: (await signedIn(request, env, now)) ? 204 : 401,
				headers: NO_STORE,
			})
		}
		if (url.pathname === "/auth/sign-in" && request.method === "POST") {
			return signIn(request, env, now)
		}
		if (url.pathname === "/auth/sign-out" && request.method === "POST") {
			return new Response(null, { status: 204, headers: { "set-cookie": cookie("", 0) } })
		}
		if (url.pathname.startsWith("/auth/")) {
			return new Response(null, { status: 404 })
		}
		return env.ASSETS.fetch(request)
	},
}
