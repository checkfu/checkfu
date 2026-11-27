import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { CursorFromString, SessionStreamEvent, statusOfErrorType } from "./Api.ts"
import type { ApiError, CheckfuHttpApiClient, SessionEvent, SessionPreviewType } from "./Api.ts"
import {
	APIConnectionError,
	BadRequestError,
	decodeApiErrorEnvelope,
	fromApiErrorEnvelope,
	isApiErrorEnvelope,
	isTransientHttpStatus,
	makeApiStatusError,
	mapRawClientError,
} from "./Errors.ts"
import type { CheckfuSdkError } from "./Errors.ts"
import { SessionId } from "./Schemas.ts"
import {
	CurrentRequestTransportMeta,
	cancelResponseBody,
	lookupHeader,
	mergeHeaderMaps,
	parseRetryAfterMs,
	readBoundedResponseText,
} from "./Transport.ts"
import type { HeaderMap } from "./Transport.ts"

const DEFAULT_MAX_SSE_RECONNECTS = 5
const DEFAULT_SSE_RECONNECT_DELAY_MS = 250
const DEFAULT_SSE_ERROR_BODY_TIMEOUT_MS = 2000
const DEFAULT_SSE_HEALTHY_IDLE_DURATION_MS = 5000
const MAX_SSE_ERROR_BODY_BYTES = 16 * 1024
const MAX_SSE_NO_PROGRESS_DELAY_MS = 5000
const MAX_SSE_ID_LINE_LENGTH = 10 * 1024 * 1024

export type ApiSseError =
	| ApiError
	| HttpClientError.HttpClientError
	| Schema.SchemaError
	| Sse.SseError
	| Sse.Retry
	| CheckfuSdkError

export interface StreamSseOptions {
	readonly maxReconnectAttempts?: number | undefined
	readonly baseReconnectDelayMs?: number | undefined
	readonly errorBodyTimeoutMs?: number | undefined
	readonly healthyIdleDurationMs?: number | undefined
	readonly headers?: HeaderMap | undefined
	readonly onOpen?: ((status: 200 | 204) => Effect.Effect<void>) | undefined
}

export interface StreamSessionEventsOptions extends StreamSseOptions {
	readonly after?: number | undefined
	readonly event_deltas?: ReadonlyArray<SessionPreviewType> | undefined
}

export interface ApiSseStreamConfig<Event, E extends ApiSseError = ApiSseError> {
	readonly open: (context: {
		readonly reconnect: boolean
		readonly cursor: string | undefined
	}) => Effect.Effect<HttpClientResponse.HttpClientResponse, E>
	readonly decodeEvent: (rawData: string) => Effect.Effect<Event, CheckfuSdkError>
	readonly initialCursor?: string | undefined
	readonly getCursor?: ((event: Event) => string | undefined) | undefined
	readonly isCursorAdvance?: ((prev: string | undefined, next: string) => boolean) | undefined
	readonly isTerminal?: ((event: Event) => boolean) | undefined
	readonly defaultHeaders?: HeaderMap | undefined
	readonly options?: StreamSseOptions | undefined
}

class IncompleteSseFrameError extends Data.TaggedError("IncompleteSseFrameError")<
	Record<never, never>
> {}

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeCursorOption = Schema.decodeUnknownOption(CursorFromString)
const decodeSessionEventFromJsonString = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.toCodecJson(SessionStreamEvent)),
)

const mapSseError = (
	error: ApiSseError | IncompleteSseFrameError,
	headers?: Readonly<Record<string, string>>,
): CheckfuSdkError => {
	if (Predicate.isTagged(error, "IncompleteSseFrameError")) {
		return new APIConnectionError({
			message: "SSE stream closed with an incomplete SSE frame.",
		})
	}
	if (Schema.isSchemaError(error)) {
		return new APIConnectionError({
			message: `Invalid SSE event payload: ${error.message}`,
			cause: error,
			transient: false,
		})
	}
	return mapRawClientError(error, headers)
}

const isRetryableRawError = (error: ApiSseError | IncompleteSseFrameError): boolean => {
	if (Predicate.isTagged(error, "IncompleteSseFrameError")) {
		return true
	}
	if (Schema.isSchemaError(error) || Predicate.isTagged(error, "SseError")) {
		return false
	}
	if (isApiErrorEnvelope(error)) {
		return isTransientHttpStatus(statusOfErrorType(error.error.type))
	}
	if (HttpClientError.isHttpClientError(error)) {
		const reason = error.reason
		if (reason._tag === "TransportError") {
			return true
		}
		if (
			reason._tag === "StatusCodeError" ||
			reason._tag === "DecodeError" ||
			reason._tag === "EmptyBodyError"
		) {
			const status = reason.response.status
			return status === 200 || isTransientHttpStatus(status)
		}
		return false
	}
	return false
}

const noProgressBackoffMs = (baseDelayMs: number, streak: number): number =>
	Math.min(Math.max(baseDelayMs, 1) * 2 ** Math.min(streak, 16), MAX_SSE_NO_PROGRESS_DELAY_MS)

const retryDisconnectDelayMs = (
	baseDelayMs: number,
	retryDelayMs: number | undefined,
	attempt: number,
): number => {
	const base = retryDelayMs !== undefined && retryDelayMs > 0 ? retryDelayMs : baseDelayMs
	return base * 2 ** Math.min(attempt, 16)
}

type TrackerFrame = { readonly _tag: "Data" } | { readonly _tag: "IdOnly"; readonly id: string }

interface SseFrameHealthTracker {
	readonly feed: (chunk: string) => ReadonlyArray<TrackerFrame>
	readonly hasIncompleteFrame: () => boolean
	readonly sawCompletedKeepalive: () => boolean
}

const makeSseFrameHealthTracker = (): SseFrameHealthTracker => {
	let isFirstChunk = true
	let discardLf = false
	let inLine = false
	let lineIsComment = false
	let lineBuf = ""
	let hasPendingFrameField = false
	let frameHasData = false
	let frameIdUpdate: string | undefined
	let completedKeepalive = false

	const finishLine = (
		line: string,
		isComment: boolean,
		completedFrames: Array<TrackerFrame>,
	): void => {
		if (line.length === 0) {
			if (frameHasData) {
				completedFrames.push({ _tag: "Data" })
			} else if (frameIdUpdate !== undefined) {
				completedFrames.push({ _tag: "IdOnly", id: frameIdUpdate })
			}
			hasPendingFrameField = false
			frameHasData = false
			frameIdUpdate = undefined
			return
		}
		if (isComment) {
			completedKeepalive = true
			return
		}
		const colon = line.indexOf(":")
		const field = colon >= 0 ? line.slice(0, colon) : line
		if (field === "data") {
			frameHasData = true
			hasPendingFrameField = true
			return
		}
		if (field === "id") {
			const rawValue = colon >= 0 ? line.slice(colon + 1) : ""
			const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue
			if (!value.includes("\0")) {
				frameIdUpdate = value
			}
			hasPendingFrameField = true
			return
		}
		if (field !== "retry") {
			hasPendingFrameField = true
		}
	}

	const feed = (rawChunk: string): ReadonlyArray<TrackerFrame> => {
		const completedFrames: Array<TrackerFrame> = []
		if (rawChunk.length === 0) {
			return completedFrames
		}
		let chunk = rawChunk
		if (isFirstChunk && chunk.startsWith("\uFEFF")) {
			chunk = chunk.slice(1)
		}
		isFirstChunk = false
		for (let i = 0; i < chunk.length; i++) {
			const code = chunk.charCodeAt(i)
			if (discardLf) {
				discardLf = false
				if (code === 10) {
					continue
				}
			}
			if (code === 13 || code === 10) {
				discardLf = code === 13
				finishLine(lineBuf, lineIsComment, completedFrames)
				lineBuf = ""
				inLine = false
				lineIsComment = false
				continue
			}
			if (!inLine) {
				inLine = true
				lineIsComment = code === 58
			}
			if (
				lineBuf.length < 16 ||
				(lineBuf.startsWith("id:") && lineBuf.length < MAX_SSE_ID_LINE_LENGTH)
			) {
				lineBuf += chunk[i]
			}
		}
		return completedFrames
	}

	return {
		feed,
		hasIncompleteFrame: () => hasPendingFrameField || (inLine && !lineIsComment),
		sawCompletedKeepalive: () => completedKeepalive,
	}
}

const decodeBoundedHttpError = (
	response: HttpClientResponse.HttpClientResponse,
	errorBodyTimeoutMs: number,
): Effect.Effect<CheckfuSdkError> =>
	Effect.gen(function* () {
		const bodyText = yield* readBoundedResponseText(
			response,
			MAX_SSE_ERROR_BODY_BYTES,
			errorBodyTimeoutMs,
		)
		const parsed = Option.flatMap(decodeUnknownJson(bodyText), decodeApiErrorEnvelope)
		if (Option.isSome(parsed)) {
			return fromApiErrorEnvelope(parsed.value, {
				status: response.status,
				headers: response.headers,
			})
		}
		const detail = bodyText.trim()
		return makeApiStatusError(
			response.status,
			detail.length > 0 ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`,
			{
				headers: response.headers,
				requestId: response.headers["request-id"] ?? response.headers["x-request-id"],
				body: detail.length > 0 ? detail : undefined,
			},
		)
	})

export const streamApiSse = <Event, E extends ApiSseError = ApiSseError>(
	config: ApiSseStreamConfig<Event, E>,
): Stream.Stream<Event, CheckfuSdkError> => {
	const options = config.options
	const maxReconnects = Math.max(0, options?.maxReconnectAttempts ?? DEFAULT_MAX_SSE_RECONNECTS)
	const baseDelayMs = Math.max(0, options?.baseReconnectDelayMs ?? DEFAULT_SSE_RECONNECT_DELAY_MS)
	const errorBodyTimeoutMs = Math.max(
		1,
		options?.errorBodyTimeoutMs ?? DEFAULT_SSE_ERROR_BODY_TIMEOUT_MS,
	)
	const healthyIdleDurationMs = Math.max(
		0,
		options?.healthyIdleDurationMs ?? DEFAULT_SSE_HEALTHY_IDLE_DURATION_MS,
	)

	interface LoopState {
		cursor: string | undefined
		cursorReset: boolean
		hasAttempted: boolean
		attempt: number
		noProgressCloses: number
		retryDelayMs: number | undefined
		pendingDelayMs: number
		done: boolean
		notifiedOpen: boolean
	}

	type ParsedSseItem =
		| { readonly _tag: "Data"; readonly data: string; readonly id: string | undefined }
		| { readonly _tag: "IdOnly"; readonly id: string }

	const openConnection = (loopState: LoopState): Stream.Stream<Event, CheckfuSdkError> =>
		Stream.unwrap(
			Effect.gen(function* () {
				if (loopState.pendingDelayMs > 0) {
					yield* Effect.sleep(Duration.millis(loopState.pendingDelayMs))
					loopState.pendingDelayMs = 0
				}

				const openedAtNanos = yield* Clock.monotonicTimeNanos
				const reconnect = loopState.hasAttempted
				loopState.hasAttempted = true

				const extraHeaders = !reconnect
					? options?.headers
					: loopState.cursor !== undefined
						? mergeHeaderMaps(options?.headers, { "last-event-id": loopState.cursor })
						: loopState.cursorReset
							? mergeHeaderMaps(options?.headers, { "last-event-id": null })
							: options?.headers
				let lastResponse: HttpClientResponse.HttpClientResponse | undefined
				const outcome = yield* Effect.result(
					config.open({ reconnect, cursor: loopState.cursor }).pipe(
						Effect.provideService(CurrentRequestTransportMeta, {
							...(extraHeaders === undefined ? {} : { headers: extraHeaders }),
							onResponse: (response) => {
								lastResponse = response
							},
						}),
					),
				)

				if (outcome._tag === "Failure") {
					const rawErr = outcome.failure
					if (isRetryableRawError(rawErr) && loopState.attempt < maxReconnects) {
						const nowMillis = yield* Clock.currentTimeMillis
						const retryAfterMs = parseRetryAfterMs(lastResponse?.headers, nowMillis)
						const delayMs =
							retryAfterMs ??
							retryDisconnectDelayMs(baseDelayMs, loopState.retryDelayMs, loopState.attempt)
						loopState.attempt += 1
						loopState.pendingDelayMs = delayMs
						return Stream.empty
					}
					return yield* mapSseError(rawErr, lastResponse?.headers)
				}

				const response = outcome.success
				if (response.status === 204) {
					yield* cancelResponseBody(response)
					if (!loopState.notifiedOpen) {
						loopState.notifiedOpen = true
						if (options?.onOpen !== undefined) {
							yield* options.onOpen(204)
						}
					}
					loopState.done = true
					return Stream.empty
				}

				if (response.status !== 200) {
					if (isTransientHttpStatus(response.status) && loopState.attempt < maxReconnects) {
						yield* cancelResponseBody(response)
						const nowMillis = yield* Clock.currentTimeMillis
						const retryAfterMs = parseRetryAfterMs(response.headers, nowMillis)
						const delayMs =
							retryAfterMs ??
							retryDisconnectDelayMs(baseDelayMs, loopState.retryDelayMs, loopState.attempt)
						loopState.attempt += 1
						loopState.pendingDelayMs = delayMs
						return Stream.empty
					}
					return yield* yield* decodeBoundedHttpError(response, errorBodyTimeoutMs)
				}

				const contentType =
					(response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
				if (contentType !== "text/event-stream") {
					yield* cancelResponseBody(response)
					return yield* new APIConnectionError({
						message: `Expected text/event-stream response, got "${contentType || "missing"}".`,
						transient: false,
					})
				}

				if (!loopState.notifiedOpen) {
					loopState.notifiedOpen = true
					if (options?.onOpen !== undefined) {
						yield* options.onOpen(200)
					}
				}

				const cursorAtStart = loopState.cursor
				let sawDataEvent = false
				let sawTerminal = false
				let streamError: ApiSseError | IncompleteSseFrameError | undefined
				let hasStreamError = false
				const healthTracker = makeSseFrameHealthTracker()
				let chunkEvents: Array<{ readonly data: string; readonly id: string | undefined }> = []
				const parser = Sse.makeParser((parsed) => {
					if (parsed._tag === "Retry") {
						loopState.retryDelayMs = Math.max(0, Math.trunc(Duration.toMillis(parsed.duration)))
					} else {
						chunkEvents.push({ data: parsed.data, id: parsed.id })
					}
				})

				const applyGenericFrameId = (id: string): void => {
					if (id === "") {
						loopState.cursor = undefined
						loopState.cursorReset = true
						return
					}
					const advances = config.isCursorAdvance
						? config.isCursorAdvance(loopState.cursor, id)
						: id !== loopState.cursor
					if (advances) {
						loopState.cursor = id
						loopState.cursorReset = false
					}
				}

				const parsedItems: Stream.Stream<
					ParsedSseItem,
					HttpClientError.HttpClientError | Sse.SseError
				> = response.stream.pipe(
					Stream.decodeText(),
					Stream.flatMap((chunk) =>
						Stream.unwrap(
							Effect.sync(() => {
								chunkEvents = []
								const trackerFrames = healthTracker.feed(chunk)
								const parseError = parser.feed(chunk)
								const items: Array<ParsedSseItem> = []
								let dataIndex = 0
								for (const frame of trackerFrames) {
									if (frame._tag === "Data") {
										const parsed = chunkEvents[dataIndex]
										if (parsed === undefined) {
											break
										}
										dataIndex += 1
										items.push({ _tag: "Data", data: parsed.data, id: parsed.id })
									} else if (config.getCursor === undefined) {
										items.push(frame)
									}
								}
								while (dataIndex < chunkEvents.length) {
									const parsed = chunkEvents[dataIndex]
									dataIndex += 1
									if (parsed !== undefined) {
										items.push({ _tag: "Data", data: parsed.data, id: parsed.id })
									}
								}
								const emitted =
									items.length > 0
										? Stream.fromIterable(items).pipe(Stream.rechunk(1))
										: Stream.empty
								return parseError !== undefined
									? Stream.concat(emitted, Stream.fail(parseError))
									: emitted
							}),
						),
					),
				)

				const eventsStream: Stream.Stream<Event, CheckfuSdkError> = parsedItems.pipe(
					Stream.mapEffect((item): Effect.Effect<Option.Option<Event>, CheckfuSdkError> => {
						if (item._tag === "IdOnly") {
							return Effect.sync(() => {
								applyGenericFrameId(item.id)
								return Option.none()
							})
						}
						return config.decodeEvent(item.data).pipe(
							Effect.map((event) => {
								sawDataEvent = true
								if (config.getCursor !== undefined) {
									const nextCursor = config.getCursor(event)
									if (nextCursor !== undefined) {
										const advances = config.isCursorAdvance
											? config.isCursorAdvance(loopState.cursor, nextCursor)
											: nextCursor !== loopState.cursor
										if (advances) {
											loopState.cursor = nextCursor
											loopState.cursorReset = false
										}
									}
								} else if (item.id !== undefined) {
									applyGenericFrameId(item.id)
								}
								if (config.isTerminal?.(event) === true) {
									sawTerminal = true
								}
								return Option.some(event)
							}),
						)
					}),
					Stream.flatMap((maybeEvent) =>
						Option.isSome(maybeEvent) ? Stream.succeed(maybeEvent.value) : Stream.empty,
					),
					Stream.takeUntil((event) => config.isTerminal?.(event) === true),
					Stream.catch((error) => {
						streamError = error
						hasStreamError = true
						return Stream.empty
					}),
				)

				const finalizeConnection: Stream.Stream<Event, CheckfuSdkError> = Stream.unwrap(
					Effect.gen(function* () {
						if (sawTerminal) {
							loopState.done = true
							return Stream.empty
						}
						const advancedCursor =
							loopState.cursor !== undefined &&
							loopState.cursor !== cursorAtStart &&
							(config.isCursorAdvance
								? config.isCursorAdvance(cursorAtStart, loopState.cursor)
								: true)
						const elapsedMs = Number((yield* Clock.monotonicTimeNanos) - openedAtNanos) / 1_000_000
						const healthyIdle =
							!sawDataEvent &&
							!advancedCursor &&
							healthTracker.sawCompletedKeepalive() &&
							elapsedMs >= healthyIdleDurationMs

						if (!hasStreamError && healthTracker.hasIncompleteFrame()) {
							streamError = new IncompleteSseFrameError()
							hasStreamError = true
						}

						if (hasStreamError && streamError !== undefined) {
							if (isRetryableRawError(streamError)) {
								if (advancedCursor || healthyIdle) {
									loopState.attempt = 0
									loopState.noProgressCloses = 0
								}
								if (loopState.attempt >= maxReconnects) {
									return yield* mapSseError(streamError, response.headers)
								}
								const delayMs = retryDisconnectDelayMs(
									baseDelayMs,
									loopState.retryDelayMs,
									loopState.attempt,
								)
								loopState.attempt += 1
								loopState.pendingDelayMs = delayMs
								return Stream.empty
							}
							return yield* mapSseError(streamError, response.headers)
						}

						loopState.attempt = 0
						if (advancedCursor) {
							loopState.noProgressCloses = 0
							loopState.pendingDelayMs = loopState.retryDelayMs ?? 0
						} else if (healthyIdle) {
							loopState.noProgressCloses = 0
							const minIdleDelayMs = Math.min(Math.max(baseDelayMs, 1), 50)
							loopState.pendingDelayMs = Math.max(loopState.retryDelayMs ?? 0, minIdleDelayMs)
						} else {
							const streak = loopState.noProgressCloses
							loopState.noProgressCloses = streak + 1
							loopState.pendingDelayMs = Math.max(
								loopState.retryDelayMs ?? 0,
								noProgressBackoffMs(baseDelayMs, streak),
							)
						}
						return Stream.empty
					}),
				)

				return Stream.concat(eventsStream, finalizeConnection)
			}),
		)

	return Stream.suspend(() => {
		const initialHeaderCursor =
			config.initialCursor === undefined && config.getCursor === undefined
				? lookupHeader(mergeHeaderMaps(config.defaultHeaders, options?.headers), "last-event-id")
				: undefined
		const initialCursor =
			config.initialCursor ??
			(typeof initialHeaderCursor === "string" && initialHeaderCursor.length > 0
				? initialHeaderCursor
				: undefined)
		const loopState: LoopState = {
			cursor: initialCursor,
			cursorReset: false,
			hasAttempted: false,
			attempt: 0,
			noProgressCloses: 0,
			retryDelayMs: undefined,
			pendingDelayMs: 0,
			done: false,
			notifiedOpen: false,
		}
		return Stream.unfold(loopState, (state) =>
			state.done ? Effect.undefined : Effect.succeed([openConnection(state), state] as const),
		).pipe(Stream.flatten)
	})
}

export function streamSessionEvents(
	api: CheckfuHttpApiClient,
	sessionId: string,
	options?: StreamSessionEventsOptions & { readonly event_deltas?: undefined },
	defaultHeaders?: HeaderMap,
): Stream.Stream<SessionEvent, CheckfuSdkError>
export function streamSessionEvents(
	api: CheckfuHttpApiClient,
	sessionId: string,
	options?: StreamSessionEventsOptions,
	defaultHeaders?: HeaderMap,
): Stream.Stream<SessionStreamEvent, CheckfuSdkError>
export function streamSessionEvents(
	api: CheckfuHttpApiClient,
	sessionId: string,
	options?: StreamSessionEventsOptions,
	defaultHeaders?: HeaderMap,
): Stream.Stream<SessionStreamEvent, CheckfuSdkError> {
	return Stream.unwrap(
		Effect.gen(function* () {
			const parsedSessionId = yield* Schema.decodeEffect(SessionId)(sessionId).pipe(
				Effect.mapError(
					(err) =>
						new BadRequestError({
							status: 400,
							errorType: "invalid_request_error",
							message: `Invalid session_id: ${err.message}`,
						}),
				),
			)
			if (options?.after !== undefined && (!Number.isInteger(options.after) || options.after < 0)) {
				return yield* new BadRequestError({
					status: 400,
					errorType: "invalid_request_error",
					message: "after must be a non-negative integer.",
				})
			}
			const effectiveInitialHeaders = mergeHeaderMaps(defaultHeaders, options?.headers)
			const rawHeaderLastEventId = lookupHeader(effectiveInitialHeaders, "last-event-id")
			const headerLastEventId =
				typeof rawHeaderLastEventId === "string" && rawHeaderLastEventId.length > 0
					? rawHeaderLastEventId
					: undefined
			let effectiveCursor: number | undefined
			if (headerLastEventId !== undefined) {
				const parsedHeader = decodeCursorOption(headerLastEventId)
				effectiveCursor = Option.isSome(parsedHeader) ? parsedHeader.value : undefined
			} else {
				effectiveCursor = options?.after
			}
			const sendQueryAfterOnInitialOpen = headerLastEventId === undefined
			let lastEmittedSeq: number | undefined = effectiveCursor
			return streamApiSse<SessionStreamEvent>({
				open: ({ cursor, reconnect }) =>
					api.sessions.streamEvents({
						params: { session_id: parsedSessionId },
						query: {
							...(sendQueryAfterOnInitialOpen && !reconnect && cursor !== undefined
								? { after: cursor }
								: {}),
							...(options?.event_deltas === undefined
								? {}
								: { "event_deltas[]": options.event_deltas }),
						},
						responseMode: "response-only",
					}),
				decodeEvent: (rawData) =>
					decodeSessionEventFromJsonString(rawData).pipe(
						Effect.mapError(
							(err) =>
								new APIConnectionError({
									message: `Invalid SSE event payload: ${err.message}`,
									cause: err,
									transient: false,
								}),
						),
					),
				...(effectiveCursor !== undefined ? { initialCursor: String(effectiveCursor) } : {}),
				getCursor: (event) => ("seq" in event ? String(event.seq) : undefined),
				isCursorAdvance: (prev, next) => prev === undefined || Number(next) > Number(prev),
				isTerminal: (event) => event.type === "session.archived",
				defaultHeaders,
				options,
			}).pipe(
				Stream.filter((event) => {
					if (!("seq" in event)) {
						return (options?.event_deltas?.length ?? 0) > 0
					}
					if (lastEmittedSeq !== undefined && event.seq <= lastEmittedSeq) {
						return false
					}
					lastEmittedSeq = event.seq
					return true
				}),
			)
		}),
	)
}
