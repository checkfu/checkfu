import { makeCheckfuHttpApiClientWith } from "@checkfu/sdk/Api"
import type { CheckfuHttpApiClient, SessionEvent } from "@checkfu/sdk/Api"
import { isAPIError, isApiErrorEnvelope } from "@checkfu/sdk/Errors"
import type { CheckfuSdkError } from "@checkfu/sdk/Errors"
import {
	streamApiSse as sdkStreamApiSse,
	streamSessionEvents as sdkStreamSessionEvents,
} from "@checkfu/sdk/Sse"
import type {
	ApiSseStreamConfig,
	StreamSessionEventsOptions,
	StreamSseOptions,
} from "@checkfu/sdk/Sse"
import {
	DEFAULT_API_URL,
	generateIdempotencyKey as sdkGenerateIdempotencyKey,
	makeAuthorizedHttpClient,
	normalizeApiUrl as sdkNormalizeApiUrl,
} from "@checkfu/sdk/Transport"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { configError, formatApiErrorEnvelope, networkFailure, usageError } from "./Errors.ts"
import type { CliFailure } from "./Errors.ts"
import { COMMAND } from "./Invocation.ts"
import type { SavedConnection } from "./SavedConnection.ts"

export { DEFAULT_API_URL }
export type {
	ApiSseStreamConfig,
	SessionEvent as SessionStreamEvent,
	StreamSessionEventsOptions,
	StreamSseOptions,
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
const VERIFY_MAX_BODY_BYTES = 16 * 1024
const VERIFY_BODY_TIMEOUT_MS = 2000

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
	sdkNormalizeApiUrl(raw).pipe(Effect.mapError((err) => configError(err.message)))

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
			VERIFY_MAX_BODY_BYTES,
			VERIFY_BODY_TIMEOUT_MS,
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

export interface CheckfuClient {
	readonly baseUrl: string
	readonly api: CheckfuHttpApiClient
	readonly streamApiSse: <Event>(
		config: ApiSseStreamConfig<Event>,
	) => Stream.Stream<Event, CliFailure>
	readonly streamSessionEvents: (
		sessionId: string,
		options?: StreamSessionEventsOptions,
	) => Stream.Stream<SessionEvent, CliFailure>
	readonly generateIdempotencyKey: Effect.Effect<string>
}

const mapSdkStreamError = (err: CheckfuSdkError): CliFailure => {
	if (isAPIError(err)) {
		if (isApiErrorEnvelope(err.body)) {
			return formatApiErrorEnvelope(err.body, err.status)
		}
		if (err._tag === "BadRequestError") {
			return usageError(err.message)
		}
		return networkFailure(err.message)
	}
	if (err._tag === "CheckfuConfigError") {
		return configError(err.message)
	}
	return networkFailure(err.message)
}

const streamApiSse = <Event>(config: ApiSseStreamConfig<Event>): Stream.Stream<Event, CliFailure> =>
	sdkStreamApiSse(config).pipe(Stream.mapError(mapSdkStreamError))

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

		const authedHttpClient = makeAuthorizedHttpClient(rawHttpClient, apiKey, {
			existingRequestInit,
			redirectErrorMessage: (status) =>
				`Unexpected HTTP ${status} redirect (redirects are not followed). Check --base-url.`,
		})

		const api = yield* makeCheckfuHttpApiClientWith({
			baseUrl,
			httpClient: authedHttpClient,
		})

		const generateIdempotencyKey = sdkGenerateIdempotencyKey(random, "cli")

		const streamSessionEvents = (
			sessionId: string,
			options?: StreamSessionEventsOptions,
		): Stream.Stream<SessionEvent, CliFailure> =>
			sdkStreamSessionEvents(api, sessionId, options).pipe(Stream.mapError(mapSdkStreamError))

		return {
			baseUrl,
			api,
			streamApiSse,
			streamSessionEvents,
			generateIdempotencyKey,
		}
	})
