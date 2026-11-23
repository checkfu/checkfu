import type * as Brand from "effect/Brand"
import * as Clock from "effect/Clock"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import type * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpApiClient from "effect/http-api/HttpApiClient"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { CheckfuApi, ClientEventId } from "./Api.ts"
import type { CheckfuHttpApiClient, PendingResource } from "./Api.ts"
import {
	APIConnectionTimeoutError,
	BadRequestError,
	CheckfuConfigError,
	PaginationCursorCycleError,
	isAPIError,
	mapRawClientError,
} from "./Errors.ts"
import type { CheckfuSdkError } from "./Errors.ts"
import { streamApiSse, streamSessionEvents } from "./Sse.ts"
import type { ApiSseError, StreamSseOptions } from "./Sse.ts"
import {
	CurrentRequestTransportMeta,
	computeRetryDelayMs,
	parseRetryAfterMs,
	shouldRetryError,
	validatePathSegment,
} from "./Transport.ts"
import type { HeaderMap, RetrySafety } from "./Transport.ts"

/**
 * Recursively transforms Effect `DateTime.Utc` values into ISO-8601 `string`s
 * and unbrands primitive branded types for plain TypeScript callers.
 */
export type IsoDateTimes<T> = T extends DateTime.Utc
	? string
	: T extends Brand.Brand<infer _K>
		? T extends string
			? string
			: T extends number
				? number
				: T
		: T extends string | number | boolean | null | undefined | symbol | bigint
			? T
			: T extends ReadonlyArray<infer U>
				? ReadonlyArray<IsoDateTimes<U>>
				: T extends object
					? { readonly [K in keyof T]: IsoDateTimes<T[K]> }
					: T

type RequiredKeysOf<T> = {
	[K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K
}[keyof T]

type OptionalKeysOf<T> = {
	[K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]

/**
 * Allows `undefined` explicitly on optional keys under `exactOptionalPropertyTypes`.
 */
export type RelaxOptionalProps<T> = [T] extends [never]
	? never
	: T extends object
		? { readonly [K in RequiredKeysOf<T>]: T[K] } & {
				readonly [K in OptionalKeysOf<T>]?: T[K] | undefined
			}
		: T

export type ApiGroupName = keyof (typeof CheckfuApi)["groups"]
export type ApiEndpointName<G extends ApiGroupName> =
	keyof (typeof CheckfuApi)["groups"][G]["endpoints"]
export type ApiEndpoint<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = (typeof CheckfuApi)["groups"][G]["endpoints"][E]

type EndpointProp<Ep, K extends string> = Ep extends { readonly [P in K]: infer V } ? V : never

type SchemaTypeOrNever<S> = S extends Schema.Top ? S["Type"] : never

type JsonPayloadOf<P> =
	P extends ReadonlyMap<string, { readonly schemas: ReadonlyArray<Schema.Top> }>
		? never
		: P extends Schema.Top
			? P["Type"]
			: never

type UnwrapStreamElement<T> =
	T extends Stream.Stream<infer Event, infer _E, infer _R> ? Event : never

export type EndpointDecodedParams<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = SchemaTypeOrNever<EndpointProp<ApiEndpoint<G, E>, "~Params">>

export type EndpointParams<G extends ApiGroupName, E extends ApiEndpointName<G>> = IsoDateTimes<
	EndpointDecodedParams<G, E>
>

export type EndpointQuery<G extends ApiGroupName, E extends ApiEndpointName<G>> = SchemaTypeOrNever<
	EndpointProp<ApiEndpoint<G, E>, "~Query">
>

export type EndpointBody<G extends ApiGroupName, E extends ApiEndpointName<G>> = JsonPayloadOf<
	EndpointProp<ApiEndpoint<G, E>, "~Payload">
>

export type EndpointSuccess<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = HttpApiClient.SuccessType<EndpointProp<ApiEndpoint<G, E>, "~Success">>

export type EndpointJsonSuccess<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = IsoDateTimes<EndpointSuccess<G, E>>

export type EndpointSseEvent<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = UnwrapStreamElement<EndpointSuccess<G, E>>

type CheckfuApiGroup = (typeof CheckfuApi.groups)[ApiGroupName]
type CheckfuEndpointValues<G> = G extends { readonly endpoints: infer E } ? E[keyof E] : never
type AnyCheckfuEndpoint = CheckfuEndpointValues<CheckfuApiGroup>

const lookupCheckfuEndpoint = (
	groupName: string,
	endpointName: string,
): AnyCheckfuEndpoint | undefined => {
	for (const [name, group] of Object.entries(CheckfuApi.groups)) {
		if (name !== groupName) {
			continue
		}
		const endpoints: Readonly<Record<string, AnyCheckfuEndpoint>> = group.endpoints
		return endpoints[endpointName]
	}
	return undefined
}

export interface OperationShape<
	Path = never,
	Query = never,
	Body = never,
	Result = unknown,
	JsonResult = IsoDateTimes<Result>,
> {
	readonly path: Path
	readonly query: Query
	readonly body: Body
	readonly result: Result
	readonly jsonResult: JsonResult
}

export type PathOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["path"]
export type QueryOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["query"]
export type BodyOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["body"]
export type ResultOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["result"]
export type JsonResultOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["jsonResult"]

export type ItemOf<R> = R extends { readonly data: ReadonlyArray<infer T> }
	? T
	: R extends { readonly items: ReadonlyArray<infer T> }
		? T
		: never

export interface CursorPageEnvelope<Item, Cursor extends string | number = number> {
	readonly data: ReadonlyArray<Item>
	readonly has_more: boolean
	readonly next_cursor: Cursor | null
}

export interface RequestOptions {
	readonly headers?: HeaderMap | undefined
	readonly timeout?: Duration.Input | null | undefined
	readonly maxRetries?: number | undefined
	readonly idempotencyKey?: string | undefined
	readonly withResponse?: false | undefined
}

export interface WithResponseRequestOptions {
	readonly headers?: HeaderMap | undefined
	readonly timeout?: Duration.Input | null | undefined
	readonly maxRetries?: number | undefined
	readonly idempotencyKey?: string | undefined
	readonly withResponse: true
}

export type AnyRequestOptions = RequestOptions | WithResponseRequestOptions

export interface WithResponse<A> {
	readonly data: A
	readonly response: HttpClientResponse.HttpClientResponse
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly requestId: string | undefined
}

export interface SessionEventsStreamOptions extends StreamSseOptions {
	readonly headers?: HeaderMap | undefined
}

export interface WaitForPendingOptions<T> {
	readonly timeout?: Duration.Input | undefined
	readonly initialDelay?: Duration.Input | undefined
	readonly maxDelay?: Duration.Input | undefined
	until?(this: void, resource: T): boolean
	readonly requestOptions?: RequestOptions | undefined
}

export interface EffectSdkRuntime {
	readonly baseUrl: string
	readonly raw: CheckfuHttpApiClient
	readonly maxRetries: number
	readonly timeout: Duration.Duration | null
	readonly autoIdempotencyKey: boolean
	readonly random: SecureRandom.SecureRandom["Service"]
	readonly generateIdempotencyKey: Effect.Effect<string>
}

const DEFAULT_PENDING_TIMEOUT_MS = 30_000
const DEFAULT_PENDING_INITIAL_DELAY_MS = 200
const DEFAULT_PENDING_MAX_DELAY_MS = 2000

export const normalizeMaxRetries = (
	value: number | undefined,
	fallback: number,
): Effect.Effect<number, CheckfuConfigError> => {
	const resolved = value ?? fallback
	if (!Number.isInteger(resolved) || resolved < 0) {
		return Effect.fail(
			new CheckfuConfigError({
				message: `Invalid maxRetries (${String(resolved)}). Expected a non-negative integer.`,
			}),
		)
	}
	return Effect.succeed(resolved)
}

export const resolveTimeout = (
	override: Duration.Input | null | undefined,
	defaultTimeout: Duration.Duration | null,
): Effect.Effect<Duration.Duration | null, CheckfuConfigError> => {
	if (override === undefined) {
		return Effect.succeed(defaultTimeout)
	}
	if (override === null) {
		return Effect.succeed(null)
	}
	const parsed = Duration.fromInput(override)
	if (Option.isNone(parsed)) {
		return Effect.fail(new CheckfuConfigError({ message: "Invalid timeout duration." }))
	}
	if (!Duration.isFinite(parsed.value)) {
		return Effect.succeed(null)
	}
	if (Duration.toMillis(parsed.value) <= 0) {
		return Effect.fail(
			new CheckfuConfigError({ message: "Timeout must be a positive duration or null." }),
		)
	}
	return Effect.succeed(parsed.value)
}

export const decodeEndpointParams = <G extends ApiGroupName, E extends ApiEndpointName<G>>(
	group: G,
	endpoint: E,
	rawParams: Readonly<Record<string, string>>,
): Effect.Effect<EndpointDecodedParams<G, E>, BadRequestError> => {
	for (const [label, rawValue] of Object.entries(rawParams)) {
		const pathErr = validatePathSegment(rawValue, label)
		if (pathErr !== undefined) {
			return Effect.fail(
				new BadRequestError({
					status: 400,
					errorType: "invalid_request_error",
					message: pathErr,
				}),
			)
		}
	}
	const endpointDef = lookupCheckfuEndpoint(String(group), String(endpoint))
	const paramsSchema = endpointDef?.params
	if (paramsSchema === undefined) {
		return Effect.fail(
			new BadRequestError({
				status: 400,
				errorType: "invalid_request_error",
				message: `Endpoint ${String(group)}.${String(endpoint)} does not accept path parameters.`,
			}),
		)
	}
	return Schema.decodeEffect(
		// Boundary decode: `endpointDef.params` is the runtime schema corresponding to `~Params`.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		paramsSchema as Schema.Codec<EndpointDecodedParams<G, E>, unknown, never, never>,
	)(rawParams).pipe(
		Effect.mapError(
			(err) =>
				new BadRequestError({
					status: 400,
					errorType: "invalid_request_error",
					message: `Invalid path parameters: ${err.message}`,
				}),
		),
	)
}

const decodeClientIdempotencyKey = (key: string): Effect.Effect<ClientEventId, BadRequestError> =>
	Schema.decodeEffect(ClientEventId)(key).pipe(
		Effect.mapError(
			(err) =>
				new BadRequestError({
					status: 400,
					errorType: "invalid_request_error",
					message: `Invalid idempotencyKey: ${err.message}`,
				}),
		),
	)

export const resolveCallIdempotencyKey = (
	runtime: EffectSdkRuntime,
	explicitKey: string | undefined,
	supportsIdempotency: boolean,
): Effect.Effect<ClientEventId | undefined, BadRequestError> => {
	if (explicitKey !== undefined) {
		return decodeClientIdempotencyKey(explicitKey)
	}
	if (!supportsIdempotency || !runtime.autoIdempotencyKey) {
		return Effect.undefined
	}
	return Effect.flatMap(runtime.generateIdempotencyKey, decodeClientIdempotencyKey)
}

export const executeWithRetries = <A, E>(
	runtime: EffectSdkRuntime,
	spanName: string,
	safety: RetrySafety,
	options: AnyRequestOptions | undefined,
	invoke: () => Effect.Effect<readonly [A, HttpClientResponse.HttpClientResponse], E>,
): Effect.Effect<WithResponse<A>, CheckfuSdkError> =>
	Effect.gen(function* () {
		const maxRetries = yield* normalizeMaxRetries(options?.maxRetries, runtime.maxRetries)
		const effectiveTimeout = yield* resolveTimeout(options?.timeout, runtime.timeout)

		const runAttempt = (): Effect.Effect<WithResponse<A>, CheckfuSdkError> =>
			Effect.suspend(() => {
				let lastResponse: HttpClientResponse.HttpClientResponse | undefined
				const meta = {
					headers: options?.headers,
					onResponse: (res: HttpClientResponse.HttpClientResponse) => {
						lastResponse = res
					},
				}
				const attempt = Effect.provideService(invoke(), CurrentRequestTransportMeta, meta).pipe(
					Effect.mapBoth({
						onSuccess: ([data, response]): WithResponse<A> => ({
							data,
							response,
							status: response.status,
							headers: response.headers,
							requestId: response.headers["request-id"],
						}),
						onFailure: (err): CheckfuSdkError => {
							if (Schema.isSchemaError(err) && lastResponse === undefined) {
								return new BadRequestError({
									status: 400,
									errorType: "invalid_request_error",
									message: `Invalid request parameters: ${err.message}`,
								})
							}
							return mapRawClientError(err, lastResponse?.headers)
						},
					}),
				)
				if (effectiveTimeout === null) {
					return attempt
				}
				return attempt.pipe(
					Effect.timeoutOption(effectiveTimeout),
					Effect.flatMap((maybeResult) =>
						Effect.fromOption(maybeResult).pipe(
							Effect.mapError(
								() =>
									new APIConnectionTimeoutError({
										message: `Request timed out after ${Duration.format(effectiveTimeout)}.`,
									}),
							),
						),
					),
				)
			})

		let attemptNumber = 0
		for (;;) {
			const outcome = yield* Effect.result(runAttempt())
			if (outcome._tag === "Success") {
				return outcome.success
			}
			const err = outcome.failure
			if (attemptNumber >= maxRetries || !shouldRetryError(err, safety)) {
				return yield* err
			}
			const nowMillis = yield* Clock.currentTimeMillis
			const retryAfterMs = isAPIError(err) ? parseRetryAfterMs(err.headers, nowMillis) : undefined
			const jitterInt = yield* runtime.random.intBetween(0, 1000)
			const delayMs = computeRetryDelayMs(attemptNumber, retryAfterMs, jitterInt / 1000)
			attemptNumber += 1
			if (delayMs > 0) {
				yield* Effect.sleep(Duration.millis(delayMs))
			}
		}
	}).pipe(Effect.withSpan(spanName))

export function unwrapResponse<A>(
	effect: Effect.Effect<WithResponse<A>, CheckfuSdkError>,
	options: WithResponseRequestOptions,
): Effect.Effect<WithResponse<A>, CheckfuSdkError>
export function unwrapResponse<A>(
	effect: Effect.Effect<WithResponse<A>, CheckfuSdkError>,
	options?: RequestOptions,
): Effect.Effect<A, CheckfuSdkError>
export function unwrapResponse<A>(
	effect: Effect.Effect<WithResponse<A>, CheckfuSdkError>,
	options?: AnyRequestOptions,
): Effect.Effect<A | WithResponse<A>, CheckfuSdkError>
export function unwrapResponse<A>(
	effect: Effect.Effect<WithResponse<A>, CheckfuSdkError>,
	options?: AnyRequestOptions,
): Effect.Effect<A | WithResponse<A>, CheckfuSdkError> {
	return options?.withResponse === true ? effect : Effect.map(effect, (res) => res.data)
}

export const executePaginatedPagesEffect = <
	Item,
	Cursor extends string | number = number,
	Page extends CursorPageEnvelope<Item, Cursor> = CursorPageEnvelope<Item, Cursor>,
>(
	fetchPage: (after: Cursor | undefined) => Effect.Effect<Page, CheckfuSdkError>,
	initialAfter: Cursor | undefined,
	order: "asc" | "desc",
): Stream.Stream<Page, CheckfuSdkError> =>
	Stream.suspend(() => {
		interface PageCursor {
			readonly after: Cursor | undefined
			readonly done: boolean
		}
		const seenCursors = new Set<Cursor>()
		if (initialAfter !== undefined) {
			seenCursors.add(initialAfter)
		}
		const initialCursor: PageCursor = { after: initialAfter, done: false }
		return Stream.unfold(
			initialCursor,
			(
				cursor: PageCursor,
			): Effect.Effect<readonly [Page, PageCursor] | undefined, CheckfuSdkError> => {
				if (cursor.done) {
					return Effect.undefined
				}
				return fetchPage(cursor.after).pipe(
					Effect.flatMap((page): Effect.Effect<readonly [Page, PageCursor], CheckfuSdkError> => {
						if (!page.has_more || page.next_cursor === null) {
							const next: PageCursor = { after: undefined, done: true }
							return Effect.succeed([page, next] as const)
						}
						const nextAfter = page.next_cursor
						const repeated = seenCursors.has(nextAfter)
						const regressed =
							typeof cursor.after === "number" &&
							typeof nextAfter === "number" &&
							(order === "asc" ? nextAfter <= cursor.after : nextAfter >= cursor.after)
						if (repeated || regressed) {
							return Effect.fail(
								new PaginationCursorCycleError({
									message: `Pagination cursor did not advance (${String(cursor.after)} -> ${String(nextAfter)}).`,
								}),
							)
						}
						seenCursors.add(nextAfter)
						const next: PageCursor = { after: nextAfter, done: false }
						return Effect.succeed([page, next] as const)
					}),
				)
			},
		)
	})

export const executePaginatedStreamEffect = <
	Item,
	Cursor extends string | number = number,
	Page extends CursorPageEnvelope<Item, Cursor> = CursorPageEnvelope<Item, Cursor>,
>(
	fetchPage: (after: Cursor | undefined) => Effect.Effect<Page, CheckfuSdkError>,
	initialAfter: Cursor | undefined,
	order: "asc" | "desc",
): Stream.Stream<Item, CheckfuSdkError> =>
	executePaginatedPagesEffect(fetchPage, initialAfter, order).pipe(
		Stream.flatMap((page) => Stream.fromIterable(page.data)),
	)

type RawSseMethod = (request: {
	readonly params?: unknown
	readonly query?: unknown
	readonly responseMode: "decoded-and-response"
}) => Effect.Effect<
	readonly [Stream.Stream<unknown, ApiSseError> | void, HttpClientResponse.HttpClientResponse],
	ApiSseError
>

const lookupRawSseMethod = (
	raw: CheckfuHttpApiClient,
	group: string,
	endpoint: string,
): RawSseMethod | undefined => {
	for (const [groupName, groupClient] of Object.entries(raw)) {
		if (groupName !== group || typeof groupClient !== "object" || groupClient === null) {
			continue
		}
		for (const [endpointName, fn] of Object.entries(groupClient)) {
			if (endpointName === endpoint && typeof fn === "function") {
				// Boundary dispatch: `raw[group][endpoint]` is the typed HttpApiClient SSE endpoint.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				return fn as RawSseMethod
			}
		}
	}
	return undefined
}

export const executeEndpointSseEffect = <G extends ApiGroupName, E extends ApiEndpointName<G>>(
	runtime: EffectSdkRuntime,
	group: G,
	endpoint: E,
	rawParams: Readonly<Record<string, string>>,
	rawQuery: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
	options?: SessionEventsStreamOptions,
): Stream.Stream<EndpointSseEvent<G, E>, CheckfuSdkError> => {
	if (group === "sessions" && endpoint === "streamEvents") {
		const sessionId = rawParams["session_id"] ?? ""
		const rawAfter = rawQuery?.["after"]
		const after = typeof rawAfter === "number" ? rawAfter : undefined
		// Boundary dispatch: `sessions.streamEvents` decodes `SessionEvent`, matching `EndpointSseEvent<"sessions", "streamEvents">`.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		return streamSessionEvents(runtime.raw, sessionId, {
			...options,
			...(after === undefined ? {} : { after }),
		}) as Stream.Stream<EndpointSseEvent<G, E>, CheckfuSdkError>
	}
	return Stream.unwrap(
		Effect.gen(function* () {
			const hasParams = Object.keys(rawParams).length > 0
			const decodedParams = hasParams
				? yield* decodeEndpointParams(group, endpoint, rawParams)
				: undefined
			const method = lookupRawSseMethod(runtime.raw, String(group), String(endpoint))
			if (method === undefined) {
				return yield* new BadRequestError({
					status: 400,
					errorType: "invalid_request_error",
					message: `Unknown endpoint ${String(group)}.${String(endpoint)}.`,
				})
			}
			return streamApiSse<EndpointSseEvent<G, E>>({
				open: () =>
					// Boundary cast: `method` decodes `EndpointSseEvent<G, E>` streams for `CheckfuApi[G][E]`.
					// oxlint-disable-next-line typescript/no-unsafe-type-assertion
					method({
						...(decodedParams === undefined ? {} : { params: decodedParams }),
						...(rawQuery === undefined ? {} : { query: rawQuery }),
						responseMode: "decoded-and-response",
					}) as Effect.Effect<
						readonly [
							Stream.Stream<EndpointSseEvent<G, E>, ApiSseError> | void,
							HttpClientResponse.HttpClientResponse,
						],
						ApiSseError
					>,
				options,
			})
		}),
	)
}

export const pollPending = <T>(
	pending: PendingResource,
	fetchResource: (id: string, opts?: RequestOptions) => Effect.Effect<T, CheckfuSdkError>,
	options?: WaitForPendingOptions<T>,
): Effect.Effect<T, CheckfuSdkError> =>
	Effect.gen(function* () {
		const timeoutDuration = Option.getOrElse(
			options?.timeout === undefined ? Option.none() : Duration.fromInput(options.timeout),
			() => Duration.millis(DEFAULT_PENDING_TIMEOUT_MS),
		)
		const initialDelayMs = Math.max(
			1,
			Duration.toMillis(
				Option.getOrElse(
					options?.initialDelay === undefined
						? Option.none()
						: Duration.fromInput(options.initialDelay),
					() => Duration.millis(DEFAULT_PENDING_INITIAL_DELAY_MS),
				),
			),
		)
		const maxDelayMs = Math.max(
			initialDelayMs,
			Duration.toMillis(
				Option.getOrElse(
					options?.maxDelay === undefined ? Option.none() : Duration.fromInput(options.maxDelay),
					() => Duration.millis(DEFAULT_PENDING_MAX_DELAY_MS),
				),
			),
		)
		const timeoutMs = Duration.toMillis(timeoutDuration)
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			return yield* new CheckfuConfigError({
				message: "waitForPending timeout must be a positive finite duration.",
			})
		}

		const startedNanos = yield* Clock.monotonicTimeNanos
		const deadlineNanos = startedNanos + BigInt(Math.trunc(timeoutMs)) * 1_000_000n
		let delayMs = initialDelayMs

		for (;;) {
			const outcome = yield* Effect.result(fetchResource(pending.id, options?.requestOptions))
			if (outcome._tag === "Success") {
				if (options?.until === undefined || options.until(outcome.success)) {
					return outcome.success
				}
			} else {
				const err = outcome.failure
				const retryablePending =
					err._tag === "ServiceUnavailableError" ||
					err._tag === "NotFoundError" ||
					err._tag === "RateLimitError" ||
					err._tag === "APIConnectionError" ||
					err._tag === "APIConnectionTimeoutError"
				if (!retryablePending) {
					return yield* err
				}
			}

			const nowNanos = yield* Clock.monotonicTimeNanos
			if (nowNanos >= deadlineNanos) {
				return yield* new APIConnectionTimeoutError({
					message: `Timed out waiting for pending ${pending.type} "${pending.id}" after ${Duration.format(timeoutDuration)}.`,
				})
			}
			const remainingMs = Number((deadlineNanos - nowNanos) / 1_000_000n)
			const sleepMs = Math.min(delayMs, Math.max(1, remainingMs))
			yield* Effect.sleep(Duration.millis(sleepMs))
			delayMs = Math.min(delayMs * 2, maxDelayMs)
		}
	}).pipe(Effect.withSpan("checkfu.waitForPending"))
