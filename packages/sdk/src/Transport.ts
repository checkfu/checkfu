import * as Config from "effect/Config"
import * as Context from "effect/Context"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import type * as Cause from "effect/Cause"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { CheckfuConfigError, isAPIError, isApiErrorEnvelope } from "./Errors.ts"
import type { CheckfuSdkError } from "./Errors.ts"
import { SINGLE_PATH_SEGMENT_MESSAGE, isSinglePathSegment } from "./Schemas.ts"

export const DEFAULT_API_URL = "http://localhost:1337"
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_TIMEOUT_MS = 60_000
const INITIAL_RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 8000
const MAX_RETRY_AFTER_MS = 60_000

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export type HeaderMap = Readonly<Record<string, string | null | undefined>>

export interface PerRequestTransportMeta {
	readonly scope?: Scope.Scope
	readonly headers?: HeaderMap | undefined
	readonly onResponse?: ((response: HttpClientResponse.HttpClientResponse) => void) | undefined
}

export const CurrentRequestTransportMeta = Context.Reference<PerRequestTransportMeta | undefined>(
	"@checkfu/sdk/CurrentRequestTransportMeta",
	{ defaultValue: () => undefined },
)

export const isRedirectStatus = (status: number): boolean =>
	status === 301 || status === 302 || status === 303 || status === 307 || status === 308

export const cancelResponseBody = (
	response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void> => {
	const webResponse = HttpClientResponse.toWeb(response)
	if (Option.isSome(webResponse) && webResponse.value.body !== null) {
		const body = webResponse.value.body
		return Effect.sync(() => {
			void body.cancel().catch(() => undefined)
		})
	}
	return Effect.void
}

const uncoupledBody = (body: ReadableStream<Uint8Array>) => {
	const reader = body.getReader()
	let active = true
	const release = () => {
		active = false
		reader.releaseLock()
	}
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const next = await reader.read()
					if (!active) {
						return
					}
					if (next.done) {
						release()
						controller.close()
					} else {
						controller.enqueue(next.value)
					}
				} catch (error) {
					if (active) {
						release()
						controller.error(error)
					}
				}
			},
			cancel(reason: unknown) {
				if (active) {
					void reader.cancel(reason).catch(() => undefined)
					release()
				}
			},
		},
		{ highWaterMark: 0 },
	)
}

const uncoupledStream = <A, E>(source: Stream.Stream<A, E>): Stream.Stream<A, E> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const chunks = yield* Queue.bounded<A, E | Cause.Done>(1)
			const produce = Effect.scoped(
				Effect.gen(function* () {
					const pull = yield* Stream.toPull(source)
					yield* pull.pipe(
						Effect.flatMap((items) => Queue.offerAll(chunks, items)),
						Effect.forever,
						Effect.catchCause((cause) => Queue.failCause(chunks, cause)),
					)
				}),
			)
			// The terminal pull reaches the consumer before the provider's scope
			// closes. Opaque provider finalizers cannot hold the SDK request scope.
			yield* Effect.acquireRelease(Effect.forkDetach(produce), (producer) =>
				Queue.shutdown(chunks).pipe(
					Effect.andThen(Effect.forkDetach(Fiber.interrupt(producer))),
					Effect.asVoid,
				),
			)
			return Stream.fromQueue(chunks)
		}),
	)

export const streamResponseBody = (
	response: HttpClientResponse.HttpClientResponse,
): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> => {
	const webResponse = HttpClientResponse.toWeb(response)
	const body = Option.isSome(webResponse) ? webResponse.value.body : null
	if (body === null) {
		return uncoupledStream(response.stream)
	}
	return Stream.fromReadableStream({
		evaluate: () => uncoupledBody(body),
		onError: (cause) =>
			new HttpClientError.HttpClientError({
				reason: new HttpClientError.DecodeError({ request: response.request, response, cause }),
			}),
	})
}

export const readBoundedResponseText = (
	response: HttpClientResponse.HttpClientResponse,
	maxBytes: number,
	timeoutMs: number,
): Effect.Effect<string> =>
	Effect.gen(function* () {
		const chunks: Array<Uint8Array> = []
		let totalBytes = 0
		let truncated = false
		const readBody = streamResponseBody(response).pipe(
			Stream.takeUntil((chunk) => {
				if (totalBytes + chunk.byteLength > maxBytes) {
					const remaining = maxBytes - totalBytes
					if (remaining > 0) {
						chunks.push(chunk.subarray(0, remaining))
						totalBytes += remaining
					}
					truncated = true
					return true
				}
				chunks.push(chunk)
				totalBytes += chunk.byteLength
				return false
			}),
			Stream.runDrain,
			Effect.ignore,
			Effect.catchDefect(() => Effect.void),
		)
		const outcome = yield* Effect.timeoutOption(readBody, Duration.millis(timeoutMs))
		const timedOut = Option.isNone(outcome)
		if (totalBytes === 0) {
			return ""
		}
		const merged = new Uint8Array(totalBytes)
		let offset = 0
		for (const chunk of chunks) {
			merged.set(chunk, offset)
			offset += chunk.byteLength
		}
		const decoded = new TextDecoder().decode(merged)
		return truncated || timedOut ? `${decoded}…` : decoded
	})

export interface NormalizeApiUrlOptions {
	readonly allowInsecureHttp?: boolean | undefined
	readonly stripApiVersionSuffix?: boolean | undefined
}

export const parseNormalizedApiUrl = (
	raw: string,
	options?: NormalizeApiUrlOptions,
):
	| { readonly ok: true; readonly url: string }
	| { readonly ok: false; readonly message: string } => {
	const trimmed = raw.trim()
	if (trimmed.length === 0) {
		return { ok: false, message: "API base URL must not be empty." }
	}
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		return {
			ok: false,
			message: "Invalid API base URL. Expected an http(s) URL without credentials.",
		}
	}
	if (parsed.username.length > 0 || parsed.password.length > 0) {
		return { ok: false, message: "API base URL must not contain credentials." }
	}
	if (parsed.search.length > 0 || parsed.hash.length > 0) {
		return { ok: false, message: "API base URL must not contain query parameters or fragments." }
	}
	const protocol = parsed.protocol.toLowerCase()
	const hostname = parsed.hostname.toLowerCase()
	if (protocol === "http:") {
		if (options?.allowInsecureHttp !== true && !LOOPBACK_HOSTS.has(hostname)) {
			return {
				ok: false,
				message: `Refusing to send API credentials over insecure HTTP to non-loopback host "${parsed.hostname}". Use https:// instead.`,
			}
		}
	} else if (protocol !== "https:") {
		return { ok: false, message: `Unsupported API base URL scheme "${parsed.protocol}".` }
	}

	let pathname = parsed.pathname.replace(/\/+$/, "")
	if (options?.stripApiVersionSuffix !== false) {
		if (pathname === "/v1") {
			pathname = ""
		} else if (pathname.endsWith("/v1")) {
			pathname = pathname.slice(0, -3)
		}
	}
	return { ok: true, url: `${parsed.origin}${pathname}` }
}

export const normalizeApiUrl = (
	raw: string,
	options?: NormalizeApiUrlOptions,
): Effect.Effect<string, CheckfuConfigError> => {
	const result = parseNormalizedApiUrl(raw, options)
	return result.ok
		? Effect.succeed(result.url)
		: Effect.fail(new CheckfuConfigError({ message: result.message }))
}

const optionalConfigString = (
	name: string,
): Effect.Effect<Option.Option<string>, CheckfuConfigError> =>
	Config.option(Config.String(name)).pipe(
		Effect.mapBoth({
			onSuccess: Option.filter((value) => value.trim().length > 0),
			onFailure: (err) =>
				new CheckfuConfigError({ message: `Failed to read ${name}: ${err.message}` }),
		}),
	)

export const resolveBaseUrl = (
	override: string | undefined,
	options?: NormalizeApiUrlOptions,
): Effect.Effect<string, CheckfuConfigError> =>
	Effect.gen(function* () {
		if (override !== undefined) {
			return yield* normalizeApiUrl(override, options)
		}
		const baseUrl = yield* optionalConfigString("CHECKFU_BASE_URL")
		return Option.isSome(baseUrl) ? yield* normalizeApiUrl(baseUrl.value, options) : DEFAULT_API_URL
	})

export const normalizeApiKey = (
	raw: string | Redacted.Redacted<string>,
): Effect.Effect<Redacted.Redacted<string>, CheckfuConfigError> => {
	const value = (typeof raw === "string" ? raw : Redacted.value(raw)).trim()
	if (value.length === 0) {
		return Effect.fail(
			new CheckfuConfigError({
				message:
					"Missing CHECKFU_API_KEY. Pass apiKey or export CHECKFU_API_KEY before calling the Checkfu API.",
			}),
		)
	}
	return Effect.succeed(Redacted.make(value))
}

export const resolveApiKey = (
	override: string | Redacted.Redacted<string> | undefined,
): Effect.Effect<Redacted.Redacted<string>, CheckfuConfigError> => {
	if (override !== undefined) {
		return normalizeApiKey(override)
	}
	return Config.option(Config.Redacted("CHECKFU_API_KEY")).pipe(
		Effect.mapError(
			(err) =>
				new CheckfuConfigError({ message: `Failed to read CHECKFU_API_KEY: ${err.message}` }),
		),
		Effect.flatMap((maybeKey) => {
			if (Option.isNone(maybeKey) || Redacted.value(maybeKey.value).trim().length === 0) {
				return Effect.fail(
					new CheckfuConfigError({
						message:
							"Missing CHECKFU_API_KEY environment variable. Export CHECKFU_API_KEY before calling the Checkfu API.",
					}),
				)
			}
			return Effect.succeed(Redacted.make(Redacted.value(maybeKey.value).trim()))
		}),
	)
}

export const lookupHeader = (
	headers: HeaderMap | undefined,
	lowerName: string,
): string | null | undefined => {
	if (headers === undefined) {
		return undefined
	}
	let found: string | null | undefined
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName && value !== undefined) {
			found = value
		}
	}
	return found
}

interface KeyOptions {
	readonly headers?: HeaderMap | undefined
	readonly idempotencyKey?: string | undefined
}

export const snapshotHeaders = (headers: HeaderMap | undefined): HeaderMap | undefined =>
	headers === undefined ? undefined : { ...headers }

const hasRequestKey = (options: KeyOptions | undefined): boolean => {
	const header = lookupHeader(options?.headers, "idempotency-key")
	return options?.idempotencyKey !== undefined || (header !== undefined && header !== null)
}

export const forbidIdempotencyKey = (
	operation: string,
	options: KeyOptions | undefined,
	inlineOptions?: KeyOptions,
): Effect.Effect<void, CheckfuConfigError> =>
	hasRequestKey(options) || hasRequestKey(inlineOptions)
		? Effect.fail(
				new CheckfuConfigError({
					message: `${operation} takes no idempotency key; retrying it with one would not prevent a duplicate.`,
				}),
			)
		: Effect.void

export const mergeHeaderMaps = (
	base: HeaderMap | undefined,
	override: HeaderMap | undefined,
): HeaderMap | undefined => {
	if (base === undefined) {
		return override
	}
	if (override === undefined) {
		return base
	}
	const entries = new Map<string, readonly [string, string | null]>()
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) {
			entries.set(key.toLowerCase(), [key, value])
		}
	}
	for (const [key, value] of Object.entries(override)) {
		if (value !== undefined) {
			entries.set(key.toLowerCase(), [key, value])
		}
	}
	return Object.fromEntries(entries.values())
}

export const resolveDefaultHeaders = (
	headers: HeaderMap | undefined,
): Result.Result<HeaderMap | undefined, CheckfuConfigError> => {
	const defaults = headers === undefined ? undefined : { ...headers }
	const key = lookupHeader(defaults, "idempotency-key")
	if (key !== undefined && key !== null) {
		return Result.fail(
			new CheckfuConfigError({
				message:
					"An idempotency key identifies one request. Pass idempotencyKey with each request.",
			}),
		)
	}
	return Result.succeed(defaults)
}

export const applyHeaders = (
	request: HttpClientRequest.HttpClientRequest,
	headers: HeaderMap | undefined,
): HttpClientRequest.HttpClientRequest => {
	if (headers === undefined) {
		return request
	}
	let next = request
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) {
			continue
		}
		if (value === null) {
			next = HttpClientRequest.removeHeader(next, key)
		} else {
			next = HttpClientRequest.setHeader(next, key, value)
		}
	}
	return next
}

export interface MakeAuthorizedHttpClientOptions {
	readonly defaultHeaders?: HeaderMap | undefined
	readonly existingRequestInit?: globalThis.RequestInit | undefined
	readonly redirectErrorMessage?: ((status: number) => string) | undefined
}

export const makeAuthorizedHttpClient = (
	rawHttpClient: HttpClient.HttpClient,
	apiKey: Redacted.Redacted<string>,
	options?: MakeAuthorizedHttpClientOptions,
): HttpClient.HttpClient => {
	const bearerValue = Redacted.value(apiKey)
	const defaultHeaders = options?.defaultHeaders
	const existingRequestInit = options?.existingRequestInit
	const formatRedirect =
		options?.redirectErrorMessage ??
		((status: number) =>
			`Unexpected HTTP ${status} redirect (redirects are not followed). Check baseUrl.`)

	const scopedClient = HttpClient.withScope(rawHttpClient)
	return rawHttpClient.pipe(
		HttpClient.transform((effect, request) =>
			Effect.gen(function* () {
				const meta = yield* CurrentRequestTransportMeta
				const execute =
					meta?.scope === undefined
						? effect
						: Effect.provideService(
								scopedClient.postprocess(Effect.succeed(request)),
								Scope.Scope,
								meta.scope,
							)
				const response = yield* Effect.provideService(execute, FetchHttpClient.RequestInit, {
					...existingRequestInit,
					redirect: "manual",
				})
				meta?.onResponse?.(response)
				if (isRedirectStatus(response.status)) {
					yield* cancelResponseBody(response)
					return yield* new HttpClientError.HttpClientError({
						reason: new HttpClientError.StatusCodeError({
							request: response.request,
							response,
							description: formatRedirect(response.status),
						}),
					})
				}
				return response
			}),
		),
		HttpClient.mapRequestEffect((request) =>
			Effect.map(CurrentRequestTransportMeta, (meta) => {
				let next = HttpClientRequest.bearerToken(request, bearerValue)
				next = applyHeaders(next, defaultHeaders)
				next = applyHeaders(next, meta?.headers)
				return next
			}),
		),
	)
}

export const generateIdempotencyKey = (
	random: SecureRandom.SecureRandom["Service"],
	prefix = "sdk",
): Effect.Effect<string> =>
	Effect.map(random.randomBytes(12), (bytes) => `${prefix}_${Hex.encode(bytes)}`)

export const parseRetryAfterMs = (
	headers: Readonly<Record<string, string>> | undefined,
	nowMillis: number,
): number | undefined => {
	if (headers === undefined) {
		return undefined
	}
	const retryAfterMsRaw = headers["retry-after-ms"]
	if (retryAfterMsRaw !== undefined) {
		const parsedMs = Number(retryAfterMsRaw.trim())
		if (Number.isFinite(parsedMs) && parsedMs >= 0) {
			return Math.min(parsedMs, MAX_RETRY_AFTER_MS)
		}
	}
	const retryAfterRaw = headers["retry-after"]
	if (retryAfterRaw === undefined) {
		return undefined
	}
	const trimmed = retryAfterRaw.trim()
	if (trimmed.length === 0) {
		return undefined
	}
	const seconds = Number(trimmed)
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
	}
	const targetMillis = Date.parse(trimmed)
	if (Number.isFinite(targetMillis)) {
		return Math.min(Math.max(0, targetMillis - nowMillis), MAX_RETRY_AFTER_MS)
	}
	return undefined
}

export type RetrySafety = "idempotent" | "pre-commit-only"

export const shouldRetryError = (error: CheckfuSdkError, safety: RetrySafety): boolean => {
	if (
		error._tag === "APIUserAbortError" ||
		error._tag === "PaginationCursorCycleError" ||
		error._tag === "CheckfuConfigError" ||
		error._tag === "BadRequestError" ||
		error._tag === "AuthenticationError" ||
		error._tag === "PermissionDeniedError" ||
		error._tag === "NotFoundError" ||
		error._tag === "ConflictError" ||
		error._tag === "PayloadTooLargeError" ||
		error._tag === "UnsupportedMediaTypeError" ||
		error._tag === "UnprocessableEntityError"
	) {
		return false
	}
	if (isAPIError(error)) {
		const hasPartialOrUnconfirmed =
			(error.accepted !== undefined && error.accepted.length > 0) ||
			error.unconfirmedIndex !== undefined
		if (safety !== "idempotent" && hasPartialOrUnconfirmed) {
			return false
		}
		const shouldRetryHeader = error.headers?.["x-should-retry"]?.trim().toLowerCase()
		if (shouldRetryHeader === "false") {
			return false
		}
		if (safety !== "idempotent") {
			return error.status === 429 && isApiErrorEnvelope(error.body)
		}
		if (shouldRetryHeader === "true") {
			return true
		}
		return error.status === 408 || error.status === 429 || error.status >= 500
	}
	if (error._tag === "APIConnectionTimeoutError") {
		return safety === "idempotent"
	}
	if (error._tag === "APIConnectionError") {
		return safety === "idempotent" && error.retryable
	}
	return false
}

export const computeRetryDelayMs = (
	attempt: number,
	retryAfterMs: number | undefined,
	jitterUnit: number,
): number => {
	if (retryAfterMs !== undefined) {
		return Math.max(0, retryAfterMs)
	}
	const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** Math.min(attempt, 10), MAX_RETRY_DELAY_MS)
	const clampedUnit = Number.isFinite(jitterUnit) ? Math.min(1, Math.max(0, jitterUnit)) : 0.5
	const jitterFactor = 0.75 + clampedUnit * 0.25
	return Math.round(base * jitterFactor)
}

export const validatePathSegment = (value: string, label: string): string | undefined =>
	isSinglePathSegment(value) ? undefined : `Invalid ${label}: ${SINGLE_PATH_SEGMENT_MESSAGE}.`
