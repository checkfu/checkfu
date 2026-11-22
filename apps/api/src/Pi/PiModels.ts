import type { Api, Model, Provider, StreamFunction, StreamOptions } from "@earendil-works/pi-ai"
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages"
import * as openAIResponses from "@earendil-works/pi-ai/api/openai-responses"
import { type MutableModels, createModels, createProvider } from "@earendil-works/pi-ai/models"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { Stage } from "alchemy/Stage"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { optionalSecret } from "../Secrets.ts"
import { isRefusalAssistantMessage } from "./PiRefusals.ts"

export const SUPPORTED_PROVIDERS = ["openai", "anthropic"] as const
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

export const PROVIDER_API_KEY_ENV: Readonly<Record<SupportedProvider, string>> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
}

export const OPENAI_BASE_URL_ENV = "CHECKFU_OPENAI_BASE_URL"
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"

export const providerApiKeys = Effect.all({
	openai: optionalSecret(PROVIDER_API_KEY_ENV.openai),
	anthropic: optionalSecret(PROVIDER_API_KEY_ENV.anthropic),
})

export interface ProviderBaseUrlOverrides {
	readonly openai?: string | null
}

const optionalConfigString = (name: string) =>
	Config.option(Config.String(name)).pipe(
		Effect.map(Option.map((value) => value.trim())),
		Effect.map(Option.filter((value) => value.length > 0)),
		Effect.map(Option.getOrNull),
		Effect.orDie,
	)

const EXPLICIT_LOOPBACK_PORT = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):(\d+)(?:\/|$)/i

export const parseLoopbackBaseUrl = (raw: string): string => {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		throw new TypeError(`Invalid ${OPENAI_BASE_URL_ENV}: must be a valid URL.`)
	}
	const portMatch = EXPLICIT_LOOPBACK_PORT.exec(raw)
	const portNumber = portMatch?.[1] === undefined ? Number.NaN : Number(portMatch[1])
	const isLoopbackHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"
	if (
		parsed.protocol !== "http:" ||
		!isLoopbackHost ||
		!Number.isInteger(portNumber) ||
		portNumber < 1 ||
		portNumber > 65535 ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0 ||
		raw.includes("?") ||
		raw.includes("#")
	) {
		throw new TypeError(
			`Refusing non-loopback ${OPENAI_BASE_URL_ENV}: only http://127.0.0.1:<port> or http://[::1]:<port> URLs are allowed.`,
		)
	}
	const pathname = parsed.pathname.replace(/\/+$/, "")
	return `${parsed.protocol}//${parsed.hostname}:${portNumber}${pathname}`
}

const resolveOpenAIBaseUrl = (override?: string | null): string =>
	override === undefined || override === null
		? DEFAULT_OPENAI_BASE_URL
		: parseLoopbackBaseUrl(override)

export const providerBaseUrls = Effect.gen(function* () {
	const alchemyContext = yield* Effect.serviceOption(AlchemyContext)
	if (Option.isSome(alchemyContext)) {
		if (!alchemyContext.value.dev) return { openai: null }
		const stage = yield* Effect.serviceOption(Stage)
		if (Option.isSome(stage) && stage.value === "production") return { openai: null }
	} else {
		const runtimeStage = yield* optionalConfigString("ALCHEMY_STAGE")
		if (runtimeStage === "production") return { openai: null }
	}
	const rawOpenAI = yield* optionalConfigString(OPENAI_BASE_URL_ENV)
	return {
		openai: rawOpenAI === null ? null : parseLoopbackBaseUrl(rawOpenAI),
	}
})

const isSupportedProvider = (value: string): value is SupportedProvider =>
	value === "openai" || value === "anthropic"

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

const requestUrlString = (input: Parameters<typeof fetch>[0]): string =>
	typeof input === "string" ? input : input instanceof URL ? input.href : input.url

const isRedirectStatus = (status: number): boolean => status >= 300 && status < 400

/**
 * Wraps provider `fetch` calls so outbound requests stay pinned to the
 * resolved provider origin and refuse HTTP redirects at the transport.
 * Prevents a redirect from an allowed provider host from sending transcripts
 * or API keys to a host excluded by a limited environment's `allowed_hosts`.
 */
export const createNoRedirectProviderFetch = (
	expectedBaseUrl: string,
	upstreamFetch?: typeof fetch,
): typeof fetch => {
	const expectedOrigin = new URL(expectedBaseUrl).origin
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const rawUrl = requestUrlString(input)
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
		const requestInit: RequestInit = { ...init, redirect: "manual" }
		const response = await baseFetch(input, requestInit)
		if (
			response.redirected ||
			response.type === "opaqueredirect" ||
			isRedirectStatus(response.status)
		) {
			void response.body?.cancel().catch(() => undefined)
			throw new TypeError(
				`Provider request to ${parsed.origin} attempted a redirect, which is not allowed.`,
			)
		}
		return response
	}) as typeof fetch
}

const OPENAI_INCOMPLETE_CONTENT_FILTER_ERROR = "Response incomplete: content_filter"
const OPENAI_REFUSAL_ERROR = "The model refused to complete the request."
const ANTHROPIC_DEFAULT_REFUSAL_ERROR = "The model refused to complete the request"
const ANTHROPIC_SENSITIVE_ERROR = "Provider stopped with: sensitive"

const extractMessageRefusalTexts = (item: unknown): ReadonlyArray<string> => {
	if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) return []
	const texts: Array<string> = []
	for (const part of item.content) {
		if (isRecord(part) && part.type === "refusal") {
			texts.push(typeof part.refusal === "string" ? part.refusal : "")
		}
	}
	return texts
}

const completedResponseRefusalTexts = (response: unknown): ReadonlyArray<string> | null => {
	if (!isRecord(response) || response.status !== "completed") return []
	if (!Array.isArray(response.output)) return null
	return response.output.flatMap(extractMessageRefusalTexts)
}

const isIncompleteContentFilterResponse = (response: unknown): boolean =>
	isRecord(response) &&
	response.status === "incomplete" &&
	isRecord(response.incomplete_details) &&
	response.incomplete_details.reason === "content_filter"

const expectedAnthropicRefusalMessage = (delta: Record<string, unknown>): string | null => {
	if (delta.stop_reason === "refusal") {
		const explanation = isRecord(delta.stop_details) ? delta.stop_details.explanation : undefined
		return typeof explanation === "string" && explanation.length > 0
			? explanation
			: ANTHROPIC_DEFAULT_REFUSAL_ERROR
	}
	if (delta.stop_reason === "sensitive") {
		return ANTHROPIC_SENSITIVE_ERROR
	}
	return null
}

/**
 * `@earendil-works/pi-ai` folds completed OpenAI Responses `refusal` parts into
 * text blocks with `stopReason: "stop"` and `rawStopReason: "completed"`, and
 * maps `response.incomplete` (`content_filter`) to an error event with
 * `errorMessage: "Response incomplete: content_filter"`.
 * Preserve `rawStopReason` only for confirmed refusals; if the SDK throws on a
 * later SSE `error` event (before `onProviderStreamEvent` runs), abort, or
 * transport failure, strip `rawStopReason` so stream failures stay errors.
 */
const wrapOpenAIResponsesStream =
	<TOptions extends StreamOptions>(
		fn: StreamFunction<"openai-responses", TOptions>,
	): StreamFunction<"openai-responses", TOptions> =>
	(model, context, options) => {
		let completedRefusalTexts: Array<string> = []
		let completedWithRefusal = false
		let finalRefusalTexts: ReadonlyArray<string> = []
		let sawIncompleteContentFilter = false
		let sawStreamError = false
		const upstreamOnEvent = options?.onProviderStreamEvent
		const wrappedOptions = {
			...options,
			fetch: createNoRedirectProviderFetch(model.baseUrl, options?.fetch),
			onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
				if (isRecord(data)) {
					if (data.type === "response.output_item.done") {
						const texts = extractMessageRefusalTexts(data.item)
						if (texts.length > 0) {
							completedRefusalTexts = [...completedRefusalTexts, ...texts]
						}
					} else if (data.type === "response.completed") {
						const texts = completedResponseRefusalTexts(data.response)
						finalRefusalTexts = texts ?? completedRefusalTexts
						completedWithRefusal = finalRefusalTexts.length > 0
						sawIncompleteContentFilter = false
					} else if (data.type === "response.incomplete") {
						sawIncompleteContentFilter = isIncompleteContentFilterResponse(data.response)
					} else if (data.type === "error") {
						sawStreamError = true
					}
				}
				await upstreamOnEvent?.(data, eventModel)
			},
		} as TOptions

		const inner = fn(model, context, wrappedOptions)
		const outer = createAssistantMessageEventStream()
		void (async () => {
			try {
				for await (const event of inner) {
					if (
						event.type === "done" &&
						completedWithRefusal &&
						event.message.stopReason === "stop"
					) {
						// Emit completed OpenAI refusals as error-stopped messages with `rawStopReason: "refusal"`
						// carrying only the explicit `refusal` part text (discarding any mixed output_text/thinking).
						// GenerationTask's `afterResponse` hook normalizes them into published refusal turns,
						// while CompactionTask (`completeSimple`) rejects them so a refusal never overwrites history.
						const refusalText = finalRefusalTexts.filter((text) => text.length > 0).join("")
						outer.push({
							type: "error",
							reason: "error",
							error: {
								...event.message,
								content: refusalText.length > 0 ? [{ type: "text", text: refusalText }] : [],
								stopReason: "error",
								rawStopReason: "refusal",
								errorMessage: OPENAI_REFUSAL_ERROR,
							},
						})
					} else if (event.type === "done" && isRefusalAssistantMessage(event.message)) {
						const { rawStopReason: _dropped, ...rest } = event.message
						outer.push({ ...event, message: rest })
					} else if (event.type === "error" && isRefusalAssistantMessage(event.error)) {
						const isConfirmedIncompleteRefusal =
							event.reason === "error" &&
							event.error.stopReason === "error" &&
							sawIncompleteContentFilter &&
							!sawStreamError &&
							event.error.rawStopReason === "incomplete.content_filter" &&
							event.error.errorMessage === OPENAI_INCOMPLETE_CONTENT_FILTER_ERROR
						if (isConfirmedIncompleteRefusal) {
							outer.push(event)
						} else {
							const { rawStopReason: _dropped, ...rest } = event.error
							outer.push({ ...event, error: rest })
						}
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
 * `@earendil-works/pi-ai` records `rawStopReason` on `message_delta` before the
 * stream finishes. If Anthropic emits a stream error (before or after
 * `message_stop` — where the SDK decoder throws before `onProviderStreamEvent`
 * runs) or disconnects after a `refusal`/`sensitive` delta, `pi-ai` retains
 * `rawStopReason` while overwriting `errorMessage` with the stream failure.
 * Clear `rawStopReason` unless `message_stop` completed cleanly with the codec's
 * expected refusal error message.
 */
const wrapAnthropicMessagesStream =
	<TOptions extends StreamOptions>(
		fn: StreamFunction<"anthropic-messages", TOptions>,
	): StreamFunction<"anthropic-messages", TOptions> =>
	(model, context, options) => {
		let sawMessageStop = false
		let sawStreamError = false
		let expectedRefusalErrorMessage: string | null = null
		const upstreamOnEvent = options?.onProviderStreamEvent
		const wrappedOptions = {
			...options,
			fetch: createNoRedirectProviderFetch(model.baseUrl, options?.fetch),
			onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
				if (isRecord(data)) {
					if (data.type === "message_delta" && isRecord(data.delta)) {
						if (typeof data.delta.stop_reason === "string") {
							expectedRefusalErrorMessage = expectedAnthropicRefusalMessage(data.delta)
						}
					} else if (data.type === "message_stop") {
						sawMessageStop = true
					} else if (data.type === "error") {
						sawStreamError = true
					}
				}
				await upstreamOnEvent?.(data, eventModel)
			},
		} as TOptions

		const inner = fn(model, context, wrappedOptions)
		const outer = createAssistantMessageEventStream()
		void (async () => {
			try {
				for await (const event of inner) {
					if (event.type === "error" && isRefusalAssistantMessage(event.error)) {
						const isConfirmedRefusal =
							event.reason === "error" &&
							event.error.stopReason === "error" &&
							sawMessageStop &&
							!sawStreamError &&
							expectedRefusalErrorMessage !== null &&
							event.error.errorMessage === expectedRefusalErrorMessage
						if (isConfirmedRefusal) {
							outer.push(event)
						} else {
							const { rawStopReason: _dropped, ...rest } = event.error
							outer.push({ ...event, error: rest })
						}
					} else if (event.type === "done" && isRefusalAssistantMessage(event.message)) {
						const { rawStopReason: _dropped, ...rest } = event.message
						outer.push({ ...event, message: rest })
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
			stream: wrapOpenAIResponsesStream(openAIResponses.stream),
			streamSimple: wrapOpenAIResponsesStream(openAIResponses.streamSimple),
		},
	})
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
			stream: wrapAnthropicMessagesStream(anthropicMessages.stream),
			streamSimple: wrapAnthropicMessagesStream(anthropicMessages.streamSimple),
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

export const resolveCatalogModel = (
	catalog: MutableModels,
	requestedModelId: string,
): { readonly provider: SupportedProvider; readonly model: Model<Api> } | null => {
	const slashIndex = requestedModelId.indexOf("/")
	if (slashIndex > 0) {
		const provider = requestedModelId.slice(0, slashIndex)
		const modelId = requestedModelId.slice(slashIndex + 1)
		if (isSupportedProvider(provider) && modelId.length > 0) {
			const model = catalog.getModel(provider, modelId)
			if (model !== undefined) {
				return { provider, model }
			}
		}
		return null
	}
	for (const provider of SUPPORTED_PROVIDERS) {
		const model = catalog.getModel(provider, requestedModelId)
		if (model !== undefined) {
			return { provider, model }
		}
	}
	return null
}
