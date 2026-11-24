import type { HttpRequestDescription } from "../OpenApi/OpenApiTypes.ts"
import { makeScrubber, secretForms } from "./Scrub.ts"
import type { HeldPlacement } from "./SecretCustody.ts"

export const API_CALL_TIMEOUT_MS = 60_000
/** How much of a response is read at all; the rest of the body is never taken off the wire. */
export const MAX_API_RESPONSE_BYTES = 512 * 1024
/** How much of a response is returned. A longer body is cut and marked. */
export const MAX_API_RESPONSE_TEXT_LENGTH = 100_000

// Set by the connection alone, whatever the request names.
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
])

export type ApiFailureReason = "credential_unavailable" | "wrong_server" | "failed"

export interface ApiFailure {
	readonly ok: false
	readonly reason: ApiFailureReason
	readonly message: string
}

export type ApiCallOutcome =
	| {
			readonly ok: true
			readonly status: number
			readonly contentType: string | null
			readonly body: string
			readonly truncated: boolean
	  }
	| ApiFailure

/** Where a connection may send requests, and the key it attaches there, if it holds one. */
export interface ApiTarget {
	readonly baseUrl: string
	readonly key: { readonly token: string; readonly placement: HeldPlacement } | null
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

const failure = (reason: ApiFailureReason, message: string): ApiFailure => ({
	ok: false,
	reason,
	message,
})

/** Whether `url` is on the base URL's origin and under its path. */
export const isUnderBaseUrl = (url: URL, baseUrl: string): boolean => {
	if (!URL.canParse(baseUrl)) {
		return false
	}
	const base = new URL(baseUrl)
	const prefix = base.pathname.replace(/\/+$/u, "")
	return (
		url.origin === base.origin &&
		url.username === "" &&
		url.password === "" &&
		(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
	)
}

const boundedText = async (
	response: Response,
): Promise<{ readonly text: string; readonly cut: boolean }> => {
	const reader = response.body?.getReader()
	if (reader === undefined) {
		return { text: "", cut: false }
	}
	const decoder = new TextDecoder()
	let text = ""
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			return { text: text + decoder.decode(), cut: false }
		}
		const room = MAX_API_RESPONSE_BYTES - size
		if (value.byteLength > room) {
			await reader.cancel()
			return { text: text + decoder.decode(value.subarray(0, room)), cut: true }
		}
		size += value.byteLength
		text += decoder.decode(value, { stream: true })
	}
}

/**
 * The HTTP client of one connection. It sends a request only to the
 * connection's own base URL, whatever URL a caller names, attaches the key
 * itself after dropping any credential the request carries, follows no
 * redirect, and keeps the key out of everything it returns.
 */
export const makeApiUpstream = (target: () => ApiTarget | null, fetchFn?: FetchLike) => {
	const send: FetchLike = fetchFn ?? ((input, init) => fetch(input, init))
	return {
		call: async (baseUrl: string, request: HttpRequestDescription): Promise<ApiCallOutcome> => {
			const to = target()
			if (to === null) {
				return failure(
					"credential_unavailable",
					"The credential for this API is no longer available.",
				)
			}
			if (to.baseUrl !== baseUrl || !URL.canParse(request.url)) {
				return failure("wrong_server", "This connection is for a different API.")
			}
			const url = new URL(request.url)
			if (!isUnderBaseUrl(url, to.baseUrl)) {
				return failure("wrong_server", "This connection is for a different API.")
			}
			const placement = to.key?.placement
			const reserved = placement?.in === "header" ? placement.name.toLowerCase() : undefined
			const headers = new Headers()
			for (const [name, value] of Object.entries(request.headers)) {
				const lower = name.toLowerCase()
				if (!CREDENTIAL_HEADERS.has(lower) && lower !== reserved) {
					headers.set(name, value)
				}
			}
			if (to.key !== null && placement !== undefined) {
				if (placement.in === "header") {
					headers.set(placement.name, `${placement.prefix ?? ""}${to.key.token}`)
				} else {
					url.searchParams.set(placement.name, to.key.token)
				}
			}
			const token = to.key?.token
			const scrub = makeScrubber(token === undefined ? [] : [token])
			try {
				const response = await send(url, {
					method: request.method,
					headers,
					...(request.body === undefined ? {} : { body: request.body }),
					// A redirect would carry the key to a server it was not stored for.
					redirect: "manual",
					signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS),
				})
				const { text, cut } = await boundedText(response)
				const clean = scrub.body(response.headers.get("content-type"), text)
				// A key cut in two at the bound would no longer match; what could be its start goes too.
				const partial =
					token === undefined ? 0 : Math.max(0, ...secretForms(token).map((form) => form.length))
				const whole = cut && partial > 0 ? clean.slice(0, -partial) : clean
				const body = whole.slice(0, MAX_API_RESPONSE_TEXT_LENGTH)
				return {
					ok: true,
					status: response.status,
					contentType: response.headers.get("content-type"),
					body,
					truncated: cut || body.length < whole.length,
				}
			} catch (error) {
				return failure("failed", scrub.text(`The API request failed: ${String(error)}`))
			}
		},
	}
}

export type ApiUpstream = ReturnType<typeof makeApiUpstream>
