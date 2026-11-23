import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { statusOfErrorType } from "./Api.ts"
import type { ApiError, CheckfuHttpApiClient, SessionEvent } from "./Api.ts"
import {
	APIConnectionError,
	BadRequestError,
	isApiErrorEnvelope,
	isTransientHttpStatus,
	mapRawClientError,
} from "./Errors.ts"
import type { CheckfuSdkError } from "./Errors.ts"
import { SessionId } from "./Schemas.ts"
import {
	CurrentRequestTransportMeta,
	cancelResponseBody,
	mergeHeaderMaps,
	parseRetryAfterMs,
} from "./Transport.ts"
import type { HeaderMap } from "./Transport.ts"

const DEFAULT_MAX_SSE_RECONNECTS = 5
const DEFAULT_SSE_RECONNECT_DELAY_MS = 250
const DEFAULT_SSE_HEALTHY_IDLE_DURATION_MS = 5000
const MAX_SSE_NO_PROGRESS_DELAY_MS = 5000

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
	readonly healthyIdleDurationMs?: number | undefined
	readonly headers?: HeaderMap | undefined
	readonly onOpen?: ((status: 200 | 204) => Effect.Effect<void>) | undefined
}

export interface StreamSessionEventsOptions extends StreamSseOptions {
	readonly after?: number | undefined
}

export interface ApiSseStreamConfig<Event, E extends ApiSseError = ApiSseError> {
	readonly open: (context: {
		readonly reconnect: boolean
		readonly cursor: string | undefined
	}) => Effect.Effect<
		readonly [Stream.Stream<Event, E> | void, HttpClientResponse.HttpClientResponse],
		E
	>
	readonly initialCursor?: string | undefined
	readonly getCursor?: ((event: Event) => string | undefined) | undefined
	readonly isCursorAdvance?: ((prev: string | undefined, next: string) => boolean) | undefined
	readonly isTerminal?: ((event: Event) => boolean) | undefined
	readonly options?: StreamSseOptions | undefined
}

const mapSseError = (
	error: ApiSseError,
	headers?: Readonly<Record<string, string>>,
): CheckfuSdkError => {
	if (Schema.isSchemaError(error)) {
		return new APIConnectionError({
			message: `Invalid SSE event payload: ${error.message}`,
			cause: error,
		})
	}
	return mapRawClientError(error, headers)
}

const isRetryableRawError = (error: ApiSseError): boolean => {
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

export const streamApiSse = <Event, E extends ApiSseError = ApiSseError>(
	config: ApiSseStreamConfig<Event, E>,
): Stream.Stream<Event, CheckfuSdkError> => {
	const options = config.options
	const maxReconnects = Math.max(0, options?.maxReconnectAttempts ?? DEFAULT_MAX_SSE_RECONNECTS)
	const baseDelayMs = Math.max(0, options?.baseReconnectDelayMs ?? DEFAULT_SSE_RECONNECT_DELAY_MS)
	const healthyIdleDurationMs = Math.max(
		0,
		options?.healthyIdleDurationMs ?? DEFAULT_SSE_HEALTHY_IDLE_DURATION_MS,
	)

	interface LoopState {
		cursor: string | undefined
		hasAttempted: boolean
		attempt: number
		noProgressCloses: number
		pendingDelayMs: number
		done: boolean
		notifiedOpen: boolean
	}

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

				const extraHeaders =
					reconnect && loopState.cursor !== undefined
						? mergeHeaderMaps(options?.headers, { "last-event-id": loopState.cursor })
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
						const delayMs = retryAfterMs ?? baseDelayMs * 2 ** Math.min(loopState.attempt, 16)
						loopState.attempt += 1
						loopState.pendingDelayMs = delayMs
						return Stream.empty
					}
					return yield* mapSseError(rawErr, lastResponse?.headers)
				}

				const [innerStream, response] = outcome.success
				if (innerStream === undefined || response.status === 204) {
					if (!loopState.notifiedOpen) {
						loopState.notifiedOpen = true
						if (options?.onOpen !== undefined) {
							yield* options.onOpen(204)
						}
					}
					loopState.done = true
					return Stream.empty
				}

				const contentType =
					(response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
				if (contentType !== "text/event-stream") {
					yield* cancelResponseBody(response)
					return yield* new APIConnectionError({
						message: `Expected text/event-stream response, got "${contentType || "missing"}".`,
					})
				}

				if (!loopState.notifiedOpen) {
					loopState.notifiedOpen = true
					if (options?.onOpen !== undefined) {
						yield* options.onOpen(200)
					}
				}

				let advancedCursor = false
				let sawTerminal = false
				let streamError: E | undefined
				let hasStreamError = false

				const eventsStream: Stream.Stream<Event, CheckfuSdkError> = innerStream.pipe(
					Stream.tap((event) =>
						Effect.sync(() => {
							const nextCursor = config.getCursor?.(event)
							if (nextCursor !== undefined) {
								const advances = config.isCursorAdvance
									? config.isCursorAdvance(loopState.cursor, nextCursor)
									: nextCursor !== loopState.cursor
								if (advances) {
									loopState.cursor = nextCursor
									advancedCursor = true
								}
							}
							if (config.isTerminal?.(event) === true) {
								sawTerminal = true
							}
						}),
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
						const elapsedMs = Number((yield* Clock.monotonicTimeNanos) - openedAtNanos) / 1_000_000
						const healthyIdle = !advancedCursor && elapsedMs >= healthyIdleDurationMs

						if (hasStreamError && streamError !== undefined) {
							if (Sse.Retry.is(streamError)) {
								const requestedMs = Math.max(0, Math.trunc(Duration.toMillis(streamError.duration)))
								if (advancedCursor || healthyIdle) {
									loopState.attempt = 0
									loopState.noProgressCloses = 0
									loopState.pendingDelayMs = requestedMs
								} else {
									const streak = loopState.noProgressCloses
									loopState.noProgressCloses = streak + 1
									loopState.pendingDelayMs = Math.max(
										requestedMs,
										noProgressBackoffMs(baseDelayMs, streak),
									)
								}
								return Stream.empty
							}
							if (isRetryableRawError(streamError)) {
								if (advancedCursor || healthyIdle) {
									loopState.attempt = 0
									loopState.noProgressCloses = 0
								}
								if (loopState.attempt >= maxReconnects) {
									return yield* mapSseError(streamError, response.headers)
								}
								const delayMs = baseDelayMs * 2 ** Math.min(loopState.attempt, 16)
								loopState.attempt += 1
								loopState.pendingDelayMs = delayMs
								return Stream.empty
							}
							return yield* mapSseError(streamError, response.headers)
						}

						// Clean close without terminal event (e.g. server connection rotation).
						loopState.attempt = 0
						if (advancedCursor) {
							loopState.noProgressCloses = 0
							loopState.pendingDelayMs = 0
						} else if (healthyIdle) {
							loopState.noProgressCloses = 0
							loopState.pendingDelayMs = Math.min(Math.max(baseDelayMs, 1), 50)
						} else {
							const streak = loopState.noProgressCloses
							loopState.noProgressCloses = streak + 1
							loopState.pendingDelayMs = noProgressBackoffMs(baseDelayMs, streak)
						}
						return Stream.empty
					}),
				)

				return Stream.concat(eventsStream, finalizeConnection)
			}),
		)

	return Stream.suspend(() => {
		const loopState: LoopState = {
			cursor: config.initialCursor,
			hasAttempted: false,
			attempt: 0,
			noProgressCloses: 0,
			pendingDelayMs: 0,
			done: false,
			notifiedOpen: false,
		}
		return Stream.unfold(loopState, (state) =>
			state.done ? Effect.undefined : Effect.succeed([openConnection(state), state] as const),
		).pipe(Stream.flatten)
	})
}

export const streamSessionEvents = (
	api: CheckfuHttpApiClient,
	sessionId: string,
	options?: StreamSessionEventsOptions,
): Stream.Stream<SessionEvent, CheckfuSdkError> =>
	Stream.unwrap(
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
			let lastEmittedSeq: number | undefined = options?.after
			return streamApiSse<SessionEvent>({
				open: ({ cursor, reconnect }) =>
					api.sessions.streamEvents({
						params: { session_id: parsedSessionId },
						query: !reconnect && cursor !== undefined ? { after: cursor } : {},
						responseMode: "decoded-and-response",
					}),
				...(options?.after !== undefined ? { initialCursor: String(options.after) } : {}),
				getCursor: (event) => String(event.seq),
				isCursorAdvance: (prev, next) => prev === undefined || Number(next) > Number(prev),
				isTerminal: (event) => event.type === "session.archived",
				options,
			}).pipe(
				Stream.filter((event) => {
					if (lastEmittedSeq !== undefined && event.seq <= lastEmittedSeq) {
						return false
					}
					lastEmittedSeq = event.seq
					return true
				}),
			)
		}),
	)
