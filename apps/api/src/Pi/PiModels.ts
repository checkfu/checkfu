import { envApiKeyAuth } from "@earendil-works/pi-ai"
import type { Model, Provider, StreamOptions } from "@earendil-works/pi-ai"
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

const LOOPBACK_BASE_URL = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})(?:\/[^?#]*)?$/

export const parseLoopbackBaseUrl = (
	raw: string,
	envName: string = OPENAI_BASE_URL_ENV,
): string => {
	const [, host, port] = LOOPBACK_BASE_URL.exec(raw) ?? []
	if (host === undefined || port === undefined || Number(port) > 65_535) {
		throw new TypeError(
			`Refusing ${envName}: only http://127.0.0.1:<port> or http://[::1]:<port> URLs are allowed.`,
		)
	}
	return `http://${host}:${port}${new URL(raw).pathname.replace(/\/+$/, "")}`
}

const resolveOpenAIBaseUrl = (override?: string | null): string =>
	override === undefined || override === null
		? DEFAULT_OPENAI_BASE_URL
		: parseLoopbackBaseUrl(override)

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

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null

export const createNoRedirectProviderFetch =
	(upstreamFetch?: typeof fetch): typeof fetch =>
	async (input, init) => {
		const response = await (upstreamFetch ?? fetch)(input, { ...init, redirect: "manual" })
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel()
			throw new TypeError("Refusing a redirect from the model provider.")
		}
		return response
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

const withProviderFetch = <O extends StreamOptions>(options: O | undefined) => ({
	...options,
	fetch: createNoRedirectProviderFetch(options?.fetch),
})

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
			data.type === "response.completed" &&
			"response" in data &&
			isObject(data.response) &&
			"output" in data.response &&
			Array.isArray(data.response.output)
		) {
			refusals.push(...data.response.output.flatMap(refusalTexts))
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
			apiKey: envApiKeyAuth("OpenAI API key", [PROVIDER_API_KEY_ENV.openai]),
		},
		models,
		api: {
			stream: (model: Model<"openai-responses">, context, options) =>
				reportOpenAIRefusals(options, (onProviderStreamEvent) =>
					openAIResponses.stream(model, context, {
						...withProviderFetch(options),
						onProviderStreamEvent,
					}),
				),
			streamSimple: (model: Model<"openai-responses">, context, options) =>
				reportOpenAIRefusals(options, (onProviderStreamEvent) =>
					openAIResponses.streamSimple(model, context, {
						...withProviderFetch(options),
						onProviderStreamEvent,
					}),
				),
		},
	})
}

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
			apiKey: envApiKeyAuth("Anthropic API key", [PROVIDER_API_KEY_ENV.anthropic]),
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: {
			stream: (model: Model<"anthropic-messages">, context, options) =>
				withoutRefusalExplanation(
					anthropicMessages.stream(model, context, withProviderFetch(options)),
				),
			streamSimple: (model: Model<"anthropic-messages">, context, options) =>
				withoutRefusalExplanation(
					anthropicMessages.streamSimple(model, context, withProviderFetch(options)),
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
