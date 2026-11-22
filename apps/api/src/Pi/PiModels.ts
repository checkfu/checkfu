import type { Api, Model, Provider, StreamFunction, StreamOptions } from "@earendil-works/pi-ai"
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages"
import * as openAIResponses from "@earendil-works/pi-ai/api/openai-responses"
import { type MutableModels, createModels, createProvider } from "@earendil-works/pi-ai/models"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"

import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { optionalSecret } from "../Secrets.ts"

export const SUPPORTED_PROVIDERS = ["openai", "anthropic"] as const
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

export const PROVIDER_API_KEY_ENV: Readonly<Record<SupportedProvider, string>> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
}

export const providerApiKeys = Effect.all({
	openai: optionalSecret(PROVIDER_API_KEY_ENV.openai),
	anthropic: optionalSecret(PROVIDER_API_KEY_ENV.anthropic),
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

const messageItemHasRefusal = (item: unknown): boolean =>
	isRecord(item) &&
	item.type === "message" &&
	Array.isArray(item.content) &&
	item.content.some((part) => isRecord(part) && part.type === "refusal")

const completedResponseHasRefusal = (response: unknown): boolean | null => {
	if (!isRecord(response) || response.status !== "completed") return false
	if (!Array.isArray(response.output)) return null
	return response.output.some(messageItemHasRefusal)
}

/**
 * `@earendil-works/pi-ai` folds completed OpenAI Responses `refusal` parts into
 * text blocks with `stopReason: "stop"` and `rawStopReason: "completed"`.
 * Observe the raw provider stream events so completed refusals preserve
 * `rawStopReason: "refusal"`, while partial/errored streams remain errors.
 */
const wrapOpenAIResponsesStream =
	<TOptions extends StreamOptions>(
		fn: StreamFunction<"openai-responses", TOptions>,
	): StreamFunction<"openai-responses", TOptions> =>
	(model, context, options) => {
		let sawCompletedRefusalItem = false
		let completedWithRefusal = false
		const upstreamOnEvent = options?.onProviderStreamEvent
		const wrappedOptions = {
			...options,
			onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
				if (isRecord(data)) {
					if (data.type === "response.output_item.done" && messageItemHasRefusal(data.item)) {
						sawCompletedRefusalItem = true
					} else if (data.type === "response.completed") {
						const hasRefusal = completedResponseHasRefusal(data.response)
						completedWithRefusal = hasRefusal ?? sawCompletedRefusalItem
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
						outer.push({
							...event,
							message: { ...event.message, rawStopReason: "refusal" },
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
export const createOpenAIProvider = (): Provider<"openai-responses"> =>
	createProvider({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		auth: {
			apiKey: staticEnvApiKeyAuth("OpenAI API key", PROVIDER_API_KEY_ENV.openai),
		},
		models: Object.values(OPENAI_MODELS),
		api: {
			stream: wrapOpenAIResponsesStream(openAIResponses.stream),
			streamSimple: wrapOpenAIResponsesStream(openAIResponses.streamSimple),
		},
	})

export const createAnthropicProvider = (): Provider<"anthropic-messages"> =>
	createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: staticEnvApiKeyAuth("Anthropic API key", PROVIDER_API_KEY_ENV.anthropic),
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: {
			stream: anthropicMessages.stream,
			streamSimple: anthropicMessages.streamSimple,
		},
	})

export const createPiModels = (apiKeys: Effect.Success<typeof providerApiKeys>): MutableModels => {
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
	models.setProvider(createOpenAIProvider())
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
