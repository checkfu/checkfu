import { SessionEvent, makeCheckfuClientWith } from "@checkfu/api/Http/Api"
import type { CheckfuClient as ApiCheckfuClient } from "@checkfu/api/Http/Api"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
	configError,
	formatApiErrorEnvelope,
	formatClientError,
	isApiErrorEnvelope,
	isTransientHttpError,
	isTransientHttpStatus,
	networkFailure,
	usageError,
} from "./Errors.ts"
import type { CliFailure } from "./Errors.ts"
import type { SavedConnection } from "./SavedConnection.ts"
import { COMMAND } from "./Standalone.ts"

export const DEFAULT_API_URL = "http://localhost:1337"
const DEFAULT_MAX_SSE_RECONNECTS = 5
const DEFAULT_SSE_RECONNECT_DELAY_MS = 250
const DEFAULT_SSE_ERROR_BODY_TIMEOUT_MS = 2000
const DEFAULT_SSE_HEALTHY_IDLE_DURATION_MS = 5000
const MAX_SSE_ERROR_BODY_BYTES = 16 * 1024
const MAX_SSE_NO_PROGRESS_DELAY_MS = 5000

const isRedirectStatus = (status: number): boolean =>
	status === 301 || status === 302 || status === 303 || status === 307 || status === 308

const cancelResponseBody = (
	response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void> => {
	const webResponse = HttpClientResponse.toWeb(response)
	if (Option.isSome(webResponse) && webResponse.value.body !== null) {
		const body = webResponse.value.body
		return Effect.tryPromise({
			try: () => body.cancel(),
			catch: () => undefined,
		}).pipe(Effect.ignore)
	}
	return Effect.void
}

const readBoundedResponseText = (
	response: HttpClientResponse.HttpClientResponse,
	maxBytes: number,
	timeoutMs: number,
): Effect.Effect<string> =>
	Effect.gen(function* () {
		const chunks: Array<Uint8Array> = []
		let totalBytes = 0
		let truncated = false
		const readBody = response.stream.pipe(
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
		const outcome = yield* Effect.race(
			readBody.pipe(Effect.as("done" as const)),
			Effect.sleep(Duration.millis(timeoutMs)).pipe(Effect.as("timeout" as const)),
		)
		const timedOut = outcome === "timeout"
		if (truncated || timedOut) {
			yield* cancelResponseBody(response)
		}
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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

const parseApiBase = (raw: string): Effect.Effect<URL, CliFailure> =>
	Effect.gen(function* () {
		const trimmed = raw.trim()
		if (trimmed.length === 0) {
			return yield* configError("API base URL must not be empty.")
		}
		const parsed = yield* Effect.try({
			try: () => new URL(trimmed),
			catch: () =>
				configError("Invalid API base URL. Expected an http(s) URL without credentials."),
		})
		if (parsed.username.length > 0 || parsed.password.length > 0) {
			return yield* configError("API base URL must not contain credentials.")
		}
		if (parsed.search.length > 0 || parsed.hash.length > 0) {
			return yield* configError("API base URL must not contain query parameters or fragments.")
		}
		const protocol = parsed.protocol.toLowerCase()
		const hostname = parsed.hostname.toLowerCase()
		if (protocol === "http:") {
			if (!LOOPBACK_HOSTS.has(hostname)) {
				return yield* configError(
					`Refusing to send API credentials over insecure HTTP to non-loopback host "${parsed.hostname}". Use https:// instead.`,
				)
			}
		} else if (protocol !== "https:") {
			return yield* configError(`Unsupported API base URL scheme "${parsed.protocol}".`)
		}
		return parsed
	})

/** Turns a URL someone typed into the base the API lives under, dropping one trailing `/v1`. */
export const normalizeApiUrl = (raw: string): Effect.Effect<string, CliFailure> =>
	Effect.map(parseApiBase(raw), (parsed) => {
		let pathname = parsed.pathname.replace(/\/+$/, "")
		if (pathname === "/v1") {
			pathname = ""
		} else if (pathname.endsWith("/v1")) {
			pathname = pathname.slice(0, -3)
		}
		return `${parsed.origin}${pathname}`
	})

/**
 * A saved URL is the exact base a key was verified against, so it is used as stored.
 * Normalizing it a second time could strip another path segment and send the key
 * somewhere that was never verified.
 */
const savedApiUrl = (saved: SavedConnection): Effect.Effect<string, CliFailure> =>
	Effect.flatMap(parseApiBase(saved.url), (parsed) =>
		`${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}` === saved.url
			? Effect.succeed(saved.url)
			: Effect.fail(
					configError(
						`The saved deployment URL is not in the form it is saved in. Run \`${COMMAND} login\` again.`,
					),
				),
	)

const optionalConfigString = (name: string): Effect.Effect<Option.Option<string>, CliFailure> =>
	Config.option(Config.String(name)).pipe(
		Effect.mapBoth({
			onSuccess: Option.filter((value) => value.trim().length > 0),
			onFailure: (err) => configError(`Failed to read ${name}: ${err.message}`),
		}),
	)

export const explicitBaseUrl = (
	baseUrlFlag: Option.Option<string>,
): Effect.Effect<Option.Option<string>, CliFailure> =>
	Effect.gen(function* () {
		if (Option.isSome(baseUrlFlag)) {
			return baseUrlFlag
		}
		const apiUrl = yield* optionalConfigString("CHECKFU_API_URL")
		return Option.isSome(apiUrl) ? apiUrl : yield* optionalConfigString("CHECKFU_URL")
	})

type LoadSaved<R> = Effect.Effect<Option.Option<SavedConnection>, CliFailure, R>

export const resolveBaseUrl = <R = never>(
	baseUrlFlag: Option.Option<string>,
	loadSaved: LoadSaved<R> = Effect.succeedNone,
): Effect.Effect<string, CliFailure, R> =>
	Effect.gen(function* () {
		const explicit = yield* explicitBaseUrl(baseUrlFlag)
		if (Option.isSome(explicit)) {
			return yield* normalizeApiUrl(explicit.value)
		}
		const saved = yield* loadSaved
		return Option.isSome(saved) ? yield* savedApiUrl(saved.value) : DEFAULT_API_URL
	})

const MISSING_API_KEY = `Missing CHECKFU_API_KEY. Run \`${COMMAND} deploy\` or \`${COMMAND} login\` to save one, or export CHECKFU_API_KEY.`

export const resolveApiKey = <R = never>(
	baseUrl: string,
	loadSaved: LoadSaved<R> = Effect.succeedNone,
): Effect.Effect<Redacted.Redacted<string>, CliFailure, R> =>
	Effect.gen(function* () {
		const fromEnv = yield* Config.option(Config.Redacted("CHECKFU_API_KEY")).pipe(
			Effect.mapBoth({
				onFailure: (err) => configError(`Failed to read CHECKFU_API_KEY: ${err.message}`),
				onSuccess: Option.flatMap((key) =>
					Option.liftPredicate(Redacted.value(key).trim(), (trimmed) => trimmed.length > 0),
				),
			}),
		)
		if (Option.isSome(fromEnv)) {
			return Redacted.make(fromEnv.value)
		}
		const saved = yield* loadSaved
		if (Option.isNone(saved)) {
			return yield* configError(MISSING_API_KEY)
		}
		const savedUrl = yield* savedApiUrl(saved.value)
		if (savedUrl !== baseUrl) {
			return yield* configError(
				`The saved API key belongs to ${savedUrl} and is not sent to ${baseUrl}. Export CHECKFU_API_KEY for this URL, or run \`${COMMAND} login\`.`,
			)
		}
		return Redacted.make(saved.value.api_key)
	})

const VERIFY_TIMEOUT = Duration.seconds(20)
const decodeJsonOption = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))

const probeProtectedRoute = (baseUrl: string, apiKey: Option.Option<string>) =>
	Effect.gen(function* () {
		const http = yield* HttpClient.HttpClient
		const request = HttpClientRequest.get(`${baseUrl}/v1/agents/agent_unknown`)
		const response = yield* http.execute(
			Option.match(apiKey, {
				onNone: () => request,
				onSome: (key) => HttpClientRequest.bearerToken(request, key),
			}),
		)
		const text = yield* readBoundedResponseText(
			response,
			MAX_SSE_ERROR_BODY_BYTES,
			DEFAULT_SSE_ERROR_BODY_TIMEOUT_MS,
		)
		const body = Option.getOrNull(decodeJsonOption(text))
		return { status: response.status, error: isApiErrorEnvelope(body) ? body.error : undefined }
	}).pipe(
		Effect.scoped,
		Effect.mapError((error) => networkFailure(`${baseUrl} is not reachable: ${error.message}`)),
		Effect.timeoutOrElse({
			duration: VERIFY_TIMEOUT,
			orElse: () => Effect.fail(networkFailure(`${baseUrl} did not answer in time.`)),
		}),
	)

/** An API key that can travel in an `Authorization` header unchanged. */
export const isSendableApiKey = (apiKey: string): boolean => /^[!-~]+$/.test(apiKey)

export const verifyApiKey = (
	baseUrl: string,
	apiKey: string,
): Effect.Effect<void, CliFailure, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const notCheckfu = (status: number) =>
			networkFailure(
				`${baseUrl} did not answer like a Checkfu API (HTTP ${status}). Check the URL, including its path.`,
			)
		// The key is only sent to a route that has just refused a request for lacking one.
		const anonymous = yield* probeProtectedRoute(baseUrl, Option.none())
		if (anonymous.status !== 401 || anonymous.error?.type !== "authentication_error") {
			return yield* notCheckfu(anonymous.status)
		}
		const authed = yield* probeProtectedRoute(baseUrl, Option.some(apiKey))
		if (authed.error === undefined) {
			return yield* notCheckfu(authed.status)
		}
		if (authed.status !== 404 || authed.error.type !== "not_found_error") {
			return yield* networkFailure(
				`${baseUrl} rejected the API key (HTTP ${authed.status}): ${authed.error.message}`,
			)
		}
	})

export interface SessionStreamEvent {
	readonly id: string | undefined
	readonly event: string
	readonly seq: number | undefined
	readonly data: Schema.JsonObject
}

export interface StreamSseOptions {
	readonly maxReconnectAttempts?: number | undefined
	readonly baseReconnectDelayMs?: number | undefined
	readonly errorBodyTimeoutMs?: number | undefined
	readonly healthyIdleDurationMs?: number | undefined
}

export interface StreamSessionEventsOptions extends StreamSseOptions {
	readonly after?: number | undefined
}

export interface EndpointSseRequest {
	readonly method: string
	readonly path: string
	readonly query?: Readonly<Record<string, string>> | undefined
	readonly headers?: Readonly<Record<string, string>> | undefined
	readonly initialCursor?: string | undefined
	readonly cursorQueryParam?: string | undefined
	readonly monotonicNumericCursor?: boolean | undefined
	readonly validateEventData?:
		| ((data: Schema.JsonObject) => Effect.Effect<void, CliFailure>)
		| undefined
	readonly isTerminalEvent?: ((data: Schema.JsonObject) => boolean) | undefined
}

const decodeSessionEvent = Schema.decodeUnknownEffect(Schema.toCodecJson(SessionEvent))

export const validateSessionEventData = (
	data: Schema.JsonObject,
): Effect.Effect<void, CliFailure> =>
	decodeSessionEvent(data).pipe(
		Effect.asVoid,
		Effect.mapError((err) => networkFailure(`Invalid SSE session event payload: ${err.message}`)),
	)

export interface CheckfuClient {
	readonly baseUrl: string
	readonly api: ApiCheckfuClient
	readonly streamEndpointEvents: (
		request: EndpointSseRequest,
		options?: StreamSseOptions,
	) => Stream.Stream<SessionStreamEvent, CliFailure>
	readonly streamSessionEvents: (
		sessionId: string,
		options?: StreamSessionEventsOptions,
	) => Stream.Stream<SessionStreamEvent, CliFailure>
	readonly generateIdempotencyKey: Effect.Effect<string>
}

const parseNonNegativeIntString = (value: string | undefined): number | undefined =>
	value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined

const parseSeq = (id: string | undefined, data: Schema.JsonObject): number | undefined => {
	if (typeof data["seq"] === "number" && Number.isInteger(data["seq"]) && data["seq"] >= 0) {
		return data["seq"]
	}
	return parseNonNegativeIntString(id)
}

class StreamBodyReadError extends Data.TaggedError("StreamBodyReadError")<{
	readonly error: HttpClientError.HttpClientError
}> {}

const decodeSseJsonObject = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))

const parseSseData = (raw: string): Effect.Effect<Schema.JsonObject, CliFailure> =>
	decodeSseJsonObject(raw).pipe(
		Effect.mapError((err) => networkFailure(`Invalid SSE event JSON payload: ${err.message}`)),
	)

export const makeCheckfuClient = <R = never>(
	baseUrlFlag: Option.Option<string>,
	loadSaved: LoadSaved<R> = Effect.succeedNone,
): Effect.Effect<
	CheckfuClient,
	CliFailure,
	HttpClient.HttpClient | SecureRandom.SecureRandom | R
> =>
	Effect.gen(function* () {
		const loadSavedOnce = yield* Effect.cached(loadSaved)
		const baseUrl = yield* resolveBaseUrl(baseUrlFlag, loadSavedOnce)
		const apiKey = yield* resolveApiKey(baseUrl, loadSavedOnce)
		const rawHttpClient = yield* HttpClient.HttpClient
		const existingRequestInit = Context.getOrUndefined(
			yield* Effect.context(),
			FetchHttpClient.RequestInit,
		)
		const random = yield* SecureRandom.SecureRandom
		const bearerValue = Redacted.value(apiKey)

		const authedHttpClient = rawHttpClient.pipe(
			HttpClient.transformResponse((effect) =>
				Effect.provideService(effect, FetchHttpClient.RequestInit, {
					...existingRequestInit,
					redirect: "manual",
				}).pipe(
					Effect.filterOrElse(
						(response) => !isRedirectStatus(response.status),
						(response) =>
							cancelResponseBody(response).pipe(
								Effect.andThen(
									Effect.fail(
										new HttpClientError.HttpClientError({
											reason: new HttpClientError.StatusCodeError({
												request: response.request,
												response,
												description: `Unexpected HTTP ${response.status} redirect (redirects are not followed). Check --base-url.`,
											}),
										}),
									),
								),
							),
					),
				),
			),
			HttpClient.mapRequest(HttpClientRequest.bearerToken(bearerValue)),
		)

		const api = yield* makeCheckfuClientWith({
			baseUrl,
			httpClient: authedHttpClient,
		})

		const generateIdempotencyKey: Effect.Effect<string> = Effect.map(
			random.randomBytes(12),
			(bytes) => `cli_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`,
		)

		const streamEndpointEvents = (
			requestSpec: EndpointSseRequest,
			options?: StreamSseOptions,
		): Stream.Stream<SessionStreamEvent, CliFailure> => {
			if (requestSpec.method.toUpperCase() !== "GET") {
				return Stream.fail(
					usageError(`Unsupported SSE HTTP method "${requestSpec.method}". Expected GET.`),
				)
			}

			const maxReconnects = options?.maxReconnectAttempts ?? DEFAULT_MAX_SSE_RECONNECTS
			const baseDelayMs = options?.baseReconnectDelayMs ?? DEFAULT_SSE_RECONNECT_DELAY_MS
			const errorBodyTimeoutMs = options?.errorBodyTimeoutMs ?? DEFAULT_SSE_ERROR_BODY_TIMEOUT_MS
			const rawHealthyIdleMs =
				options?.healthyIdleDurationMs ?? DEFAULT_SSE_HEALTHY_IDLE_DURATION_MS
			const healthyIdleDurationMs = Number.isFinite(rawHealthyIdleMs)
				? Math.max(0, Math.trunc(rawHealthyIdleMs))
				: DEFAULT_SSE_HEALTHY_IDLE_DURATION_MS
			const healthyIdleDurationNanos = BigInt(healthyIdleDurationMs) * 1_000_000n

			interface LoopState {
				cursor: string | undefined
				useHeader: boolean
				attempt: number
				noProgressCloses: number
				retryDelayMs: number | undefined
				pendingDelayMs: number
				done: boolean
			}

			const openConnection = (
				loopState: LoopState,
			): Stream.Stream<SessionStreamEvent, CliFailure> =>
				Stream.unwrap(
					Effect.gen(function* () {
						if (loopState.pendingDelayMs > 0) {
							const delayMs = loopState.pendingDelayMs
							loopState.pendingDelayMs = 0
							yield* Effect.sleep(Duration.millis(delayMs))
						}

						const searchParams = new URLSearchParams()
						if (requestSpec.query !== undefined) {
							for (const [key, value] of Object.entries(requestSpec.query)) {
								if (
									loopState.useHeader &&
									requestSpec.cursorQueryParam !== undefined &&
									key === requestSpec.cursorQueryParam
								) {
									continue
								}
								searchParams.append(key, value)
							}
						}
						const queryString = searchParams.toString()
						const normalizedPath = requestSpec.path.startsWith("/")
							? requestSpec.path
							: `/${requestSpec.path}`
						const streamUrl =
							queryString.length > 0
								? `${baseUrl}${normalizedPath}?${queryString}`
								: `${baseUrl}${normalizedPath}`

						let req = HttpClientRequest.get(streamUrl)
						if (requestSpec.headers !== undefined) {
							for (const [key, value] of Object.entries(requestSpec.headers)) {
								req = HttpClientRequest.setHeader(req, key, value)
							}
						}
						req = HttpClientRequest.setHeader(req, "accept", "text/event-stream")
						if (loopState.useHeader && loopState.cursor !== undefined) {
							req = HttpClientRequest.setHeader(req, "last-event-id", loopState.cursor)
						}

						const responseResult = yield* Effect.result(authedHttpClient.execute(req))
						if (responseResult._tag === "Failure") {
							const err = responseResult.failure
							if (isTransientHttpError(err) && loopState.attempt < maxReconnects) {
								loopState.useHeader = true
								loopState.pendingDelayMs =
									(loopState.retryDelayMs ?? baseDelayMs) * 2 ** loopState.attempt
								loopState.attempt += 1
								return Stream.empty
							}
							loopState.done = true
							return Stream.fail(formatClientError(err))
						}

						const response = responseResult.success
						if (response.status === 204) {
							yield* cancelResponseBody(response)
							loopState.done = true
							return Stream.empty
						}
						if (response.status !== 200) {
							if (isTransientHttpStatus(response.status) && loopState.attempt < maxReconnects) {
								yield* cancelResponseBody(response)
								loopState.useHeader = true
								loopState.pendingDelayMs =
									(loopState.retryDelayMs ?? baseDelayMs) * 2 ** loopState.attempt
								loopState.attempt += 1
								return Stream.empty
							}
							const bodyText = yield* readBoundedResponseText(
								response,
								MAX_SSE_ERROR_BODY_BYTES,
								errorBodyTimeoutMs,
							)
							const parsedError = yield* Effect.try({
								try: () => JSON.parse(bodyText) as unknown,
								catch: () => undefined,
							}).pipe(Effect.orElseSucceed(() => undefined))

							loopState.done = true
							if (isApiErrorEnvelope(parsedError)) {
								return Stream.fail(formatApiErrorEnvelope(parsedError, response.status))
							}
							return Stream.fail(
								networkFailure(
									`Event stream request failed with HTTP ${response.status}${bodyText.trim().length > 0 ? `: ${bodyText.trim()}` : ""}`,
								),
							)
						}

						const contentType = response.headers["content-type"] ?? ""
						const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
						if (mediaType !== "text/event-stream") {
							yield* cancelResponseBody(response)
							loopState.done = true
							return Stream.fail(
								networkFailure(
									`Expected text/event-stream response from event stream, received ${
										contentType.trim().length > 0
											? `"${contentType.trim()}"`
											: "missing Content-Type"
									}.`,
								),
							)
						}

						const connectedAtNanos = yield* Clock.monotonicTimeNanos
						const initialCursor = loopState.cursor
						const hasCursorProgress = (): boolean => loopState.cursor !== initialCursor
						let sawEvent = false
						let sawKeepalive = false
						let terminalReached = false
						let handledError = false
						// Separate cursor progress ("where do we resume?") from connection health
						// ("was this connection healthy enough to reset retry/no-progress budgets?"):
						// a quiet connection must have delivered at least one completed keepalive
						// (not merely stalled without bytes) and stayed open >= healthyIdleDurationNanos
						// to count as healthy when its resume cursor has not changed.
						const assessConnectionHealth = (closedAtNanos: bigint) => {
							const advanced = hasCursorProgress()
							const healthyIdle =
								!sawEvent &&
								sawKeepalive &&
								closedAtNanos - connectedAtNanos >= healthyIdleDurationNanos
							return { advanced, healthyIdle, healthy: advanced || healthyIdle }
						}
						let isFirstChunk = true
						let discardLeadingLf = false
						let pendingLine = ""
						let hasPendingEventFields = false
						let hasPendingFrameId = false
						let pendingFrameId: string | undefined
						type ParsedFrameItem =
							| { readonly _tag: "Event"; readonly event: Sse.Event }
							| { readonly _tag: "CursorUpdate"; readonly id: string }
						const parsedItems: Array<ParsedFrameItem> = []

						const parser = Sse.makeParser((event) => {
							if (event._tag === "Retry") {
								loopState.retryDelayMs = Math.max(0, Duration.toMillis(event.duration))
							} else {
								parsedItems.push({ _tag: "Event", event })
							}
						})

						const feedChunkOrdered = (rawChunk: string): Sse.SseError | undefined => {
							if (rawChunk.length === 0) {
								return undefined
							}
							let chunk = rawChunk
							if (isFirstChunk && chunk.startsWith("\uFEFF")) {
								chunk = chunk.slice(1)
							}
							isFirstChunk = false
							const length = chunk.length
							let position = 0
							let sliceStart = 0
							while (position < length) {
								if (discardLeadingLf) {
									discardLeadingLf = false
									if (chunk.charCodeAt(position) === 10) {
										position += 1
										continue
									}
								}
								let lineEnd = position
								while (lineEnd < length) {
									const code = chunk.charCodeAt(lineEnd)
									if (code === 13 || code === 10) {
										break
									}
									lineEnd += 1
								}
								if (lineEnd === length) {
									pendingLine += chunk.slice(position)
									break
								}
								const endedWithCr = chunk.charCodeAt(lineEnd) === 13
								discardLeadingLf = endedWithCr
								const line =
									pendingLine.length > 0
										? pendingLine + chunk.slice(position, lineEnd)
										: chunk.slice(position, lineEnd)
								pendingLine = ""
								position = lineEnd + 1
								if (line.length === 0) {
									hasPendingEventFields = false
									// Include the following LF in the same slice if CRLF is contiguous in this chunk
									if (endedWithCr && position < length && chunk.charCodeAt(position) === 10) {
										discardLeadingLf = false
										position += 1
									}
									const itemsBefore = parsedItems.length
									const parseErr = parser.feed(chunk.slice(sliceStart, position))
									sliceStart = position
									if (parseErr !== undefined) {
										return parseErr
									}
									const emittedDataEvent = parsedItems.length > itemsBefore
									if (!emittedDataEvent && hasPendingFrameId && pendingFrameId !== undefined) {
										parsedItems.push({ _tag: "CursorUpdate", id: pendingFrameId })
									}
									hasPendingFrameId = false
									pendingFrameId = undefined
								} else if (line.startsWith(":")) {
									sawKeepalive = true
								} else {
									const colon = line.indexOf(":")
									const field = colon >= 0 ? line.slice(0, colon) : line
									const value =
										colon >= 0
											? line.slice(line.charCodeAt(colon + 1) === 32 ? colon + 2 : colon + 1)
											: ""
									if (field === "id" && !value.includes("\u0000")) {
										hasPendingFrameId = true
										pendingFrameId = value
									}
									if (field !== "retry") {
										hasPendingEventFields = true
									}
								}
							}
							if (sliceStart < length) {
								const parseErr = parser.feed(chunk.slice(sliceStart))
								if (parseErr !== undefined) {
									return parseErr
								}
							}
							return undefined
						}

						const eventsStream: Stream.Stream<SessionStreamEvent, CliFailure> =
							response.stream.pipe(
								Stream.mapError((error) => new StreamBodyReadError({ error })),
								Stream.decodeText(),
								Stream.flatMap((chunk) =>
									Stream.unwrap(
										Effect.sync(() => {
											const parseErr = feedChunkOrdered(chunk)
											const batch = parsedItems.splice(0, parsedItems.length)
											const batchStream =
												batch.length > 0 ? Stream.fromIterable(batch) : Stream.empty
											return parseErr !== undefined
												? Stream.concat(batchStream, Stream.fail(parseErr))
												: batchStream
										}),
									),
								),
								Stream.rechunk(1),
								Stream.mapEffect((item) =>
									Effect.gen(function* () {
										const updateCursor = (nextId: string | undefined, nextSeq?: number): void => {
											if (requestSpec.monotonicNumericCursor === true) {
												const candidateNum =
													nextSeq !== undefined ? nextSeq : parseNonNegativeIntString(nextId)
												if (candidateNum !== undefined) {
													const currentNum = parseNonNegativeIntString(loopState.cursor)
													if (currentNum === undefined || candidateNum > currentNum) {
														loopState.cursor = String(candidateNum)
													}
												}
												return
											}
											if (nextId === "") {
												loopState.cursor = undefined
											} else if (nextId !== undefined) {
												loopState.cursor = nextId
											} else if (nextSeq !== undefined) {
												loopState.cursor = String(nextSeq)
											}
										}
										if (item._tag === "CursorUpdate") {
											if (requestSpec.validateEventData === undefined) {
												updateCursor(item.id)
											}
											sawKeepalive = true
											return Option.none<SessionStreamEvent>()
										}
										const sseEvent = item.event
										const data = yield* parseSseData(sseEvent.data)
										if (requestSpec.validateEventData !== undefined) {
											yield* requestSpec.validateEventData(data)
										}
										const seq = parseSeq(sseEvent.id, data)
										updateCursor(sseEvent.id, seq)
										sawEvent = true
										if (requestSpec.isTerminalEvent?.(data) === true) {
											terminalReached = true
											loopState.done = true
										}
										return Option.some({
											id: sseEvent.id,
											event: sseEvent.event,
											seq,
											data,
										} satisfies SessionStreamEvent)
									}),
								),
								Stream.takeUntil(() => terminalReached),
								Stream.flatMap((maybeEvent) =>
									Option.isSome(maybeEvent) ? Stream.make(maybeEvent.value) : Stream.empty,
								),
								Stream.catch((error) => {
									if (error instanceof StreamBodyReadError) {
										return Stream.unwrap(
											Effect.gen(function* () {
												const health = assessConnectionHealth(yield* Clock.monotonicTimeNanos)
												const nextAttempt = (health.healthy ? 0 : loopState.attempt) + 1
												if (nextAttempt <= maxReconnects) {
													handledError = true
													loopState.useHeader = true
													loopState.attempt = nextAttempt
													if (health.healthy) {
														loopState.noProgressCloses = 0
													}
													loopState.pendingDelayMs =
														(loopState.retryDelayMs ?? baseDelayMs) * 2 ** (nextAttempt - 1)
													return Stream.empty
												}
												loopState.done = true
												return Stream.fail(formatClientError(error.error))
											}),
										)
									}
									loopState.done = true
									return Stream.fail(formatClientError(error))
								}),
							)

						const finalizeConnection = Stream.unwrap(
							Effect.gen(function* () {
								if (terminalReached || handledError || loopState.done) {
									if (terminalReached) {
										loopState.done = true
									}
									return Stream.empty
								}
								const hasIncompleteFrame = pendingLine.length > 0 || hasPendingEventFields
								const health = assessConnectionHealth(yield* Clock.monotonicTimeNanos)
								loopState.useHeader = true
								if (hasIncompleteFrame) {
									const nextAttempt = (health.healthy ? 0 : loopState.attempt) + 1
									if (nextAttempt > maxReconnects) {
										loopState.done = true
										return Stream.fail(
											networkFailure("Event stream closed with an incomplete SSE frame."),
										)
									}
									loopState.attempt = nextAttempt
									if (health.healthy) {
										loopState.noProgressCloses = 0
									}
									loopState.pendingDelayMs =
										(loopState.retryDelayMs ?? baseDelayMs) * 2 ** (nextAttempt - 1)
									return Stream.empty
								}
								if (health.advanced) {
									loopState.attempt = 0
									loopState.noProgressCloses = 0
									loopState.pendingDelayMs = loopState.retryDelayMs ?? 0
									return Stream.empty
								}
								// Clean close without advancing the cursor:
								// - Healthy long-lived idle connections reset the no-progress streak and
								//   reconnect promptly.
								// - Consecutive short heartbeat-only/empty closes or repeated non-advancing
								//   event closes apply capped exponential backoff even if the server sent
								//   `retry: 0`.
								loopState.attempt = 0
								const floorBaseMs = Math.max(baseDelayMs, 1)
								if (health.healthyIdle) {
									loopState.noProgressCloses = 0
									const minIdleDelayMs = Math.min(floorBaseMs, 50)
									loopState.pendingDelayMs = Math.max(loopState.retryDelayMs ?? 0, minIdleDelayMs)
								} else {
									const streak = loopState.noProgressCloses
									loopState.noProgressCloses = streak + 1
									const backoffDelayMs = Math.min(
										floorBaseMs * 2 ** Math.min(streak, 16),
										MAX_SSE_NO_PROGRESS_DELAY_MS,
									)
									loopState.pendingDelayMs = Math.max(loopState.retryDelayMs ?? 0, backoffDelayMs)
								}
								return Stream.empty
							}),
						)

						return Stream.concat(eventsStream, finalizeConnection)
					}),
				)

			return Stream.suspend(() => {
				const loopState: LoopState = {
					cursor: requestSpec.initialCursor,
					useHeader: false,
					attempt: 0,
					noProgressCloses: 0,
					retryDelayMs: undefined,
					pendingDelayMs: 0,
					done: false,
				}
				return Stream.unfold(loopState, (state) =>
					state.done ? Effect.undefined : Effect.succeed([openConnection(state), state] as const),
				).pipe(Stream.flatten)
			})
		}

		const streamSessionEvents = (
			sessionId: string,
			options?: StreamSessionEventsOptions,
		): Stream.Stream<SessionStreamEvent, CliFailure> => {
			if (
				sessionId.length === 0 ||
				sessionId === "." ||
				sessionId === ".." ||
				sessionId.includes("/") ||
				sessionId.includes("\\")
			) {
				return Stream.fail(
					usageError(
						'Invalid --session-id: must be a single non-empty path segment (not "." or "..").',
					),
				)
			}
			if (options?.after !== undefined && (!Number.isInteger(options.after) || options.after < 0)) {
				return Stream.fail(usageError("--after must be a non-negative integer."))
			}
			return streamEndpointEvents(
				{
					method: "GET",
					path: `/v1/sessions/${encodeURIComponent(sessionId)}/events/stream`,
					...(options?.after !== undefined
						? {
								query: { after: String(options.after) },
								initialCursor: String(options.after),
								cursorQueryParam: "after",
							}
						: {}),
					monotonicNumericCursor: true,
					validateEventData: validateSessionEventData,
					isTerminalEvent: (data) => data["type"] === "session.archived",
				},
				options,
			)
		}

		return {
			baseUrl,
			api,
			streamEndpointEvents,
			streamSessionEvents,
			generateIdempotencyKey,
		}
	})
