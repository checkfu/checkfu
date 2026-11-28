import { EffectArtifactsWithContent } from "./ArtifactContent.ts"
import type { MemorySnapshot, MemoryStoreSnapshot } from "./Schemas.ts"
import * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import { isPendingResource, makeCheckfuHttpApiClientWith } from "./Api.ts"
import { EffectFiles } from "./FileTransfer.ts"
import type {
	Agent,
	Artifact,
	ArtifactVersion,
	Automation,
	CheckfuHttpApiClient,
	Environment,
	PendingResource,
	PendingResourceType,
	Session,
	Vault,
	VaultCredential,
	WebhookCreated,
} from "./Api.ts"
import { CheckfuConfigError, ConflictError, NotFoundError } from "./Errors.ts"
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
	resolveDefaultHeaders,
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
	/**
	 * Headers applied to each request. Set Idempotency-Key to null to disable automatic keys.
	 * Pass idempotencyKey in the options for an individual request.
	 */
	readonly defaultHeaders?: HeaderMap | undefined
	readonly autoIdempotencyKey?: boolean | undefined
}

export interface CheckfuClientEnvConfig {
	readonly apiKey?: string | Redacted.Redacted<string> | undefined
	readonly baseUrl?: string | undefined
	readonly allowInsecureHttp?: boolean | undefined
	readonly maxRetries?: number | undefined
	readonly timeout?: Duration.Input | null | undefined
	/**
	 * Headers applied to each request. Set Idempotency-Key to null to disable automatic keys.
	 * Pass idempotencyKey in the options for an individual request.
	 */
	readonly defaultHeaders?: HeaderMap | undefined
	readonly autoIdempotencyKey?: boolean | undefined
}

export interface CheckfuClientFetchOptions {
	readonly fetch?: typeof globalThis.fetch | undefined
}

export type PendingOf<K extends PendingResourceType> = PendingResource & { readonly type: K }

export interface WaitForPendingMethod {
	<K extends PendingResourceType>(
		result: PendingResolved[K] | PendingOf<K>,
		options?: WaitForPendingOptions<PendingResolved[K]>,
	): Effect.Effect<PendingResolved[K], CheckfuSdkError>
}

export interface PendingResolved {
	readonly agent: Agent
	readonly environment: Environment
	readonly session: Session
	readonly automation: Automation
	readonly artifact: Artifact
	readonly artifact_version: ArtifactVersion
	readonly vault: Vault
	readonly vault_credential: VaultCredential
	readonly webhook: WebhookCreated
	readonly memory_store: MemoryStoreSnapshot
	readonly memory: MemorySnapshot
}

export type PendingResolvedResource = PendingResolved[PendingResourceType]

const retrievePending = (
	client: CheckfuSdkClient,
	pending: PendingResource,
	options: RequestOptions<never> | undefined,
): Effect.Effect<PendingResolvedResource, CheckfuSdkError> => {
	switch (pending.type) {
		case "agent":
			return client.agents.retrieve(pending.id, options)
		case "environment":
			return client.environments.retrieve(pending.id, options)
		case "session":
			return client.sessions.retrieve(pending.id, options)
		case "automation":
			return client.automations.retrieve(pending.id, options)
		case "artifact":
			return client.artifacts.retrieve(pending.id, options)
		case "artifact_version":
			return Number.isInteger(pending.version) && pending.version >= 1
				? client.artifacts.versions.retrieve(pending.id, pending.version, options)
				: Effect.fail(
						new CheckfuConfigError({
							message: `waitForPending for pending artifact_version "${pending.id}" needs the version it committed.`,
						}),
					)
		case "vault":
			return client.vaults.retrieve(pending.id, options)
		case "vault_credential":
			return client.vaults.credentials.retrieve(pending.vault_id, pending.id, options)
		case "webhook":
			return Effect.gen(function* () {
				const page = yield* client.webhooks.list({ id: pending.id, limit: 1 }, options)
				const found = page.data.find((item) => item.id === pending.id)
				if (found === undefined) {
					return yield* new NotFoundError({
						status: 404,
						errorType: "not_found_error",
						message: `Webhook "${pending.id}" is not yet listed.`,
					})
				}
				if (found.secret_revision !== 1) {
					return yield* new ConflictError({
						status: 409,
						errorType: "conflict_error",
						message: `Webhook "${pending.id}" has already rotated its signing secret (revision ${found.secret_revision}); the pending creation receipt's signing_secret is no longer current.`,
					})
				}
				return { ...found, signing_secret: pending.signing_secret }
			})
		case "memory_store":
			return client.memoryStores.retrieve(pending.id, options)
		case "memory":
			return client.memoryStores.memories.retrieve(pending.memory_store_id, pending.id, options)
		default: {
			const unknown: { readonly type: unknown } = pending
			return Effect.fail(
				new CheckfuConfigError({
					message: `waitForPending cannot wait for a pending ${String(unknown.type)}.`,
				}),
			)
		}
	}
}

export const waitForPendingResource = (
	client: CheckfuSdkClient,
	pending: PendingResource,
	options?: WaitForPendingOptions<PendingResolvedResource>,
): Effect.Effect<PendingResolvedResource, CheckfuSdkError> =>
	pollPending(
		pending,
		(_id, requestOptions) => retrievePending(client, pending, requestOptions),
		options,
	)

export const INTERNAL_EFFECT_RUNTIME = Symbol.for("@checkfu/sdk/EffectSdkRuntime")

export class CheckfuSdkClient extends EffectResources {
	override readonly artifacts: EffectArtifactsWithContent
	/** Generated file methods plus hand-written `upload` and `content` (see FileTransfer.ts). */
	override readonly files: EffectFiles
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
		this.files = new EffectFiles(runtime)
		this.artifacts = new EffectArtifactsWithContent(runtime)
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

	waitForPending<K extends PendingResourceType>(
		result: PendingResolved[K] | PendingOf<K>,
		options?: WaitForPendingOptions<PendingResolved[K]>,
	): Effect.Effect<PendingResolved[K], CheckfuSdkError>
	waitForPending(
		result: PendingResolvedResource | PendingResource,
		options?: WaitForPendingOptions<PendingResolvedResource>,
	): Effect.Effect<PendingResolvedResource, CheckfuSdkError> {
		return isPendingResource(result)
			? waitForPendingResource(this, result, options)
			: Effect.succeed(result)
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
}): Effect.Effect<CheckfuClientService, CheckfuConfigError> =>
	Effect.gen(function* () {
		const defaultHeaders = yield* Effect.fromResult(resolveDefaultHeaders(params.defaultHeaders))
		const authedHttpClient = makeAuthorizedHttpClient(params.rawHttpClient, params.apiKey, {
			defaultHeaders,
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
			defaultHeaders,
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
				const nextHeaders = mergeHeaderMaps(defaultHeaders, overrides.defaultHeaders)
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
