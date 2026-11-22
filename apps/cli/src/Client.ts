import {
	type CheckfuClient as ApiCheckfuClient,
	makeCheckfuClientWith,
} from "@checkfu/api/Http/Api"
import * as Config from "effect/Config"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import {
	type CliFailure,
	configError,
	formatApiErrorEnvelope,
	formatClientError,
	isApiErrorEnvelope,
	isTransientHttpError,
	networkFailure,
	usageError,
} from "./Errors.ts"

export const DEFAULT_API_URL = "http://localhost:1337"
const DEFAULT_MAX_SSE_RECONNECTS = 5
const DEFAULT_SSE_RECONNECT_DELAY_MS = 250

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export const normalizeApiUrl = (raw: string): Effect.Effect<string, CliFailure> =>
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

		let pathname = parsed.pathname.replace(/\/+$/, "")
		if (pathname === "/v1") {
			pathname = ""
		} else if (pathname.endsWith("/v1")) {
			pathname = pathname.slice(0, -3)
		}
		return `${parsed.origin}${pathname}`
	})

const optionalConfigString = (name: string): Effect.Effect<Option.Option<string>, CliFailure> =>
	Config.option(Config.String(name)).pipe(
		Effect.map(Option.filter((value) => value.trim().length > 0)),
		Effect.mapError((err) => configError(`Failed to read ${name}: ${err.message}`)),
	)

export const resolveBaseUrl = (
	baseUrlFlag: Option.Option<string>,
): Effect.Effect<string, CliFailure> =>
	Effect.gen(function* () {
		if (Option.isSome(baseUrlFlag)) {
			return yield* normalizeApiUrl(baseUrlFlag.value)
		}
		const apiUrl = yield* optionalConfigString("CHECKFU_API_URL")
		if (Option.isSome(apiUrl)) {
			return yield* normalizeApiUrl(apiUrl.value)
		}
		const url = yield* optionalConfigString("CHECKFU_URL")
		if (Option.isSome(url)) {
			return yield* normalizeApiUrl(url.value)
		}
		return DEFAULT_API_URL
	})

export const resolveApiKey = (): Effect.Effect<Redacted.Redacted<string>, CliFailure> =>
	Config.option(Config.Redacted("CHECKFU_API_KEY")).pipe(
		Effect.mapError((err) => configError(`Failed to read CHECKFU_API_KEY: ${err.message}`)),
		Effect.flatMap((maybeKey) => {
			if (Option.isNone(maybeKey) || Redacted.value(maybeKey.value).trim().length === 0) {
				return Effect.fail(
					configError(
						"Missing CHECKFU_API_KEY environment variable. Export CHECKFU_API_KEY before calling the Checkfu API.",
					),
				)
			}
			return Effect.succeed(Redacted.make(Redacted.value(maybeKey.value).trim()))
		}),
	)

export interface SessionStreamEvent {
	readonly id: string | undefined
	readonly event: string
	readonly seq: number | undefined
	readonly data: Record<string, unknown>
}

export interface StreamSessionEventsOptions {
	readonly after?: number | undefined
	readonly maxReconnectAttempts?: number | undefined
	readonly baseReconnectDelayMs?: number | undefined
}

export interface CheckfuClient {
	readonly baseUrl: string
	readonly api: ApiCheckfuClient
	readonly streamSessionEvents: (
		sessionId: string,
		options?: StreamSessionEventsOptions,
	) => Stream.Stream<SessionStreamEvent, CliFailure>
	readonly generateIdempotencyKey: () => Effect.Effect<string>
}

const parseSeq = (id: string | undefined, data: Record<string, unknown>): number | undefined => {
	if (typeof data["seq"] === "number" && Number.isInteger(data["seq"]) && data["seq"] >= 0) {
		return data["seq"]
	}
	if (id !== undefined && /^\d{1,15}$/.test(id)) {
		return Number(id)
	}
	return undefined
}

class StreamBodyReadError extends Data.TaggedError("StreamBodyReadError")<{
	readonly error: HttpClientError.HttpClientError
}> {}

const parseSseData = (raw: string): Effect.Effect<Record<string, unknown>, CliFailure> =>
	Effect.try({
		try: () => {
			const parsed: unknown = JSON.parse(raw)
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("Expected JSON object in SSE data payload.")
			}
			return parsed as Record<string, unknown>
		},
		catch: (err) =>
			networkFailure(
				`Invalid SSE event JSON payload: ${err instanceof Error ? err.message : String(err)}`,
			),
	})

export const makeCheckfuClient = (
	baseUrlFlag: Option.Option<string>,
): Effect.Effect<CheckfuClient, CliFailure, HttpClient.HttpClient | SecureRandom.SecureRandom> =>
	Effect.gen(function* () {
		const baseUrl = yield* resolveBaseUrl(baseUrlFlag)
		const apiKey = yield* resolveApiKey()
		const rawHttpClient = yield* HttpClient.HttpClient
		const random = yield* SecureRandom.SecureRandom
		const bearerValue = Redacted.value(apiKey)

		const authedHttpClient = rawHttpClient.pipe(
			HttpClient.mapRequest(HttpClientRequest.bearerToken(bearerValue)),
		)

		const api = yield* makeCheckfuClientWith({
			baseUrl,
			httpClient: authedHttpClient,
		})

		const generateIdempotencyKey = (): Effect.Effect<string> =>
			Effect.map(
				random.randomBytes(12),
				(bytes) => `cli_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`,
			)

		const streamSessionEvents = (
			sessionId: string,
			options?: StreamSessionEventsOptions,
		): Stream.Stream<SessionStreamEvent, CliFailure> => {
			if (options?.after !== undefined && (!Number.isInteger(options.after) || options.after < 0)) {
				return Stream.fail(usageError("--after must be a non-negative integer."))
			}

			const maxReconnects = options?.maxReconnectAttempts ?? DEFAULT_MAX_SSE_RECONNECTS
			const baseDelayMs = options?.baseReconnectDelayMs ?? DEFAULT_SSE_RECONNECT_DELAY_MS

			interface LoopState {
				cursor: number | undefined
				useHeader: boolean
				attempt: number
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

						const streamUrl =
							!loopState.useHeader && loopState.cursor !== undefined
								? `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events/stream?after=${loopState.cursor}`
								: `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events/stream`
						let req = HttpClientRequest.get(streamUrl).pipe(
							HttpClientRequest.setHeader("accept", "text/event-stream"),
						)
						if (loopState.useHeader && loopState.cursor !== undefined) {
							req = HttpClientRequest.setHeader(req, "last-event-id", String(loopState.cursor))
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
							loopState.done = true
							return Stream.empty
						}
						if (response.status !== 200) {
							const bodyText = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
							const parsedError = yield* Effect.try({
								try: () => JSON.parse(bodyText) as unknown,
								catch: () => undefined,
							}).pipe(Effect.catch(() => Effect.succeed(undefined)))

							if (
								(response.status === 429 || response.status >= 500) &&
								loopState.attempt < maxReconnects
							) {
								loopState.useHeader = true
								loopState.pendingDelayMs =
									(loopState.retryDelayMs ?? baseDelayMs) * 2 ** loopState.attempt
								loopState.attempt += 1
								return Stream.empty
							}
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
							const webResponse = HttpClientResponse.toWeb(response)
							if (Option.isSome(webResponse) && webResponse.value.body !== null) {
								const body = webResponse.value.body
								yield* Effect.ignore(Effect.promise(() => body.cancel()))
							}
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

						let sawEvent = false
						let sawKeepalive = false
						let archived = false
						let handledError = false
						let isFirstChunk = true
						let discardLeadingLf = false
						let pendingLine = ""
						let hasPendingEventFields = false
						const parsedEvents: Array<Sse.Event> = []

						const parser = Sse.makeParser((event) => {
							if (event._tag === "Retry") {
								loopState.retryDelayMs = Math.max(0, Duration.toMillis(event.duration))
							} else {
								parsedEvents.push(event)
							}
						})

						const trackSseTextChunk = (rawChunk: string): void => {
							if (rawChunk.length === 0) return
							let chunk = rawChunk
							if (isFirstChunk && chunk.startsWith("\uFEFF")) {
								chunk = chunk.slice(1)
							}
							isFirstChunk = false
							const length = chunk.length
							let position = 0
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
									if (code === 13 || code === 10) break
									lineEnd += 1
								}
								if (lineEnd === length) {
									pendingLine += chunk.slice(position)
									break
								}
								discardLeadingLf = chunk.charCodeAt(lineEnd) === 13
								const line =
									pendingLine.length > 0
										? pendingLine + chunk.slice(position, lineEnd)
										: chunk.slice(position, lineEnd)
								pendingLine = ""
								if (line.length === 0) {
									hasPendingEventFields = false
								} else if (line.startsWith(":")) {
									sawKeepalive = true
								} else {
									const colon = line.indexOf(":")
									const field = colon >= 0 ? line.slice(0, colon) : line
									if (field !== "retry") {
										hasPendingEventFields = true
									}
								}
								position = lineEnd + 1
							}
						}

						const eventsStream: Stream.Stream<SessionStreamEvent, CliFailure> =
							response.stream.pipe(
								Stream.mapError((error) => new StreamBodyReadError({ error })),
								Stream.decodeText(),
								Stream.flatMap((chunk) =>
									Stream.unwrap(
										Effect.sync(() => {
											trackSseTextChunk(chunk)
											const parseErr = parser.feed(chunk)
											const batch = parsedEvents.splice(0, parsedEvents.length)
											const batchStream =
												batch.length > 0 ? Stream.fromIterable(batch) : Stream.empty
											return parseErr !== undefined
												? Stream.concat(batchStream, Stream.fail(parseErr))
												: batchStream
										}),
									),
								),
								Stream.mapEffect((sseEvent) =>
									Effect.gen(function* () {
										const data = yield* parseSseData(sseEvent.data)
										const seq = parseSeq(sseEvent.id, data)
										if (seq !== undefined) {
											loopState.cursor = seq
										}
										sawEvent = true
										if (data["type"] === "session.archived") {
											archived = true
										}
										return {
											id: sseEvent.id,
											event: sseEvent.event,
											seq,
											data,
										} satisfies SessionStreamEvent
									}),
								),
								Stream.catch((err) => {
									if (err instanceof StreamBodyReadError) {
										const nextAttempt = sawEvent ? 0 : loopState.attempt + 1
										if (nextAttempt <= maxReconnects) {
											handledError = true
											loopState.useHeader = true
											loopState.attempt = nextAttempt
											loopState.pendingDelayMs =
												(loopState.retryDelayMs ?? baseDelayMs) * 2 ** Math.max(0, nextAttempt - 1)
											return Stream.empty
										}
										loopState.done = true
										return Stream.fail(formatClientError(err.error))
									}
									loopState.done = true
									return Stream.fail(formatClientError(err))
								}),
							)

						const finalizeConnection = Stream.unwrap(
							Effect.sync(() => {
								if (archived || handledError || loopState.done) {
									if (archived) {
										loopState.done = true
									}
									return Stream.empty
								}
								const hasIncompleteFrame = pendingLine.length > 0 || hasPendingEventFields
								loopState.useHeader = true
								if (hasIncompleteFrame) {
									const nextAttempt = sawEvent ? 0 : loopState.attempt + 1
									if (nextAttempt > maxReconnects) {
										loopState.done = true
										return Stream.fail(
											networkFailure("Event stream closed with an incomplete SSE frame."),
										)
									}
									loopState.attempt = nextAttempt
									loopState.pendingDelayMs =
										(loopState.retryDelayMs ?? baseDelayMs) * 2 ** Math.max(0, nextAttempt - 1)
									return Stream.empty
								}
								if (sawEvent) {
									loopState.attempt = 0
									loopState.pendingDelayMs = loopState.retryDelayMs ?? 0
									return Stream.empty
								}
								// Clean close without advancing the cursor (e.g., healthy keepalive rotation
								// or empty HTTP 200 close): keep listening without spending error retries,
								// applying a minimum delay (or the server's advertised retry: delay).
								loopState.attempt = 0
								loopState.pendingDelayMs =
									loopState.retryDelayMs ?? (sawKeepalive ? Math.min(baseDelayMs, 50) : baseDelayMs)
								return Stream.empty
							}),
						)

						return Stream.concat(eventsStream, finalizeConnection)
					}),
				)

			return Stream.suspend(() => {
				const loopState: LoopState = {
					cursor: options?.after,
					useHeader: false,
					attempt: 0,
					retryDelayMs: undefined,
					pendingDelayMs: 0,
					done: false,
				}
				return Stream.unfold(loopState, (state) =>
					state.done
						? Effect.succeed(undefined)
						: Effect.succeed([openConnection(state), state] as const),
				).pipe(Stream.flatten)
			})
		}

		return {
			baseUrl,
			api,
			streamSessionEvents,
			generateIdempotencyKey,
		}
	})
