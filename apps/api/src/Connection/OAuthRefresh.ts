import { OAuthError, OAuthErrorCode, refreshAuthorization } from "@modelcontextprotocol/client"
import type { AddClientAuthentication, OAuthTokens } from "@modelcontextprotocol/client"
import type { HeldOAuth, HeldRefresh, HeldSecret } from "./SecretCustody.ts"

/** Refresh this long before the token expires, so a call in flight does not outlive it. */
export const REFRESH_SKEW_MS = 60_000
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
/** Waits between attempts while the authorization server is unreachable or failing. */
export const REFRESH_RETRY_DELAYS_MS: ReadonlyArray<number> = [250, 1000]
/** Waits between tries to store a refresh's outcome when storage fails. */
export const STORE_RETRY_DELAYS_MS: ReadonlyArray<number> = [50, 250]
/** Longest one attempt may take, its answer's body included. */
export const REFRESH_ATTEMPT_TIMEOUT_MS = 10_000
/** The largest instant a JavaScript date can hold. */
const MAX_DATE_MS = 8.64e15

export type TokenUnavailable =
	| "credential_unavailable"
	| "reauthorization_required"
	| "refresh_unavailable"

export type TokenOutcome =
	| { readonly ok: true; readonly token: string }
	| { readonly ok: false; readonly reason: TokenUnavailable }

/** What a refused token leads to: one more try, nothing, or the reason no token can be had. */
export type RecoverOutcome = "retry" | "none" | TokenUnavailable

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface OAuthRefreshDeps {
	readonly read: () => HeldSecret | null
	/** The held secret's revision, which every write of it moves on. */
	readonly revision: () => number
	/**
	 * Stores a refresh's outcome in one write, over the revision it started
	 * from. False when nothing is held any more or the secret changed meanwhile.
	 */
	readonly write: (next: HeldOAuth, from: number) => boolean
	/** Runs work with no replacement, erasure or other refresh of the secret in between. */
	readonly exclusive: <A>(work: () => A | Promise<A>) => Promise<A>
	/** The MCP server the credential is bound to, named as the audience of a renewed token. */
	readonly resource: () => string | null
	readonly now: () => number
	readonly warn?: (message: string) => void
	readonly fetchFn?: FetchLike
	readonly sleep?: (ms: number) => Promise<void>
	readonly attemptTimeoutMs?: number
}

const TRANSIENT: ReadonlySet<string> = new Set([
	OAuthErrorCode.ServerError,
	OAuthErrorCode.TemporarilyUnavailable,
])

const isRefused = (error: unknown): boolean =>
	OAuthError.isInstance(error) && !TRANSIENT.has(error.code)

const boundedText = async (response: Response): Promise<string> => {
	const reader = response.body?.getReader()
	if (reader === undefined) {
		return ""
	}
	const decoder = new TextDecoder()
	let text = ""
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			return text + decoder.decode()
		}
		size += value.byteLength
		if (size > MAX_TOKEN_RESPONSE_BYTES) {
			await reader.cancel()
			throw new Error("token response too large")
		}
		text += decoder.decode(value, { stream: true })
	}
}

/**
 * The token endpoint is a customer's input. It is asked once per attempt, a
 * redirect is an answer and never a place to go, and its reply is read up to
 * a bound.
 */
const pinned =
	(fetchFn: FetchLike, signal: AbortSignal): FetchLike =>
	async (input, init) => {
		const response = await fetchFn(input, { ...init, redirect: "manual", signal })
		if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
			await response.body?.cancel()
			throw new Error("token endpoint redirected")
		}
		return new Response(await boundedText(response), {
			status: response.status,
			headers: response.headers,
		})
	}

/** One value form-encoded, as RFC 6749 §2.3.1 asks of a Basic client id and secret. */
const formEncoded = (value: string): string => new URLSearchParams({ v: value }).toString().slice(2)

/**
 * HTTP Basic client authentication with each part form-encoded first, so a
 * colon in the client id stays in the client id and any character can be sent.
 * The encoded parts are ASCII, so their base64 is well defined.
 */
export const basicClientAuthentication =
	(clientId: string, clientSecret: string): AddClientAuthentication =>
	(headers) => {
		headers.set(
			"Authorization",
			`Basic ${btoa(`${formEncoded(clientId)}:${formEncoded(clientSecret)}`)}`,
		)
	}

const request = (
	refresh: HeldRefresh,
	resource: string | null,
	fetchFn: FetchLike,
	signal: AbortSignal,
) => {
	const endpoint = new URL(refresh.token_endpoint)
	return refreshAuthorization(endpoint.origin, {
		metadata: {
			issuer: endpoint.origin,
			authorization_endpoint: refresh.token_endpoint,
			token_endpoint: refresh.token_endpoint,
			response_types_supported: ["code"],
			token_endpoint_auth_methods_supported: [refresh.auth.type],
		},
		clientInformation: {
			client_id: refresh.client_id,
			token_endpoint_auth_method: refresh.auth.type,
			...(refresh.auth.type === "none" ? {} : { client_secret: refresh.auth.client_secret }),
		},
		...(refresh.auth.type === "client_secret_basic"
			? {
					addClientAuthentication: basicClientAuthentication(
						refresh.client_id,
						refresh.auth.client_secret,
					),
				}
			: {}),
		refreshToken: refresh.refresh_token,
		...(refresh.scope === null ? {} : { scope: refresh.scope }),
		...(resource === null ? {} : { resource }),
		fetchFn: pinned(fetchFn, signal),
	})
}

/** What one exchange with the token endpoint came to. */
type Exchange =
	| { readonly kind: "granted"; readonly tokens: OAuthTokens }
	| { readonly kind: "refused" }
	| { readonly kind: "unavailable" }

/**
 * Keeps one credential's OAuth access token usable. However many calls need
 * a token at once, one refresh is made and they all wait for it: a refresh
 * token is often good for a single use. Each attempt runs exclusively with
 * replacement and erasure of the secret, so neither can come between an
 * exchange and the write of what it returned.
 */
export const makeOAuthRefresher = (deps: OAuthRefreshDeps) => {
	const fetchFn: FetchLike = deps.fetchFn ?? ((input, init) => fetch(input, init))
	const sleep =
		deps.sleep ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, ms)
			}))
	let inflight: Promise<TokenOutcome> | undefined

	/** What the secret holds now, for a refresh whose own outcome no longer counts. */
	const standing = (): TokenOutcome => {
		const current = deps.read()
		if (current === null || current.type !== "mcp_oauth") {
			return { ok: false, reason: "credential_unavailable" }
		}
		return current.refresh_failed
			? { ok: false, reason: "reauthorization_required" }
			: { ok: true, token: current.access_token }
	}

	/** One request, given up after its deadline even if the endpoint never answers. */
	const exchange = async (refresh: HeldRefresh): Promise<Exchange> => {
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort()
				reject(new Error("token endpoint timed out"))
			}, deps.attemptTimeoutMs ?? REFRESH_ATTEMPT_TIMEOUT_MS)
		})
		try {
			const tokens = await Promise.race([
				request(refresh, deps.resource(), fetchFn, controller.signal),
				deadline,
			])
			return { kind: "granted", tokens }
		} catch (error) {
			return isRefused(error) ? { kind: "refused" } : { kind: "unavailable" }
		} finally {
			clearTimeout(timer)
		}
	}

	/** An expiry the clock can hold, or none: a token with no known expiry is refreshed on refusal. */
	const expiry = (expiresIn: number | undefined): number | null => {
		if (expiresIn === undefined) {
			return null
		}
		const at = deps.now() + expiresIn * 1000
		if (Number.isFinite(at) && Math.abs(at) <= MAX_DATE_MS) {
			return at
		}
		deps.warn?.(`Ignored a token expiry no date can hold (expires_in ${expiresIn})`)
		return null
	}

	/**
	 * Stores a refresh's outcome, retrying storage that fails. The exchange is
	 * never repeated for it: its refresh token may already be spent.
	 */
	const store = async (
		next: HeldOAuth,
		from: number,
		outcome: TokenOutcome,
	): Promise<TokenOutcome> => {
		for (let tried = 0; ; tried++) {
			try {
				// Handed out only once stored.
				return deps.write(next, from) ? outcome : standing()
			} catch (error) {
				const delay = STORE_RETRY_DELAYS_MS[tried]
				if (delay === undefined) {
					deps.warn?.(`A refreshed token could not be stored: ${String(error)}`)
					return { ok: false, reason: "refresh_unavailable" }
				}
				await sleep(delay)
			}
		}
	}

	const attempt = async (): Promise<TokenOutcome> => {
		const from = deps.revision()
		for (let tried = 0; ; tried++) {
			const outcome = await deps.exclusive(async (): Promise<TokenOutcome | undefined> => {
				// Read afresh each time: during a wait the secret may have been replaced or erased,
				// and then it is not this refresh's to renew.
				const current = deps.read()
				if (
					current === null ||
					current.type !== "mcp_oauth" ||
					current.refresh === null ||
					current.refresh_failed ||
					deps.revision() !== from
				) {
					return standing()
				}
				const result = await exchange(current.refresh)
				if (result.kind === "refused") {
					return store({ ...current, refresh_failed: true }, from, {
						ok: false,
						reason: "reauthorization_required",
					})
				}
				if (result.kind === "unavailable") {
					return undefined
				}
				const { tokens } = result
				return store(
					{
						...current,
						access_token: tokens.access_token,
						expires_at: expiry(tokens.expires_in),
						refresh: {
							...current.refresh,
							refresh_token: tokens.refresh_token ?? current.refresh.refresh_token,
						},
						refresh_failed: false,
					},
					from,
					{ ok: true, token: tokens.access_token },
				)
			})
			if (outcome !== undefined) {
				return outcome
			}
			const delay = REFRESH_RETRY_DELAYS_MS[tried]
			if (delay === undefined) {
				return { ok: false, reason: "refresh_unavailable" }
			}
			// Waited outside the exclusive section, so a replacement or erasure can land meanwhile.
			await sleep(delay)
		}
	}

	const refresh = (): Promise<TokenOutcome> => {
		inflight ??= attempt().finally(() => {
			inflight = undefined
		})
		return inflight
	}

	return {
		/** The token to send now, refreshed first when it is about to expire. */
		token: async (): Promise<TokenOutcome> => {
			const held = deps.read()
			if (held === null) {
				return { ok: false, reason: "credential_unavailable" }
			}
			if (held.type === "static_bearer") {
				return { ok: true, token: held.token }
			}
			// An API key is for the API it was stored for, never for an MCP server.
			if (held.type === "api_key") {
				return { ok: false, reason: "credential_unavailable" }
			}
			if (held.refresh_failed) {
				return { ok: false, reason: "reauthorization_required" }
			}
			const remaining = held.expires_at === null ? Infinity : held.expires_at - deps.now()
			if (held.refresh === null || remaining > REFRESH_SKEW_MS) {
				return { ok: true, token: held.access_token }
			}
			const outcome = await refresh()
			if (outcome.ok || outcome.reason !== "refresh_unavailable") {
				return outcome
			}
			// An authorization server that is down does not take a token that still works with it:
			// whatever is held now, as long as it is still held, current and unexpired.
			const now = deps.read()
			if (now === null) {
				return { ok: false, reason: "credential_unavailable" }
			}
			if (now.type !== "mcp_oauth") {
				return { ok: true, token: now.token }
			}
			if (now.refresh_failed) {
				return { ok: false, reason: "reauthorization_required" }
			}
			const left = now.expires_at === null ? Infinity : now.expires_at - deps.now()
			return left > 0 ? { ok: true, token: now.access_token } : outcome
		},
		/** After the server refused `rejected`: whether there is now another token to try. */
		recover: async (rejected: string): Promise<RecoverOutcome> => {
			const held = deps.read()
			if (held === null || held.type !== "mcp_oauth" || held.refresh === null) {
				return "none"
			}
			if (held.refresh_failed) {
				return "reauthorization_required"
			}
			if (held.access_token !== rejected) {
				return "retry"
			}
			const outcome = await refresh()
			return outcome.ok ? "retry" : outcome.reason
		},
		/** Every secret string held, for keeping them out of what is returned. */
		secrets: (): ReadonlyArray<string> => {
			const held = deps.read()
			if (held === null) {
				return []
			}
			if (held.type !== "mcp_oauth") {
				return [held.token]
			}
			return [
				held.access_token,
				...(held.refresh === null ? [] : [held.refresh.refresh_token]),
				...(held.refresh === null || held.refresh.auth.type === "none"
					? []
					: [held.refresh.auth.client_secret]),
			]
		},
	}
}

export type OAuthRefresher = ReturnType<typeof makeOAuthRefresher>
