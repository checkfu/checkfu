import * as Clock from "effect/Clock"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { CheckfuApi, ClientEventId } from "./Api.ts"
import type { CheckfuHttpApiClient, PendingResource } from "./Api.ts"
import {
	asEndpointSseEvent,
	asEndpointSseStream,
	endpointParamsCodec,
	lookupRawSseMethod,
} from "./Boundary.ts"
import type {
	ApiEndpoint,
	ApiEndpointName,
	ApiGroupName,
	EndpointDecodedParams,
	EndpointProp,
	EndpointSseEvent,
	EndpointSuccess,
	IsoDateTimes,
	SchemaTypeOrNever,
} from "./Boundary.ts"
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	BadRequestError,
	CheckfuConfigError,
	PaginationCursorCycleError,
	isAPIError,
	mapRawClientError,
} from "./Errors.ts"
import type { CheckfuSdkError } from "./Errors.ts"
import { snapshotSessionStreamOptions, streamApiSse, streamSessionEvents } from "./Sse.ts"
import type { StreamSessionEventsOptions } from "./Sse.ts"
import {
	CurrentRequestTransportMeta,
	forbidIdempotencyKey,
	snapshotHeaders,
	computeRetryDelayMs,
	lookupHeader,
	mergeHeaderMaps,
	parseRetryAfterMs,
	shouldRetryError,
	validatePathSegment,
} from "./Transport.ts"
import type { HeaderMap, RetrySafety } from "./Transport.ts"

export { forbidIdempotencyKey }

export type {
	ApiEndpoint,
	ApiEndpointName,
	ApiGroupName,
	EndpointDecodedParams,
	EndpointSseEvent,
	EndpointSuccess,
	IsoDateTimes,
}

type RequiredKeysOf<T> = {
	[K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K
}[keyof T]

type OptionalKeysOf<T> = {
	[K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]

export type RelaxOptionalProps<T> = [T] extends [never]
	? never
	: T extends object
		? { readonly [K in RequiredKeysOf<T>]: T[K] } & {
				readonly [K in OptionalKeysOf<T>]?: T[K] | undefined
			}
		: T

type JsonPayloadOf<P> =
	P extends ReadonlyMap<string, { readonly schemas: ReadonlyArray<Schema.Top> }>
		? never
		: P extends Schema.Top
			? P["Type"]
			: never

type JsonPayloadEncodedOf<P> =
	P extends ReadonlyMap<string, { readonly schemas: ReadonlyArray<Schema.Top> }>
		? never
		: P extends Schema.Top
			? P["Encoded"]
			: never

export type PathParam<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
	K extends keyof EndpointDecodedParams<G, E>,
> = EndpointDecodedParams<G, E>[K] extends number ? number : string

export type EndpointParams<G extends ApiGroupName, E extends ApiEndpointName<G>> = IsoDateTimes<
	EndpointDecodedParams<G, E>
>

export type EndpointQuery<G extends ApiGroupName, E extends ApiEndpointName<G>> = SchemaTypeOrNever<
	EndpointProp<ApiEndpoint<G, E>, "~Query">
>

export type EndpointBody<G extends ApiGroupName, E extends ApiEndpointName<G>> = JsonPayloadOf<
	EndpointProp<ApiEndpoint<G, E>, "~Payload">
>

export type EndpointJsonBody<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = JsonPayloadEncodedOf<EndpointProp<ApiEndpoint<G, E>, "~Payload">>

export type EndpointJsonSuccess<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = IsoDateTimes<EndpointSuccess<G, E>>

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
	JsonBody = Body,
> {
	readonly path: Path
	readonly query: Query
	readonly body: Body
	readonly result: Result
	readonly jsonResult: JsonResult
	readonly jsonBody: JsonBody
}

export type PathOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["path"]
export type QueryOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["query"]
export type BodyOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["body"]
export type JsonBodyOf<
	O extends OperationShape<unknown, unknown, unknown, unknown, unknown, unknown>,
> = O["jsonBody"]
export type ResultOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["result"]
export type JsonResultOf<O extends OperationShape<unknown, unknown, unknown, unknown, unknown>> =
	O["jsonResult"]

export type ItemOf<R> = R extends { readonly data: ReadonlyArray<infer T> }
	? T
	: R extends { readonly items: ReadonlyArray<infer T> }
		? T
		: never

export interface PageEnvelope<Item> {
	readonly data: ReadonlyArray<Item>
	readonly next_page: string | null
}

export interface RequestOptions<Key extends string = string> {
	readonly headers?: HeaderMap | undefined
	readonly timeout?: Duration.Input | null | undefined
	readonly maxRetries?: number | undefined
	readonly idempotencyKey?: Key | undefined
	readonly withResponse?: false | undefined
}

export interface WithResponseRequestOptions<Key extends string = string> {
	readonly headers?: HeaderMap | undefined
	readonly timeout?: Duration.Input | null | undefined
	readonly maxRetries?: number | undefined
	readonly idempotencyKey?: Key | undefined
	readonly withResponse: true
}

export type AnyRequestOptions<Key extends string = string> =
	| RequestOptions<Key>
	| WithResponseRequestOptions<Key>

export const snapshotRequestOptions = <Options extends AnyRequestOptions>(
	options: Options | undefined,
): Options | undefined =>
	options === undefined
		? undefined
		: {
				...options,
				headers: snapshotHeaders(options.headers),
				idempotencyKey: options.idempotencyKey,
				maxRetries: options.maxRetries,
				timeout: options.timeout,
				withResponse: options.withResponse,
			}

export interface WithResponse<A> {
	readonly data: A
	readonly response: HttpClientResponse.HttpClientResponse
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly requestId: string | undefined
}

export type SessionEventsStreamOptions = StreamSessionEventsOptions

export interface WaitForPendingOptions<T> {
	readonly timeout?: Duration.Input | undefined
	readonly initialDelay?: Duration.Input | undefined
	readonly maxDelay?: Duration.Input | undefined
	until?(this: void, resource: T): boolean
	readonly requestOptions?: RequestOptions<never> | undefined
}

export interface EffectSdkRuntime {
	readonly baseUrl: string
	readonly raw: CheckfuHttpApiClient
	readonly defaultHeaders: HeaderMap | undefined
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

const invalidPath = (message: string) =>
	new BadRequestError({ status: 400, errorType: "invalid_request_error", message })

export const decodeEndpointParams = <G extends ApiGroupName, E extends ApiEndpointName<G>>(
	group: G,
	endpoint: E,
	pathArgs: Readonly<Record<string, string | number>>,
): Effect.Effect<EndpointDecodedParams<G, E>, BadRequestError> => {
	for (const [label, value] of Object.entries(pathArgs)) {
		const pathErr = typeof value === "string" ? validatePathSegment(value, label) : undefined
		if (pathErr !== undefined) {
			return Effect.fail(invalidPath(pathErr))
		}
	}
	const endpointDef = lookupCheckfuEndpoint(String(group), String(endpoint))
	const paramsSchema = endpointDef?.params
	if (paramsSchema === undefined) {
		return Effect.fail(
			invalidPath(`Endpoint ${String(group)}.${String(endpoint)} does not accept path parameters.`),
		)
	}
	const params = endpointParamsCodec<G, E>(paramsSchema)
	return Schema.encodeUnknownEffect(params)(pathArgs).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(params)),
		Effect.mapError((err) => invalidPath(`Invalid path parameters: ${err.message}`)),
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
	options: AnyRequestOptions | undefined,
): Effect.Effect<ClientEventId | undefined, BadRequestError> => {
	const perCallHeader = lookupHeader(options?.headers, "idempotency-key")
	if (perCallHeader !== undefined) {
		return perCallHeader === null ? Effect.undefined : decodeClientIdempotencyKey(perCallHeader)
	}
	if (options?.idempotencyKey !== undefined) {
		return decodeClientIdempotencyKey(options.idempotencyKey)
	}
	if (
		!runtime.autoIdempotencyKey ||
		lookupHeader(runtime.defaultHeaders, "idempotency-key") === null
	) {
		return Effect.undefined
	}
	return Effect.flatMap(runtime.generateIdempotencyKey, decodeClientIdempotencyKey)
}

export const resolveRequiredIdempotencyKey = (
	runtime: EffectSdkRuntime,
	options: AnyRequestOptions | undefined,
): Effect.Effect<ClientEventId, BadRequestError> =>
	Effect.filterOrFail(
		resolveCallIdempotencyKey({ ...runtime, autoIdempotencyKey: false }, options),
		(key): key is ClientEventId => key !== undefined,
		() =>
			new BadRequestError({
				status: 400,
				errorType: "invalid_request_error",
				message:
					"This operation needs an idempotencyKey you keep: resending the request with the same key returns what the first request created.",
			}),
	)

export const withResolvedIdempotencyKey = (
	options: AnyRequestOptions | undefined,
	key: ClientEventId | undefined,
): AnyRequestOptions => {
	const headers = mergeHeaderMaps(options?.headers, {
		"idempotency-key": key ?? null,
	})
	return options === undefined ? { headers } : { ...options, headers }
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
					Effect.timeoutOrElse({
						duration: effectiveTimeout,
						orElse: () =>
							Effect.fail(
								new APIConnectionTimeoutError({
									message: `Request timed out after ${Duration.format(effectiveTimeout)}.`,
								}),
							),
					}),
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

type VersionField = "version" | "revision"

export type PendingReadiness =
	| { readonly kind: "create" }
	| { readonly kind: "archive" }
	| { readonly kind: "min-version"; readonly field: VersionField; readonly minVersion: number }
	| { readonly kind: "requires-until"; readonly operation: string }

const pendingReadinessByReceipt = new WeakMap<object, PendingReadiness>()

export const attachPendingReadiness = <A>(value: A, readiness: PendingReadiness): A => {
	if (typeof value === "object" && value !== null && "pending" in value && value.pending === true) {
		pendingReadinessByReceipt.set(value, readiness)
	}
	return value
}

const validVersion = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1

export const getPendingReadiness = (value: unknown): PendingReadiness | undefined => {
	if (typeof value !== "object" || value === null) {
		return undefined
	}
	if ("pending" in value && value.pending === true && "type" in value) {
		if (value.type === "agent" && "version" in value && validVersion(value.version)) {
			return { kind: "min-version", field: "version", minVersion: value.version }
		}
		if (value.type === "automation" && "revision" in value && validVersion(value.revision)) {
			return { kind: "min-version", field: "revision", minVersion: value.revision }
		}
	}
	return pendingReadinessByReceipt.get(value)
}

const minimumVersion = (body: unknown, field: VersionField): PendingReadiness | undefined => {
	const current =
		typeof body === "object" && body !== null && Predicate.hasProperty(body, field)
			? body[field]
			: undefined
	return validVersion(current) ? { kind: "min-version", field, minVersion: current + 1 } : undefined
}

export const pendingUpdateReadiness = (body: unknown, operation: string): PendingReadiness =>
	minimumVersion(body, "version") ??
	minimumVersion(body, "revision") ?? { kind: "requires-until", operation }

export const withPendingReadiness = <A>(
	effect: Effect.Effect<WithResponse<A>, CheckfuSdkError>,
	readiness: PendingReadiness,
): Effect.Effect<WithResponse<A>, CheckfuSdkError> =>
	Effect.map(effect, (res) => {
		attachPendingReadiness(res.data, readiness)
		return res
	})

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

export const executePaginatedPagesEffect = <Page extends PageEnvelope<unknown>>(
	fetchPage: (page: string | undefined) => Effect.Effect<Page, CheckfuSdkError>,
	initialPage: string | undefined,
): Stream.Stream<Page, CheckfuSdkError> =>
	Stream.suspend(() => {
		const seen = new Set<string>(initialPage === undefined ? [] : [initialPage])
		return Stream.unfold<string | null | undefined, Page, CheckfuSdkError, never>(
			initialPage,
			(token) => {
				if (token === null) {
					return Effect.undefined
				}
				return fetchPage(token).pipe(
					Effect.flatMap((page) => {
						const next = page.next_page
						if (next !== null && seen.has(next)) {
							return Effect.fail(
								new PaginationCursorCycleError({
									message: `Pagination cursor did not advance (${token} -> ${next}).`,
								}),
							)
						}
						if (next !== null) {
							seen.add(next)
						}
						return Effect.succeed([page, next] as const)
					}),
				)
			},
		)
	})

export const executePaginatedStreamEffect = <Item>(
	fetchPage: (page: string | undefined) => Effect.Effect<PageEnvelope<Item>, CheckfuSdkError>,
	initialPage: string | undefined,
): Stream.Stream<Item, CheckfuSdkError> =>
	executePaginatedPagesEffect(fetchPage, initialPage).pipe(
		Stream.flatMap((page) => Stream.fromIterable(page.data)),
	)

const decodeGenericSseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

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
		return asEndpointSseStream<G, E>(
			streamSessionEvents(
				runtime.raw,
				sessionId,
				snapshotSessionStreamOptions(options, after),
				runtime.defaultHeaders,
			),
		)
	}
	const requestOptions = snapshotSessionStreamOptions(options)
	return Stream.unwrap(
		Effect.gen(function* () {
			yield* forbidIdempotencyKey(`${String(group)}.${String(endpoint)}`, requestOptions)
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
					method({
						...(decodedParams === undefined ? {} : { params: decodedParams }),
						...(rawQuery === undefined ? {} : { query: rawQuery }),
						responseMode: "response-only",
					}),
				decodeEvent: (rawData) =>
					decodeGenericSseJson(rawData).pipe(
						Effect.mapBoth({
							onSuccess: (parsed) => asEndpointSseEvent<G, E>(parsed),
							onFailure: (err) =>
								new APIConnectionError({
									message: `Invalid SSE event payload: ${err.message}`,
									cause: err,
									transient: false,
								}),
						}),
					),
				defaultHeaders: runtime.defaultHeaders,
				options: requestOptions,
			})
		}),
	)
}

const custodySettled = (custody: unknown): boolean =>
	typeof custody === "string"
		? custody === "erased"
		: typeof custody !== "object" ||
			custody === null ||
			Object.values(custody).every((count) => typeof count !== "number" || count === 0)

const isResourceReadyForMutation = <T>(
	resource: T,
	readiness: PendingReadiness | undefined,
): boolean => {
	if (readiness === undefined || readiness.kind === "requires-until") {
		return true
	}
	if (readiness.kind === "create") {
		return (
			typeof resource !== "object" ||
			resource === null ||
			!("custody" in resource) ||
			resource.custody !== "storing"
		)
	}
	if (typeof resource !== "object" || resource === null) {
		return false
	}
	if (readiness.kind === "archive") {
		return (
			"archived_at" in resource &&
			resource.archived_at !== null &&
			resource.archived_at !== undefined &&
			(!("custody" in resource) || custodySettled(resource.custody))
		)
	}
	const current = Predicate.hasProperty(resource, readiness.field)
		? resource[readiness.field]
		: undefined
	return typeof current === "number" && current >= readiness.minVersion
}

class PendingNotReady extends Data.TaggedError("PendingNotReady") {}

const isRetryablePendingRead = (error: CheckfuSdkError): boolean =>
	error._tag === "ServiceUnavailableError" ||
	error._tag === "NotFoundError" ||
	error._tag === "RateLimitError" ||
	error._tag === "APIConnectionTimeoutError" ||
	(error._tag === "APIConnectionError" && error.retryable)

export const pollPending = <T>(
	pending: PendingResource,
	fetchResource: (id: string, opts?: RequestOptions<never>) => Effect.Effect<T, CheckfuSdkError>,
	options?: WaitForPendingOptions<T>,
): Effect.Effect<T, CheckfuSdkError> =>
	Effect.gen(function* () {
		const readiness: PendingReadiness | undefined =
			pending.type === "artifact_version" && "version" in pending
				? { kind: "create" }
				: getPendingReadiness(pending)
		if (readiness === undefined && options?.until === undefined) {
			return yield* new CheckfuConfigError({
				message: `waitForPending for unrecognized pending ${pending.type} "${pending.id}" requires an explicit "until" predicate because its originating mutation is unknown.`,
			})
		}
		if (readiness?.kind === "requires-until" && options?.until === undefined) {
			return yield* new CheckfuConfigError({
				message: `waitForPending for pending ${readiness.operation} requires an explicit "until" predicate to distinguish the updated projection from existing state.`,
			})
		}
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

		const poll = Effect.gen(function* () {
			const resource = yield* fetchResource(pending.id, options?.requestOptions)
			if (
				isResourceReadyForMutation(resource, readiness) &&
				(options?.until === undefined || options.until(resource))
			) {
				return resource
			}
			return yield* new PendingNotReady()
		})

		const timedOut = () =>
			Effect.fail(
				new APIConnectionTimeoutError({
					message: `Timed out waiting for pending ${pending.type} "${pending.id}" after ${Duration.format(timeoutDuration)}.`,
				}),
			)
		return yield* poll.pipe(
			Effect.retry({
				while: (error) => error._tag === "PendingNotReady" || isRetryablePendingRead(error),
				schedule: Schedule.min([
					Schedule.exponential(Duration.millis(initialDelayMs)),
					Schedule.spaced(Duration.millis(maxDelayMs)),
				]),
			}),
			Effect.timeoutOrElse({ duration: timeoutDuration, orElse: timedOut }),
			Effect.catchTag("PendingNotReady", timedOut),
		)
	}).pipe(Effect.withSpan("checkfu.waitForPending"))
