import type { Api, Model, Provider, StreamOptions } from "@earendil-works/pi-ai"
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages"
import * as openAIResponses from "@earendil-works/pi-ai/api/openai-responses"
import { createModels, createProvider } from "@earendil-works/pi-ai/models"
import type { MutableModels } from "@earendil-works/pi-ai/models"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { AlchemyContext } from "alchemy/AlchemyContext"
import * as Output from "alchemy/Output"
import { CurrentRuntimeContext } from "alchemy/RuntimeContext"
import { Stage } from "alchemy/Stage"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { optionalSecret } from "../Secrets.ts"
import { PROVIDER_API_KEY_ENV } from "./PiCatalog.ts"
import { isRefusalAssistantMessage } from "./PiRefusals.ts"

export const OPENAI_BASE_URL_ENV = "CHECKFU_OPENAI_BASE_URL"
export const LOCAL_DEV_SIGNAL_ENV = "CHECKFU_LOCAL_DEV"
export const LOCAL_DEV_SIGNAL_VALUE = "local-dev"
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"

export const providerApiKeys = Config.all({
	openai: optionalSecret(PROVIDER_API_KEY_ENV.openai),
	anthropic: optionalSecret(PROVIDER_API_KEY_ENV.anthropic),
}).pipe(Effect.orDie)

export interface ProviderBaseUrlOverrides {
	readonly openai?: string | null
}

const optionalConfigString = (name: string): Config.Config<string | null> =>
	Config.option(Config.String(name)).pipe(
		Config.map((value) =>
			value.pipe(
				Option.map((raw) => raw.trim()),
				Option.filter((trimmed) => trimmed.length > 0),
				Option.getOrNull,
			),
		),
	)

const EXPLICIT_LOOPBACK_PORT = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):(\d+)(?:\/|$)/i

export const parseLoopbackBaseUrl = (
	raw: string,
	envName: string = OPENAI_BASE_URL_ENV,
): string => {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		throw new TypeError(`Invalid ${envName}: must be a valid URL.`)
	}
	const portMatch = EXPLICIT_LOOPBACK_PORT.exec(raw)
	const portNumber = portMatch?.[1] === undefined ? Number.NaN : Number(portMatch[1])
	const isLoopbackHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"
	if (
		parsed.protocol !== "http:" ||
		!isLoopbackHost ||
		!Number.isInteger(portNumber) ||
		portNumber < 1 ||
		portNumber > 65_535 ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0 ||
		raw.includes("?") ||
		raw.includes("#")
	) {
		throw new TypeError(
			`Refusing non-loopback ${envName}: only http://127.0.0.1:<port> or http://[::1]:<port> URLs are allowed.`,
		)
	}
	const pathname = parsed.pathname.replace(/\/+$/, "")
	return `${parsed.protocol}//${parsed.hostname}:${portNumber}${pathname}`
}

const resolveOpenAIBaseUrl = (override?: string | null): string =>
	override === undefined || override === null
		? DEFAULT_OPENAI_BASE_URL
		: parseLoopbackBaseUrl(override)

/**
 * Reads a base-URL override that only local development may set: it must be a
 * loopback URL, and it is ignored by production stages and by deployed plans.
 */
export const localDevBaseUrl = (envName: string) =>
	Effect.gen(function* () {
		const alchemyContext = yield* Effect.serviceOption(AlchemyContext)
		if (Option.isSome(alchemyContext)) {
			if (!alchemyContext.value.dev) {
				return null
			}
			const stage = yield* Effect.serviceOption(Stage)
			if (Option.isSome(stage) && stage.value === "production") {
				return null
			}
			const raw = yield* optionalConfigString(envName)
			if (raw === null) {
				return null
			}
			const baseUrl = parseLoopbackBaseUrl(raw, envName)
			const runtimeContext = yield* CurrentRuntimeContext
			yield* (
				runtimeContext?.set(LOCAL_DEV_SIGNAL_ENV, Output.literal(LOCAL_DEV_SIGNAL_VALUE)) ??
				Effect.void
			)
			return baseUrl
		}
		const runtimeStage = yield* optionalConfigString("ALCHEMY_STAGE")
		if (runtimeStage === "production") {
			return null
		}
		const localDevSignal = yield* optionalConfigString(LOCAL_DEV_SIGNAL_ENV)
		if (localDevSignal !== LOCAL_DEV_SIGNAL_VALUE) {
			return null
		}
		const raw = yield* optionalConfigString(envName)
		return raw === null ? null : parseLoopbackBaseUrl(raw, envName)
	}).pipe(Effect.orDie)

export const providerBaseUrls = Effect.map(localDevBaseUrl(OPENAI_BASE_URL_ENV), (openai) => ({
	openai,
}))

const staticEnvApiKeyAuth = (name: string, envVar: string) => ({
	name,
	login: () => Promise.reject(new Error(`Interactive login is not supported for ${name}.`)),
	resolve: async ({
		ctx,
		signal,
	}: {
		readonly ctx: { readonly env: (key: string) => Promise<string | undefined> }
		readonly signal: AbortSignal
	}) => {
		signal.throwIfAborted()
		const apiKey = await ctx.env(envVar)
		signal.throwIfAborted()
		if (apiKey !== undefined && apiKey.length > 0) {
			return { auth: { apiKey }, source: envVar }
		}
		return undefined
	},
})

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null

const readNativeUrlHref = (input: unknown): string | null => {
	const descriptor = Object.getOwnPropertyDescriptor(URL.prototype, "href")
	if (descriptor?.get === undefined) {
		return null
	}
	try {
		const href: unknown = descriptor.get.call(input)
		return typeof href === "string" ? href : null
	} catch {
		return null
	}
}

const isRedirectStatus = (status: number): boolean => status >= 300 && status < 400

const discardResponseBody = (body: Response["body"]): void => {
	if (body === null) {
		return
	}
	void body.cancel().catch(() => undefined)
}

/**
 * Wraps provider `fetch` calls so outbound requests stay pinned to the
 * resolved provider origin and refuse HTTP redirects at the transport.
 * Prevents a redirect from sending transcripts or API keys to another host.
 *
 * Only URL strings and native `URL` instances are accepted. The validated
 * destination is dispatched as an immutable normalized URL string (`parsed.href`)
 * with `{ ...init, redirect: "manual" }`, leaving the underlying `fetch`
 * transport as the sole owner of headers, bodies, routing options (`dispatcher`,
 * `proxy`, `keepalive`), and stream lifetimes. `Request` objects (native or
 * custom) are rejected fail-closed with a `TypeError`.
 */
export const createNoRedirectProviderFetch = (
	expectedBaseUrl: string,
	upstreamFetch?: typeof fetch,
): typeof fetch => {
	const expectedOrigin = new URL(expectedBaseUrl).origin
	const guardedFetch = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		let rawUrl: string
		if (typeof input === "string") {
			rawUrl = input
		} else {
			const nativeHref = readNativeUrlHref(input)
			if (nativeHref === null) {
				throw new TypeError(
					"Refusing provider request: only URL strings and URL instances are supported.",
				)
			}
			rawUrl = nativeHref
		}
		let parsed: URL
		try {
			parsed = new URL(rawUrl)
		} catch {
			throw new TypeError(`Refusing provider request to invalid URL: ${rawUrl}`)
		}
		if (parsed.origin !== expectedOrigin) {
			throw new TypeError(
				`Refusing provider request to disallowed origin ${parsed.origin}; expected ${expectedOrigin}.`,
			)
		}
		const baseFetch = upstreamFetch ?? globalThis.fetch
		// Cloudflare workerd throws a TypeError on `redirect: "error"` before
		// dispatching the request; use `redirect: "manual"` and reject 3xx
		// responses below so redirects are never followed.
		const requestInit: RequestInit =
			init === undefined ? { redirect: "manual" } : { ...init, redirect: "manual" }
		const response = await baseFetch(parsed.href, requestInit)
		if (
			response.redirected ||
			response.type === "opaqueredirect" ||
			isRedirectStatus(response.status)
		) {
			discardResponseBody(response.body)
			throw new TypeError(
				`Provider request to ${parsed.origin} attempted a redirect, which is not allowed.`,
			)
		}
		return response
	}
	return guardedFetch
}

export const OPENAI_REFUSAL_ERROR = "The model refused to complete the request."

const refusalTexts = (item: unknown): ReadonlyArray<string> => {
	if (
		!isObject(item) ||
		!("type" in item) ||
		item.type !== "message" ||
		!("content" in item) ||
		!Array.isArray(item.content)
	) {
		return []
	}
	const texts: Array<string> = []
	for (const part of item.content) {
		if (isObject(part) && "type" in part && part.type === "refusal") {
			texts.push("refusal" in part && typeof part.refusal === "string" ? part.refusal : "")
		}
	}
	return texts
}

const withProviderFetch = <O extends StreamOptions>(model: Model<Api>, options: O | undefined) => ({
	...options,
	fetch: createNoRedirectProviderFetch(model.baseUrl, options?.fetch),
})

/**
 * pi-ai folds an OpenAI `refusal` part into the reply's text and stops with
 * "stop". Report such a reply as a refusal that carries only the refusal's text.
 */
const reportOpenAIRefusals = (
	options: StreamOptions | undefined,
	start: (
		onProviderStreamEvent: NonNullable<StreamOptions["onProviderStreamEvent"]>,
	) => ReturnType<typeof createAssistantMessageEventStream>,
) => {
	const refusals: Array<string> = []
	const inner = start(async (data, model) => {
		if (
			isObject(data) &&
			"type" in data &&
			data.type === "response.output_item.done" &&
			"item" in data
		) {
			refusals.push(...refusalTexts(data.item))
		}
		await options?.onProviderStreamEvent?.(data, model)
	})
	const outer = createAssistantMessageEventStream()
	void (async () => {
		try {
			for await (const event of inner) {
				if (event.type === "done" && refusals.length > 0 && event.message.stopReason === "stop") {
					const text = refusals.join("")
					outer.push({
						type: "error",
						reason: "error",
						error: {
							...event.message,
							content: text.length > 0 ? [{ type: "text", text }] : [],
							stopReason: "error",
							rawStopReason: "refusal",
							errorMessage: OPENAI_REFUSAL_ERROR,
						},
					})
				} else {
					outer.push(event)
				}
			}
		} finally {
			outer.end()
		}
	})()
	return outer
}

/**
 * Eager OpenAI + Anthropic providers for Cloudflare workerd and Bun/Node.
 * Wire codecs are imported statically (never `.lazy.js`) so an evicted or
 * aborted Durable Object request can never leave a dynamic import pending
 * across the isolate.
 */
export const createOpenAIProvider = (baseUrl?: string | null): Provider<"openai-responses"> => {
	const resolvedBaseUrl = resolveOpenAIBaseUrl(baseUrl)
	const models =
		resolvedBaseUrl === DEFAULT_OPENAI_BASE_URL
			? Object.values(OPENAI_MODELS)
			: Object.values(OPENAI_MODELS).map((model) => ({ ...model, baseUrl: resolvedBaseUrl }))
	return createProvider({
		id: "openai",
		name: "OpenAI",
		baseUrl: resolvedBaseUrl,
		auth: {
			apiKey: staticEnvApiKeyAuth("OpenAI API key", PROVIDER_API_KEY_ENV.openai),
		},
		models,
		api: {
			stream: (model: Model<"openai-responses">, context, options) =>
				reportOpenAIRefusals(options, (onProviderStreamEvent) =>
					openAIResponses.stream(model, context, {
						...withProviderFetch(model, options),
						onProviderStreamEvent,
					}),
				),
			streamSimple: (model: Model<"openai-responses">, context, options) =>
				reportOpenAIRefusals(options, (onProviderStreamEvent) =>
					openAIResponses.streamSimple(model, context, {
						...withProviderFetch(model, options),
						onProviderStreamEvent,
					}),
				),
		},
	})
}

// Anthropic may explain a refusal in free text. Pi keeps a failed compaction's error in its record
// and matches it against its retryable errors, so a refusal carries the codec's own text for a
// refusal without an explanation instead. A sensitive stop keeps its own text.
const ANTHROPIC_REFUSAL_ERROR = "The model refused to complete the request"

const withoutRefusalExplanation = (
	inner: ReturnType<typeof anthropicMessages.stream>,
): ReturnType<typeof anthropicMessages.stream> => {
	const outer = createAssistantMessageEventStream()
	void (async () => {
		try {
			for await (const event of inner) {
				outer.push(
					event.type === "error" &&
						isRefusalAssistantMessage(event.error) &&
						event.error.rawStopReason !== "sensitive"
						? { ...event, error: { ...event.error, errorMessage: ANTHROPIC_REFUSAL_ERROR } }
						: event,
				)
			}
		} finally {
			outer.end()
		}
	})()
	return outer
}

export const createAnthropicProvider = (): Provider<"anthropic-messages"> =>
	createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
		auth: {
			apiKey: staticEnvApiKeyAuth("Anthropic API key", PROVIDER_API_KEY_ENV.anthropic),
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: {
			stream: (model: Model<"anthropic-messages">, context, options) =>
				withoutRefusalExplanation(
					anthropicMessages.stream(model, context, withProviderFetch(model, options)),
				),
			streamSimple: (model: Model<"anthropic-messages">, context, options) =>
				withoutRefusalExplanation(
					anthropicMessages.streamSimple(model, context, withProviderFetch(model, options)),
				),
		},
	})

export const createPiModels = (
	apiKeys: Effect.Success<typeof providerApiKeys>,
	baseUrls?: ProviderBaseUrlOverrides,
): MutableModels => {
	const models = createModels({
		authContext: {
			env: (name) => {
				if (name === PROVIDER_API_KEY_ENV.openai) {
					return Promise.resolve(
						apiKeys.openai === null ? undefined : Redacted.value(apiKeys.openai),
					)
				}
				if (name === PROVIDER_API_KEY_ENV.anthropic) {
					return Promise.resolve(
						apiKeys.anthropic === null ? undefined : Redacted.value(apiKeys.anthropic),
					)
				}
				return Promise.resolve(undefined)
			},
			fileExists: () => Promise.resolve(false),
		},
	})
	models.setProvider(createOpenAIProvider(baseUrls?.openai))
	models.setProvider(createAnthropicProvider())
	return models
}
