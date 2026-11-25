import * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import { isPendingResource, makeCheckfuHttpApiClientWith } from "./Api.ts"
import type {
	Agent,
	Artifact,
	ArtifactVersion,
	Automation,
	CheckfuHttpApiClient,
	Environment,
	PendingAgent,
	PendingArtifact,
	PendingArtifactVersion,
	PendingAutomation,
	PendingEnvironment,
	PendingMemory,
	PendingMemoryStore,
	PendingSession,
	Session,
} from "./Api.ts"
import { CheckfuConfigError } from "./Errors.ts"
import type { CheckfuSdkError } from "./Errors.ts"
import { EffectResources } from "./generated/Resources.ts"
import type { Op } from "./generated/Resources.ts"
import { normalizeMaxRetries, pollPending, resolveTimeout } from "./Runtime.ts"
import type {
	AnyRequestOptions,
	BodyOf,
	EffectSdkRuntime,
	QueryOf,
	RequestOptions,
	SessionEventsStreamOptions,
	WaitForPendingOptions,
	WithResponse,
	WithResponseRequestOptions,
} from "./Runtime.ts"
import type { MemorySnapshot, MemoryStoreSnapshot } from "./Schemas.ts"
import {
	DEFAULT_MAX_RETRIES,
	DEFAULT_TIMEOUT_MS,
	generateIdempotencyKey,
	makeAuthorizedHttpClient,
	mergeHeaderMaps,
	normalizeApiKey,
	normalizeApiUrl,
	resolveApiKey,
	resolveBaseUrl,
} from "./Transport.ts"
import type { HeaderMap } from "./Transport.ts"

export type {
	AnyRequestOptions,
	RequestOptions,
	SessionEventsStreamOptions,
	WaitForPendingOptions,
	WithResponse,
	WithResponseRequestOptions,
}

export type AgentCreateParams = BodyOf<Op<"agents.create">>
export type AgentUpdateParams = BodyOf<Op<"agents.update">>
export type EnvironmentCreateParams = BodyOf<Op<"environments.create">>
export type EnvironmentUpdateParams = BodyOf<Op<"environments.update">>
export type SessionCreateParams = BodyOf<Op<"sessions.create">>
export type SessionEventsSendParams = BodyOf<Op<"sessions.events.send">>
export type SessionEventsListParams = QueryOf<Op<"sessions.events.list">>
export type SessionEventsStreamParams = QueryOf<Op<"sessions.events.stream">>

export interface CheckfuClientConfig {
	readonly apiKey: string | Redacted.Redacted<string>
	readonly baseUrl?: string | undefined
	readonly allowInsecureHttp?: boolean | undefined
	readonly maxRetries?: number | undefined
	readonly timeout?: Duration.Input | null | undefined
	readonly defaultHeaders?: HeaderMap | undefined
	readonly autoIdempotencyKey?: boolean | undefined
}

export interface CheckfuClientEnvConfig {
	readonly apiKey?: string | Redacted.Redacted<string> | undefined
	readonly baseUrl?: string | undefined
	readonly allowInsecureHttp?: boolean | undefined
	readonly maxRetries?: number | undefined
	readonly timeout?: Duration.Input | null | undefined
	readonly defaultHeaders?: HeaderMap | undefined
	readonly autoIdempotencyKey?: boolean | undefined
}

export interface CheckfuClientFetchOptions {
	readonly fetch?: typeof globalThis.fetch | undefined
}

export interface WaitForPendingMethod {
	(
		result: Agent | PendingAgent,
		options?: WaitForPendingOptions<Agent>,
	): Effect.Effect<Agent, CheckfuSdkError>
	(
		result: Environment | PendingEnvironment,
		options?: WaitForPendingOptions<Environment>,
	): Effect.Effect<Environment, CheckfuSdkError>
	(
		result: Session | PendingSession,
		options?: WaitForPendingOptions<Session>,
	): Effect.Effect<Session, CheckfuSdkError>
	(
		result: Automation | PendingAutomation,
		options?: WaitForPendingOptions<Automation>,
	): Effect.Effect<Automation, CheckfuSdkError>
	(
		result: Artifact | PendingArtifact,
		options?: WaitForPendingOptions<Artifact>,
	): Effect.Effect<Artifact, CheckfuSdkError>
	(
		result: ArtifactVersion | PendingArtifactVersion,
		options?: WaitForPendingOptions<ArtifactVersion>,
	): Effect.Effect<ArtifactVersion, CheckfuSdkError>
	(
		result: MemoryStoreSnapshot | PendingMemoryStore,
		options?: WaitForPendingOptions<MemoryStoreSnapshot>,
	): Effect.Effect<MemoryStoreSnapshot, CheckfuSdkError>
	(
		result: MemorySnapshot | PendingMemory,
		options?: WaitForPendingOptions<MemorySnapshot>,
	): Effect.Effect<MemorySnapshot, CheckfuSdkError>
}

export const INTERNAL_EFFECT_RUNTIME = Symbol.for("@checkfu/sdk/EffectSdkRuntime")

export class CheckfuSdkClient extends EffectResources {
	readonly baseUrl: string
	readonly raw: CheckfuHttpApiClient
	readonly generateIdempotencyKey: Effect.Effect<string>
	readonly [INTERNAL_EFFECT_RUNTIME]: EffectSdkRuntime
	readonly #withOptionsImpl: (
		overrides: CheckfuClientEnvConfig,
	) => Effect.Effect<CheckfuClientService, CheckfuConfigError>

	constructor(
		runtime: EffectSdkRuntime,
		withOptionsImpl: (
			overrides: CheckfuClientEnvConfig,
		) => Effect.Effect<CheckfuClientService, CheckfuConfigError>,
	) {
		super(runtime)
		this[INTERNAL_EFFECT_RUNTIME] = runtime
		this.baseUrl = runtime.baseUrl
		this.raw = runtime.raw
		this.generateIdempotencyKey = runtime.generateIdempotencyKey
		this.#withOptionsImpl = withOptionsImpl
	}

	withOptions(
		overrides: CheckfuClientEnvConfig,
	): Effect.Effect<CheckfuClientService, CheckfuConfigError> {
		return this.#withOptionsImpl(overrides)
	}

	waitForPending(
		result: Agent | PendingAgent,
		options?: WaitForPendingOptions<Agent>,
	): Effect.Effect<Agent, CheckfuSdkError>
	waitForPending(
		result: Environment | PendingEnvironment,
		options?: WaitForPendingOptions<Environment>,
	): Effect.Effect<Environment, CheckfuSdkError>
	waitForPending(
		result: Session | PendingSession,
		options?: WaitForPendingOptions<Session>,
	): Effect.Effect<Session, CheckfuSdkError>
	waitForPending(
		result: Automation | PendingAutomation,
		options?: WaitForPendingOptions<Automation>,
	): Effect.Effect<Automation, CheckfuSdkError>
	waitForPending(
		result: Artifact | PendingArtifact,
		options?: WaitForPendingOptions<Artifact>,
	): Effect.Effect<Artifact, CheckfuSdkError>
	waitForPending(
		result: ArtifactVersion | PendingArtifactVersion,
		options?: WaitForPendingOptions<ArtifactVersion>,
	): Effect.Effect<ArtifactVersion, CheckfuSdkError>
	waitForPending(
		result: MemoryStoreSnapshot | PendingMemoryStore,
		options?: WaitForPendingOptions<MemoryStoreSnapshot>,
	): Effect.Effect<MemoryStoreSnapshot, CheckfuSdkError>
	waitForPending(
		result: MemorySnapshot | PendingMemory,
		options?: WaitForPendingOptions<MemorySnapshot>,
	): Effect.Effect<MemorySnapshot, CheckfuSdkError>
	waitForPending(
		result:
			| Agent
			| PendingAgent
			| Environment
			| PendingEnvironment
			| Session
			| PendingSession
			| Automation
			| PendingAutomation
			| Artifact
			| PendingArtifact
			| ArtifactVersion
			| PendingArtifactVersion
			| MemoryStoreSnapshot
			| PendingMemoryStore
			| MemorySnapshot
			| PendingMemory,
		options?: WaitForPendingOptions<
			| Agent
			| Environment
			| Session
			| Automation
			| Artifact
			| ArtifactVersion
			| MemoryStoreSnapshot
			| MemorySnapshot
		>,
	): Effect.Effect<
		| Agent
		| Environment
		| Session
		| Automation
		| Artifact
		| ArtifactVersion
		| MemoryStoreSnapshot
		| MemorySnapshot,
		CheckfuSdkError
	> {
		if (!isPendingResource(result)) {
			return Effect.succeed(result)
		}
		const until = options?.until
		const baseOpts = {
			...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
			...(options?.initialDelay === undefined ? {} : { initialDelay: options.initialDelay }),
			...(options?.maxDelay === undefined ? {} : { maxDelay: options.maxDelay }),
			...(options?.requestOptions === undefined ? {} : { requestOptions: options.requestOptions }),
		}
		switch (result.type) {
			case "agent":
				return pollPending(result, (id, opts) => this.agents.retrieve(id, opts), {
					...baseOpts,
					...(until === undefined ? {} : { until: (resource: Agent) => until(resource) }),
				})
			case "environment":
				return pollPending(result, (id, opts) => this.environments.retrieve(id, opts), {
					...baseOpts,
					...(until === undefined ? {} : { until: (resource: Environment) => until(resource) }),
				})
			case "session":
				return pollPending(result, (id, opts) => this.sessions.retrieve(id, opts), {
					...baseOpts,
					...(until === undefined ? {} : { until: (resource: Session) => until(resource) }),
				})
			case "automation":
				return pollPending(result, (id, opts) => this.automations.retrieve(id, opts), {
					...baseOpts,
					...(until === undefined ? {} : { until: (resource: Automation) => until(resource) }),
				})
			case "artifact":
				return pollPending(result, (id, opts) => this.artifacts.retrieve(id, opts), {
					...baseOpts,
					...(until === undefined ? {} : { until: (resource: Artifact) => until(resource) }),
				})
			case "artifact_version":
				if (!Number.isInteger(result.version) || result.version < 1) {
					return Effect.fail(
						new CheckfuConfigError({
							message: `waitForPending for pending artifact_version "${result.id}" needs the version it committed.`,
						}),
					)
				}
				return pollPending(
					result,
					(id, opts) => this.artifacts.versions.retrieve(id, result.version, opts),
					{
						...baseOpts,
						...(until === undefined
							? {}
							: { until: (resource: ArtifactVersion) => until(resource) }),
					},
				)
			default: {
				const unknown: { readonly type: unknown } = result
				return Effect.fail(
					new CheckfuConfigError({
						message: `waitForPending cannot wait for a pending ${String(unknown.type)}.`,
					}),
				)
			}
			case "memory_store":
				return pollPending(result, (id, opts) => this.memoryStores.retrieve(id, opts), {
					...baseOpts,
					...(until === undefined
						? {}
						: { until: (resource: MemoryStoreSnapshot) => until(resource) }),
				})
			case "memory": {
				const storeId = result.memory_store_id
				return pollPending(
					result,
					(id, opts) => this.memoryStores.memories.retrieve(storeId, id, opts),
					{
						...baseOpts,
						...(until === undefined
							? {}
							: { until: (resource: MemorySnapshot) => until(resource) }),
					},
				)
			}
		}
	}
}

export type CheckfuClientService = CheckfuSdkClient

const buildCheckfuClient = (params: {
	readonly apiKey: Redacted.Redacted<string>
	readonly baseUrl: string
	readonly allowInsecureHttp: boolean
	readonly maxRetries: number
	readonly timeout: Duration.Duration | null
	readonly defaultHeaders: HeaderMap | undefined
	readonly autoIdempotencyKey: boolean
	readonly rawHttpClient: HttpClient.HttpClient
	readonly existingRequestInit: globalThis.RequestInit | undefined
	readonly random: SecureRandom.SecureRandom["Service"]
}): Effect.Effect<CheckfuClientService> =>
	Effect.gen(function* () {
		const authedHttpClient = makeAuthorizedHttpClient(params.rawHttpClient, params.apiKey, {
			defaultHeaders: params.defaultHeaders,
			existingRequestInit: params.existingRequestInit,
		})

		const raw = yield* makeCheckfuHttpApiClientWith({
			baseUrl: params.baseUrl,
			httpClient: authedHttpClient,
		})

		const genIdempotencyKey = generateIdempotencyKey(params.random, "sdk")

		const runtime: EffectSdkRuntime = {
			baseUrl: params.baseUrl,
			raw,
			defaultHeaders: params.defaultHeaders,
			maxRetries: params.maxRetries,
			timeout: params.timeout,
			autoIdempotencyKey: params.autoIdempotencyKey,
			random: params.random,
			generateIdempotencyKey: genIdempotencyKey,
		}

		const withOptions = (
			overrides: CheckfuClientEnvConfig,
		): Effect.Effect<CheckfuClientService, CheckfuConfigError> =>
			Effect.gen(function* () {
				const nextAllowInsecure = overrides.allowInsecureHttp ?? params.allowInsecureHttp
				const nextBaseUrl = yield* normalizeApiUrl(overrides.baseUrl ?? params.baseUrl, {
					allowInsecureHttp: nextAllowInsecure,
					stripApiVersionSuffix: overrides.baseUrl !== undefined,
				})
				const nextApiKey =
					overrides.apiKey === undefined ? params.apiKey : yield* normalizeApiKey(overrides.apiKey)
				const nextMaxRetries = yield* normalizeMaxRetries(overrides.maxRetries, params.maxRetries)
				const nextTimeout = yield* resolveTimeout(overrides.timeout, params.timeout)
				const nextHeaders = mergeHeaderMaps(params.defaultHeaders, overrides.defaultHeaders)
				return yield* buildCheckfuClient({
					...params,
					apiKey: nextApiKey,
					baseUrl: nextBaseUrl,
					allowInsecureHttp: nextAllowInsecure,
					maxRetries: nextMaxRetries,
					timeout: nextTimeout,
					defaultHeaders: nextHeaders,
					autoIdempotencyKey: overrides.autoIdempotencyKey ?? params.autoIdempotencyKey,
				})
			})

		return new CheckfuSdkClient(runtime, withOptions)
	})

const makeCheckfuSdkClientInternal = (
	config: CheckfuClientEnvConfig,
	stripApiVersionSuffix: boolean,
): Effect.Effect<
	CheckfuClientService,
	CheckfuConfigError,
	HttpClient.HttpClient | SecureRandom.SecureRandom
> =>
	Effect.gen(function* () {
		const allowInsecureHttp = config.allowInsecureHttp ?? false
		const baseUrl = yield* resolveBaseUrl(config.baseUrl, {
			allowInsecureHttp,
			stripApiVersionSuffix,
		})
		const apiKey = yield* resolveApiKey(config.apiKey)
		const maxRetries = yield* normalizeMaxRetries(config.maxRetries, DEFAULT_MAX_RETRIES)
		const timeout = yield* resolveTimeout(config.timeout, Duration.millis(DEFAULT_TIMEOUT_MS))
		const rawHttpClient = yield* HttpClient.HttpClient
		const existingRequestInit = Context.getOrUndefined(
			yield* Effect.context(),
			FetchHttpClient.RequestInit,
		)
		const random = yield* SecureRandom.SecureRandom

		return yield* buildCheckfuClient({
			apiKey,
			baseUrl,
			allowInsecureHttp,
			maxRetries,
			timeout,
			defaultHeaders: config.defaultHeaders,
			autoIdempotencyKey: config.autoIdempotencyKey ?? true,
			rawHttpClient,
			existingRequestInit,
			random,
		})
	})

export const makeCheckfuSdkClient = (
	config: CheckfuClientEnvConfig,
): Effect.Effect<
	CheckfuClientService,
	CheckfuConfigError,
	HttpClient.HttpClient | SecureRandom.SecureRandom
> => makeCheckfuSdkClientInternal(config, true)

const fetchTransportLayer = (
	fetchImpl?: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient | SecureRandom.SecureRandom> => {
	const base = Layer.merge(FetchHttpClient.layer, SecureRandom.layerWebCrypto)
	return fetchImpl === undefined
		? base
		: Layer.provide(base, Layer.succeed(FetchHttpClient.Fetch, fetchImpl))
}

export const makeNormalizedCheckfuClientLayer = (
	config: CheckfuClientConfig & CheckfuClientFetchOptions & { readonly baseUrl: string },
): Layer.Layer<CheckfuClient, CheckfuConfigError> =>
	Layer.effect(CheckfuClient, makeCheckfuSdkClientInternal(config, false)).pipe(
		Layer.provide(fetchTransportLayer(config.fetch)),
	)

export class CheckfuClient extends Context.Service<CheckfuClient, CheckfuClientService>()(
	"@checkfu/sdk/CheckfuClient",
) {
	static readonly layer = (
		config: CheckfuClientConfig,
	): Layer.Layer<
		CheckfuClient,
		CheckfuConfigError,
		HttpClient.HttpClient | SecureRandom.SecureRandom
	> => Layer.effect(CheckfuClient, makeCheckfuSdkClient(config))

	static readonly layerFetch = (
		config: CheckfuClientConfig & CheckfuClientFetchOptions,
	): Layer.Layer<CheckfuClient, CheckfuConfigError> =>
		CheckfuClient.layer(config).pipe(Layer.provide(fetchTransportLayer(config.fetch)))

	static readonly layerFromEnv = (
		overrides?: CheckfuClientEnvConfig,
	): Layer.Layer<
		CheckfuClient,
		CheckfuConfigError,
		HttpClient.HttpClient | SecureRandom.SecureRandom
	> => Layer.effect(CheckfuClient, makeCheckfuSdkClient(overrides ?? {}))

	static readonly layerFetchFromEnv = (
		overrides?: CheckfuClientEnvConfig & CheckfuClientFetchOptions,
	): Layer.Layer<CheckfuClient, CheckfuConfigError> =>
		CheckfuClient.layerFromEnv(overrides).pipe(Layer.provide(fetchTransportLayer(overrides?.fetch)))
}
