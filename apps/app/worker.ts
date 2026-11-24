interface Env {
	readonly API: { readonly fetch: typeof globalThis.fetch }
	readonly ASSETS: { readonly fetch: typeof globalThis.fetch }
}

const COOKIE = "checkfu_key"
const MAX_AGE = 60 * 60 * 24 * 30
const MAX_SIGN_IN_BYTES = 4096
const SHARED_LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])
const NO_STORE = { "cache-control": "no-store" }

const cookie = (value: string, maxAge: number): string =>
	`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`

const keyFrom = (request: Request): string | undefined => {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=")
		if (name === COOKIE) {
			return decodeURIComponent(value.join("="))
		}
	}
	return undefined
}

const verify = (env: Env, origin: string, key: string): Promise<Response> =>
	env.API.fetch(`${origin}/v1/auth/verify`, { headers: { authorization: `Bearer ${key}` } })

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

const signIn = async (request: Request, env: Env, origin: string): Promise<Response> => {
	if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
		return new Response(null, { status: 415 })
	}
	const body = await boundedText(request)
	if (body === undefined) {
		return new Response(null, { status: 413 })
	}
	const key = new URLSearchParams(body).get("key")
	if (key === null || key.trim() === "") {
		return new Response(null, { status: 400 })
	}
	const verified = await verify(env, origin, key.trim())
	if (!verified.ok) {
		return new Response(null, { status: verified.status === 401 ? 401 : 502 })
	}
	return new Response(null, {
		status: 204,
		headers: { "set-cookie": cookie(encodeURIComponent(key.trim()), MAX_AGE) },
	})
}

const proxy = (request: Request, env: Env): Promise<Response> => {
	const headers = new Headers(request.headers)
	headers.delete("cookie")
	headers.delete("x-api-key")
	headers.delete("authorization")
	const key = keyFrom(request)
	if (key !== undefined) {
		headers.set("authorization", `Bearer ${key}`)
	}
	return env.API.fetch(new Request(request, { headers }))
}

export default {
	fetch: async (request: Request, env: Env): Promise<Response> => {
		const url = new URL(request.url)
		const unsafe = request.method !== "GET" && request.method !== "HEAD"
		if (SHARED_LOOPBACK.has(url.hostname)) {
			if (unsafe) {
				return new Response(null, { status: 421 })
			}
			url.hostname = "app.localhost"
			return Response.redirect(url.href, 307)
		}
		if (unsafe && request.headers.get("origin") !== url.origin) {
			return new Response(null, { status: 403 })
		}
		if (url.pathname.startsWith("/v1/")) {
			return proxy(request, env)
		}
		if (url.pathname === "/auth/session" && request.method === "GET") {
			const key = keyFrom(request)
			if (key === undefined) {
				return new Response(null, { status: 401, headers: NO_STORE })
			}
			const verified = await verify(env, url.origin, key)
			return new Response(null, {
				status: verified.ok ? 204 : verified.status === 401 ? 401 : 502,
				headers: NO_STORE,
			})
		}
		if (url.pathname === "/auth/sign-in" && request.method === "POST") {
			return signIn(request, env, url.origin)
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
