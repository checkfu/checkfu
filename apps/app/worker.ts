interface Env {
	readonly API: { readonly fetch: typeof globalThis.fetch }
	readonly ASSETS: { readonly fetch: typeof globalThis.fetch }
}

const COOKIE = "checkfu_key"
const MAX_AGE = 60 * 60 * 24 * 30

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

const signIn = async (request: Request, env: Env, origin: string): Promise<Response> => {
	const form = await request.formData().catch(() => undefined)
	const key = form?.get("key")
	if (typeof key !== "string" || key.trim() === "") {
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
		if (unsafe && request.headers.get("origin") !== url.origin) {
			return new Response(null, { status: 403 })
		}
		if (url.pathname.startsWith("/v1/")) {
			return proxy(request, env)
		}
		if (url.pathname === "/auth/session" && request.method === "GET") {
			const key = keyFrom(request)
			if (key === undefined) {
				return new Response(null, { status: 401 })
			}
			const verified = await verify(env, url.origin, key)
			return new Response(null, { status: verified.ok ? 204 : 401 })
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
