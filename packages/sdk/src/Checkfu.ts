import type { MemorySnapshot, MemoryStoreSnapshot } from "./Schemas.ts"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PendingResource, isPendingResource } from "./Api.ts"
import type {
	Agent,
	Artifact,
	ArtifactSummary,
	ArtifactVersion,
	Automation,
	Environment,
	ListSessionEventsResponse,
	PendingResourceType,
	Session,
	SessionEvent,
} from "./Api.ts"
import {
	CheckfuClient,
	INTERNAL_EFFECT_RUNTIME,
	makeNormalizedCheckfuClientLayer,
	waitForPendingResource,
} from "./Client.ts"
import type { CheckfuClientConfig, PendingResolved, PendingResolvedResource } from "./Client.ts"
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
	AuthenticationError,
	BadRequestError,
	CheckfuConfigError,
	CheckfuError,
	ConflictError,
	InternalServerError,
	NotFoundError,
	PaginationCursorCycleError,
	PayloadTooLargeError,
	PermissionDeniedError,
	RateLimitError,
	ServiceUnavailableError,
	UnexpectedStatusError,
	UnprocessableEntityError,
	UnsupportedMediaTypeError,
} from "./Errors.ts"
import { PromiseResources } from "./generated/Resources.ts"
import {
	APIPromise,
	CursorPage,
	EventStream,
	EventStreamPromise,
	PagePromise,
	isSignalAborted,
	makePromiseSdkRuntime,
	toEffectRequestOptions,
	toIsoJson,
	unwrapPromiseExit,
} from "./PromiseRuntime.ts"
import type {
	PromiseRequestOptions,
	PromiseStreamOptions,
	PromiseWaitForPendingOptions,
	PromiseWithResponse,
} from "./PromiseRuntime.ts"
import type { IsoDateTimes } from "./Runtime.ts"
import {
	DEFAULT_API_URL,
	DEFAULT_MAX_RETRIES,
	DEFAULT_TIMEOUT_MS,
	mergeHeaderMaps,
	parseNormalizedApiUrl,
} from "./Transport.ts"
import type { HeaderMap } from "./Transport.ts"

export { APIPromise, CursorPage, EventStream, EventStreamPromise, PagePromise }
export type {
	IsoDateTimes,
	PromiseRequestOptions,
	PromiseStreamOptions,
	PromiseWaitForPendingOptions,
	PromiseWithResponse,
}

export type JsonAgent = IsoDateTimes<Agent>
export type JsonEnvironment = IsoDateTimes<Environment>
export type JsonSession = IsoDateTimes<Session>
export type JsonAutomation = IsoDateTimes<Automation>
export type JsonArtifact = IsoDateTimes<Artifact>
export type JsonArtifactSummary = IsoDateTimes<ArtifactSummary>
export type JsonArtifactVersion = IsoDateTimes<ArtifactVersion>
export type JsonMemoryStore = IsoDateTimes<MemoryStoreSnapshot>
export type JsonMemory = IsoDateTimes<MemorySnapshot>
export type JsonSessionEvent = IsoDateTimes<SessionEvent>
export type JsonListSessionEventsResponse = IsoDateTimes<ListSessionEventsResponse>
export type EventsPage = CursorPage<JsonSessionEvent>
export type EventPagePromise = PagePromise<CursorPage<JsonSessionEvent>, JsonSessionEvent>

export interface CheckfuOptions {
	readonly apiKey?: string | undefined
	readonly baseUrl?: string | undefined
	readonly baseURL?: string | undefined
	readonly allowInsecureHttp?: boolean | undefined
	readonly maxRetries?: number | undefined
	readonly timeout?: Duration.Input | null | undefined
	readonly defaultHeaders?: HeaderMap | undefined
	readonly fetch?: typeof globalThis.fetch | undefined
	readonly autoIdempotencyKey?: boolean | undefined
}

const CheckfuProcessEnvSchema = Schema.Struct({
	process: Schema.optional(
		Schema.Struct({
			env: Schema.optional(
				Schema.Struct({
					CHECKFU_API_KEY: Schema.optional(Schema.String),
					CHECKFU_BASE_URL: Schema.optional(Schema.String),
					CHECKFU_API_URL: Schema.optional(Schema.String),
					CHECKFU_URL: Schema.optional(Schema.String),
				}),
			),
		}),
	),
})
const decodeCheckfuProcessEnv = Schema.decodeUnknownOption(CheckfuProcessEnvSchema)

const readEnvVar = (
	name: "CHECKFU_API_KEY" | "CHECKFU_BASE_URL" | "CHECKFU_API_URL" | "CHECKFU_URL",
): string | undefined => {
	const decoded = decodeCheckfuProcessEnv(globalThis)
	if (Option.isNone(decoded)) {
		return undefined
	}
	const raw = decoded.value.process?.env?.[name]
	if (raw === undefined) {
		return undefined
	}
	const trimmed = raw.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

interface ResolvedCheckfuOptions {
	readonly apiKey: string
	readonly baseUrl: string
	readonly allowInsecureHttp: boolean
	readonly maxRetries: number
	readonly timeout: Duration.Input | null
	readonly defaultHeaders: HeaderMap | undefined
	readonly fetch: typeof globalThis.fetch | undefined
	readonly autoIdempotencyKey: boolean
}

const preNormalizedOptions = new WeakSet<CheckfuOptions>()

const resolveConstructorOptions = (
	options: CheckfuOptions | undefined,
	stripApiVersionSuffix: boolean,
): ResolvedCheckfuOptions => {
	if (
		options?.baseUrl !== undefined &&
		options.baseURL !== undefined &&
		options.baseUrl !== options.baseURL
	) {
		throw new CheckfuConfigError({
			message: "Provide either baseUrl or baseURL, not both with different values.",
		})
	}
	const allowInsecureHttp = options?.allowInsecureHttp ?? false
	const rawBaseUrl =
		options?.baseUrl ??
		options?.baseURL ??
		readEnvVar("CHECKFU_BASE_URL") ??
		readEnvVar("CHECKFU_API_URL") ??
		readEnvVar("CHECKFU_URL") ??
		DEFAULT_API_URL
	const parsedUrl = parseNormalizedApiUrl(rawBaseUrl, {
		allowInsecureHttp,
		stripApiVersionSuffix,
	})
	if (!parsedUrl.ok) {
		throw new CheckfuConfigError({ message: parsedUrl.message })
	}

	const rawApiKey = options?.apiKey ?? readEnvVar("CHECKFU_API_KEY")
	const apiKey = rawApiKey?.trim() ?? ""
	if (apiKey.length === 0) {
		throw new CheckfuConfigError({
			message:
				"Missing CHECKFU_API_KEY. Pass { apiKey } to new Checkfu(...) or export CHECKFU_API_KEY.",
		})
	}

	const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
	if (!Number.isInteger(maxRetries) || maxRetries < 0) {
		throw new CheckfuConfigError({
			message: `Invalid maxRetries (${String(maxRetries)}). Expected a non-negative integer.`,
		})
	}

	const timeout = options?.timeout === undefined ? DEFAULT_TIMEOUT_MS : options.timeout
	if (timeout !== null) {
		const parsedTimeout = Duration.fromInput(timeout)
		if (Option.isNone(parsedTimeout)) {
			throw new CheckfuConfigError({ message: "Invalid timeout duration." })
		}
		if (Duration.isFinite(parsedTimeout.value) && Duration.toMillis(parsedTimeout.value) <= 0) {
			throw new CheckfuConfigError({
				message: "Timeout must be a positive duration or null.",
			})
		}
	}

	return {
		apiKey,
		baseUrl: parsedUrl.url,
		allowInsecureHttp,
		maxRetries,
		timeout,
		defaultHeaders: options?.defaultHeaders,
		fetch: options?.fetch,
		autoIdempotencyKey: options?.autoIdempotencyKey ?? true,
	}
}

type Settled<K extends keyof PendingResolved> = IsoDateTimes<PendingResolved[K]>

const isPendingReceipt = Schema.is(PendingResource)

export class Checkfu extends PromiseResources {
	static readonly CheckfuError = CheckfuError
	static readonly APIError = APIError
	static readonly BadRequestError = BadRequestError
	static readonly AuthenticationError = AuthenticationError
	static readonly PermissionDeniedError = PermissionDeniedError
	static readonly NotFoundError = NotFoundError
	static readonly ConflictError = ConflictError
	static readonly PayloadTooLargeError = PayloadTooLargeError
	static readonly UnsupportedMediaTypeError = UnsupportedMediaTypeError
	static readonly UnprocessableEntityError = UnprocessableEntityError
	static readonly RateLimitError = RateLimitError
	static readonly InternalServerError = InternalServerError
	static readonly ServiceUnavailableError = ServiceUnavailableError
	static readonly UnexpectedStatusError = UnexpectedStatusError
	static readonly APIConnectionError = APIConnectionError
	static readonly APIConnectionTimeoutError = APIConnectionTimeoutError
	static readonly APIUserAbortError = APIUserAbortError
	static readonly PaginationCursorCycleError = PaginationCursorCycleError
	static readonly CheckfuConfigError = CheckfuConfigError
	static readonly isPendingResource = isPendingResource

	readonly baseUrl: string
	readonly baseURL: string
	readonly #config: ResolvedCheckfuOptions
	readonly #runtime: ManagedRuntime.ManagedRuntime<CheckfuClient, CheckfuConfigError>

	constructor(options?: CheckfuOptions) {
		const stripApiVersionSuffix = options === undefined || !preNormalizedOptions.has(options)
		const resolved = resolveConstructorOptions(options, stripApiVersionSuffix)
		const layerConfig: CheckfuClientConfig & {
			readonly baseUrl: string
			readonly fetch?: typeof globalThis.fetch | undefined
		} = {
			apiKey: resolved.apiKey,
			baseUrl: resolved.baseUrl,
			allowInsecureHttp: resolved.allowInsecureHttp,
			maxRetries: resolved.maxRetries,
			timeout: resolved.timeout,
			defaultHeaders: resolved.defaultHeaders,
			autoIdempotencyKey: resolved.autoIdempotencyKey,
			fetch: resolved.fetch,
		}
		const managed = ManagedRuntime.make(makeNormalizedCheckfuClientLayer(layerConfig))
		const promiseRuntime = makePromiseSdkRuntime(
			managed,
			Effect.map(CheckfuClient, (client) => client[INTERNAL_EFFECT_RUNTIME]),
		)
		super(promiseRuntime)
		this.#config = resolved
		this.baseUrl = resolved.baseUrl
		this.baseURL = resolved.baseUrl
		this.#runtime = managed
	}

	withOptions(overrides: CheckfuOptions): Checkfu {
		const mergedHeaders = mergeHeaderMaps(this.#config.defaultHeaders, overrides.defaultHeaders)
		const hasBaseOverride = overrides.baseUrl !== undefined || overrides.baseURL !== undefined
		const nextOptions: CheckfuOptions = {
			apiKey: overrides.apiKey ?? this.#config.apiKey,
			...(hasBaseOverride
				? {
						...(overrides.baseUrl === undefined ? {} : { baseUrl: overrides.baseUrl }),
						...(overrides.baseURL === undefined ? {} : { baseURL: overrides.baseURL }),
					}
				: { baseUrl: this.#config.baseUrl }),
			allowInsecureHttp: overrides.allowInsecureHttp ?? this.#config.allowInsecureHttp,
			maxRetries: overrides.maxRetries ?? this.#config.maxRetries,
			timeout: overrides.timeout === undefined ? this.#config.timeout : overrides.timeout,
			defaultHeaders: mergedHeaders,
			fetch: overrides.fetch ?? this.#config.fetch,
			autoIdempotencyKey: overrides.autoIdempotencyKey ?? this.#config.autoIdempotencyKey,
		}
		if (!hasBaseOverride) {
			preNormalizedOptions.add(nextOptions)
		}
		return new Checkfu(nextOptions)
	}

	waitForPending<R extends Settled<PendingResourceType> | IsoDateTimes<PendingResource>>(
		result: R,
		options?: PromiseWaitForPendingOptions<Settled<R["type"]>>,
	): Promise<Settled<R["type"]>>
	async waitForPending(
		result: Settled<keyof PendingResolved> | IsoDateTimes<PendingResource>,
		options?: PromiseWaitForPendingOptions<Settled<keyof PendingResolved>>,
	): Promise<Settled<keyof PendingResolved>> {
		if (!isPendingResource(result)) {
			return result
		}
		const signal = options?.signal ?? options?.requestOptions?.signal
		if (isSignalAborted(signal)) {
			throw new APIUserAbortError({ message: "Request was aborted." })
		}
		if (!isPendingReceipt(result)) {
			throw new CheckfuConfigError({
				message: `waitForPending cannot wait for a pending ${String(result.type)}.`,
			})
		}
		const requestOptions = toEffectRequestOptions(options?.requestOptions)
		const until = options?.until
		const effect = Effect.flatMap(CheckfuClient, (client) =>
			Effect.map(
				waitForPendingResource(client, result, {
					...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
					...(options?.initialDelay === undefined ? {} : { initialDelay: options.initialDelay }),
					...(options?.maxDelay === undefined ? {} : { maxDelay: options.maxDelay }),
					...(requestOptions === undefined ? {} : { requestOptions }),
					...(until === undefined
						? {}
						: { until: (resource: PendingResolvedResource) => until(toIsoJson(resource)) }),
				}),
				toIsoJson,
			),
		)
		const exit = await this.#runtime.runPromiseExit(
			effect,
			signal === undefined ? undefined : { signal },
		)
		return unwrapPromiseExit(exit, isSignalAborted(signal))
	}

	close(): Promise<void> {
		return this.#runtime.dispose()
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close()
	}
}

export default Checkfu
