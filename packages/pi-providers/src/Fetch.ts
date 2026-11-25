const EXPLICIT_LOOPBACK_PORT = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):(\d+)(?:\/|$)/i

const readNativeUrlHref = (input: unknown): string | null => {
	const descriptor = Object.getOwnPropertyDescriptor(URL.prototype, "href")
	if (descriptor?.get === undefined) {
		return null
	}
	try {
		const href: unknown = descriptor.get.call(input)
		return typeof href === "string" ? href : null
	} catch {
		return null
	}
}

const isRedirectStatus = (status: number): boolean => status >= 300 && status < 400

const discardResponseBody = (body: Response["body"]): void => {
	if (body === null) {
		return
	}
	void body.cancel().catch(() => undefined)
}

export const parseLoopbackBaseUrl = (raw: string, envLabel = "provider base URL"): string => {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		throw new TypeError(`Invalid ${envLabel}: must be a valid URL.`)
	}
	const portMatch = EXPLICIT_LOOPBACK_PORT.exec(raw)
	const portNumber = portMatch?.[1] === undefined ? Number.NaN : Number(portMatch[1])
	const isLoopbackHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"
	if (
		parsed.protocol !== "http:" ||
		!isLoopbackHost ||
		!Number.isInteger(portNumber) ||
		portNumber < 1 ||
		portNumber > 65_535 ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0 ||
		raw.includes("?") ||
		raw.includes("#")
	) {
		throw new TypeError(
			`Refusing non-loopback ${envLabel}: only http://127.0.0.1:<port> or http://[::1]:<port> URLs are allowed.`,
		)
	}
	const pathname = parsed.pathname.replace(/\/+$/, "")
	return `${parsed.protocol}//${parsed.hostname}:${portNumber}${pathname}`
}

const IPV4_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const isDisallowedPrivateOrLoopbackHost = (hostname: string): boolean => {
	const lower = hostname.toLowerCase().replace(/\.+$/, "")
	if (lower === "localhost" || lower.endsWith(".localhost")) {
		return true
	}
	if (lower.startsWith("[") && lower.endsWith("]")) {
		const inner = lower.slice(1, -1)
		if (
			inner === "::" ||
			inner === "::1" ||
			inner.startsWith("fc") ||
			inner.startsWith("fd") ||
			inner.startsWith("fe8") ||
			inner.startsWith("fe9") ||
			inner.startsWith("fea") ||
			inner.startsWith("feb") ||
			inner.startsWith("::ffff:")
		) {
			return true
		}
		return false
	}
	const match = IPV4_OCTETS.exec(lower)
	if (match === null) {
		return false
	}
	const a = Number(match[1])
	const b = Number(match[2])
	const c = Number(match[3])
	const d = Number(match[4])
	if ([a, b, c, d].some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		return true
	}
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	)
}

export const parseProviderBaseUrl = (
	raw: string,
	options: { readonly allowLoopbackHttp: boolean; readonly label?: string },
): string => {
	const label = options.label ?? "provider base URL"
	const trimmed = raw.trim()
	if (trimmed.length === 0) {
		throw new TypeError(`Invalid ${label}: must be a non-empty URL.`)
	}
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		throw new TypeError(`Invalid ${label}: must be a valid URL.`)
	}
	if (parsed.protocol === "http:") {
		if (!options.allowLoopbackHttp) {
			throw new TypeError(
				`Invalid ${label}: must use https:// (http:// is allowed only in local dev).`,
			)
		}
		return parseLoopbackBaseUrl(trimmed, label)
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname.length === 0 ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0 ||
		trimmed.includes("?") ||
		trimmed.includes("#")
	) {
		throw new TypeError(
			`Invalid ${label}: must be an https:// URL without credentials, query string, or fragment.`,
		)
	}
	if (isDisallowedPrivateOrLoopbackHost(parsed.hostname)) {
		throw new TypeError(`Refusing private or loopback host "${parsed.hostname}" for ${label}.`)
	}
	const pathname = parsed.pathname.replace(/\/+$/, "")
	return `${parsed.origin}${pathname}`
}

export interface PinnedProviderBaseUrl {
	readonly origin: string
	readonly baseUrl: string
}

export const parsePinnedProviderBaseUrl = (
	raw: string | undefined,
	label = "provider base URL",
): PinnedProviderBaseUrl => {
	if (typeof raw !== "string") {
		throw new TypeError(`Invalid ${label}: must be a non-empty https:// or loopback http:// URL.`)
	}
	const baseUrl = parseProviderBaseUrl(raw, { allowLoopbackHttp: true, label })
	return {
		origin: new URL(baseUrl).origin,
		baseUrl,
	}
}

export const createNoRedirectProviderFetch = (
	expectedBaseUrl: string,
	upstreamFetch?: typeof fetch,
): typeof fetch => {
	const expectedOrigin = new URL(expectedBaseUrl).origin
	const guardedFetch = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		let rawUrl: string
		if (typeof input === "string") {
			rawUrl = input
		} else {
			const nativeHref = readNativeUrlHref(input)
			if (nativeHref === null) {
				throw new TypeError(
					"Refusing provider request: only URL strings and URL instances are supported.",
				)
			}
			rawUrl = nativeHref
		}
		let parsed: URL
		try {
			parsed = new URL(rawUrl)
		} catch {
			throw new TypeError(`Refusing provider request to invalid URL: ${rawUrl}`)
		}
		if (parsed.origin !== expectedOrigin) {
			throw new TypeError(
				`Refusing provider request to disallowed origin ${parsed.origin}; expected ${expectedOrigin}.`,
			)
		}
		const baseFetch = upstreamFetch ?? globalThis.fetch
		const requestInit: RequestInit =
			init === undefined ? { redirect: "manual" } : { ...init, redirect: "manual" }
		const response = await baseFetch(parsed.href, requestInit)
		if (
			response.redirected ||
			response.type === "opaqueredirect" ||
			isRedirectStatus(response.status)
		) {
			discardResponseBody(response.body)
			throw new TypeError(
				`Provider request to ${parsed.origin} attempted a redirect, which is not allowed.`,
			)
		}
		return response
	}
	return guardedFetch
}
