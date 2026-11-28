import { THEME_SCRIPT } from "@checkfu/ui/theme-script"

interface Env {
	readonly API: { readonly fetch: typeof globalThis.fetch }
	readonly ASSETS: { readonly fetch: typeof globalThis.fetch }
	readonly CHECKFU_API_KEY?: string
	readonly CHECKFU_PUBLIC_API_URL?: string
}

const COOKIE = "__Host-checkfu_session"
const SESSION_SECONDS = 60 * 60 * 24 * 7
const MIN_SIGN_IN_BYTES = 4096
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

const localHost = (url: URL): string | undefined =>
	LOOPBACK.has(url.hostname) || url.hostname.endsWith(".localhost")
		? `app-${url.port === "" ? "local" : url.port}.localhost`
		: undefined
const NO_STORE = { "cache-control": "no-store" }
const utf8 = new TextEncoder()

const assetPolicy = async (): Promise<string> => {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(THEME_SCRIPT)))
	const script = btoa(String.fromCodePoint(...hash))
	return [
		"default-src 'self'",
		`script-src 'self' 'sha256-${script}'`,
		"img-src 'self' data: blob:",
		"style-src 'self' 'unsafe-inline'",
		"frame-src 'none'",
		"frame-ancestors 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
	].join("; ")
}
let assetsPolicy: Promise<string> | undefined

const dashboardAsset = async (response: Response): Promise<Response> => {
	const headers = new Headers(response.headers)
	headers.set("x-content-type-options", "nosniff")
	headers.set("x-frame-options", "DENY")
	headers.set("referrer-policy", "same-origin")
	headers.set("content-security-policy", await (assetsPolicy ??= assetPolicy()))
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

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

const sessionPayload = (audience: string, expires: number, binding: string) =>
	utf8.encode(`checkfu-dashboard-session:${audience}:${expires}:${binding}`)

const issueSession = async (apiKey: string, audience: string, now: number): Promise<string> => {
	const expires = now + SESSION_SECONDS * 1000
	const binding = base64url(crypto.getRandomValues(new Uint8Array(16)).buffer)
	const mac = await crypto.subtle.sign(
		"HMAC",
		await sessionKey(apiKey),
		sessionPayload(audience, expires, binding),
	)
	return `${expires}.${binding}.${base64url(mac)}`
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

export const authenticateDashboardSession = async (
	request: Request,
	apiKey: string | undefined,
	now: number,
): Promise<{ readonly browserBinding: string } | undefined> => {
	const token = sessionFrom(request)
	if (token === undefined || apiKey === undefined || apiKey === "") {
		return undefined
	}
	const [expiresText, binding, macText, excess] = token.split(".")
	const expires = Number(expiresText)
	const mac = macText === undefined ? undefined : fromBase64url(macText)
	if (
		!Number.isSafeInteger(expires) ||
		expires <= now ||
		binding === undefined ||
		!/^[A-Za-z0-9_-]{22}$/u.test(binding) ||
		mac === undefined ||
		excess !== undefined
	) {
		return undefined
	}
	const valid = await crypto.subtle.verify(
		"HMAC",
		await sessionKey(apiKey),
		mac,
		sessionPayload(new URL(request.url).origin, expires, binding),
	)
	return valid ? { browserBinding: binding } : undefined
}

const signedIn = async (request: Request, env: Env, now: number): Promise<boolean> =>
	(await authenticateDashboardSession(request, env.CHECKFU_API_KEY, now)) !== undefined

const sameKey = async (submitted: string, apiKey: string): Promise<boolean> => {
	const key = await sessionKey(apiKey)
	const expected = await crypto.subtle.sign("HMAC", key, utf8.encode(`sign-in:${apiKey}`))
	return crypto.subtle.verify("HMAC", key, expected, utf8.encode(`sign-in:${submitted}`))
}

const signInLimit = (apiKey: string): number =>
	Math.max(MIN_SIGN_IN_BYTES, "key=".length + 3 * utf8.encode(apiKey).byteLength)

const boundedText = async (request: Request, limit: number): Promise<string | undefined> => {
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
		if (size > limit) {
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
	const body = await boundedText(request, signInLimit(env.CHECKFU_API_KEY))
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
		if (url.pathname === "/auth/deployment" && request.method === "GET") {
			if (!(await signedIn(request, env, now))) {
				return new Response(null, { status: 401, headers: NO_STORE })
			}
			const apiUrl = env.CHECKFU_PUBLIC_API_URL
			return apiUrl === undefined || apiUrl === ""
				? new Response(null, { status: 503, headers: NO_STORE })
				: Response.json({ api_url: apiUrl }, { headers: NO_STORE })
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
		return dashboardAsset(await env.ASSETS.fetch(request))
	},
}
