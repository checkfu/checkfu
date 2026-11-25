import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"
import { CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL } from "@earendil-works/pi-ai/api/cloudflare-ai-binding"
import { createModels, createProvider, hasApi } from "@earendil-works/pi-ai/models"
import {
	ANTHROPIC_CLASSIFIER_MODELS,
	ANTHROPIC_IMAGE_MODELS,
	ANTHROPIC_MODELS,
} from "@earendil-works/pi-ai/providers/anthropic.models"
import {
	CLOUDFLARE_AI_GATEWAY_CLASSIFIER_MODELS,
	CLOUDFLARE_AI_GATEWAY_IMAGE_MODELS,
	CLOUDFLARE_AI_GATEWAY_MODELS,
} from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models"
import {
	CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS,
	CLOUDFLARE_WORKERS_AI_IMAGE_MODELS,
	CLOUDFLARE_WORKERS_AI_MODELS,
} from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models"
import {
	OPENAI_CLASSIFIER_MODELS,
	OPENAI_IMAGE_MODELS,
	OPENAI_MODELS,
} from "@earendil-works/pi-ai/providers/openai.models"
import {
	OPENROUTER_CLASSIFIER_MODELS,
	OPENROUTER_IMAGE_MODELS,
	OPENROUTER_MODELS,
} from "@earendil-works/pi-ai/providers/openrouter.models"
import { describe, expect, it } from "vitest"
import {
	BUILTIN_PROVIDERS,
	CLOUDFLARE_AI_API_KEY_ENV,
	CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES,
	CUSTOM_PROVIDER_SECRET_ENV_PREFIX,
	CustomProviderConfigError,
	DEFAULT_MIN_CONTEXT_WINDOW,
	MAX_MODEL_ID_LENGTH,
	assertCloudflareWorkerEnvByteLimit,
	checkProviderCredentials,
	defineProvider,
	getCloudflareAiGatewayCatalogIndex,
	getCloudflareWorkersAiCatalogIndex,
	getKnownNonChatModelIds,
	getOpenRouterCatalogEntry,
	getOpenRouterCatalogIndex,
	inferProviderForApiKey,
	isCustomProviderSecretEnv,
	isValidHeaderValue,
	packAlchemyConfigEnvValue,
	parseCustomProviderCatalog,
	parseCustomProvidersManifest,
	parseLoopbackBaseUrl,
	parseProviderBaseUrl,
	providerRequiredSecretEnvs,
	resolveModelSpecifier,
	serializeCustomProviderCatalog,
	shouldBindCloudflareAiGateway,
	utf8ByteLength,
	validateCustomProviderCredentials,
} from "../src/Catalog.ts"
import { hydrateIndexedModel } from "../src/CatalogCapabilities.ts"
import {
	DEFAULT_REFUSAL_TEXT,
	OPENAI_COMPLETIONS_CONTENT_FILTER_ERROR,
	isRefusalAssistantMessage,
	isWireFormatRefusalStopReason,
	normalizeRefusalAssistantMessage,
} from "../src/Refusals.ts"
import {
	buildPiProvider,
	createNoRedirectProviderFetch,
	createOpenAICompletionsWire,
	createOpenAIResponsesWire,
	createProviderModels,
	synthesizeProviderModel,
	withDynamicModelLookup,
} from "../src/Runtime.ts"

describe("@checkfu/pi-providers catalog & registry", () => {
	it("resolves bare and explicit built-in models while rejecting undersized legacy models", () => {
		expect(resolveModelSpecifier("gpt-4o-mini")).toEqual({
			provider: "openai",
			modelId: "gpt-4o-mini",
			cataloged: true,
		})
		expect(resolveModelSpecifier("claude-sonnet-5-5")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-5-5",
			cataloged: true,
		})
		expect(resolveModelSpecifier("openai/gpt-4o-mini")).toEqual({
			provider: "openai",
			modelId: "gpt-4o-mini",
			cataloged: true,
		})
		expect(resolveModelSpecifier("gpt-4")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4")).toBeNull()
		expect(resolveModelSpecifier("openai/computer-use-preview")).toBeNull()
		expect(resolveModelSpecifier("openai/computer-use-preview-2025-03-11")).toBeNull()
		expect(
			resolveModelSpecifier("openai/computer-use-preview-2025-03-11", { minContextWindow: 4096 }),
		).toEqual({
			provider: "openai",
			modelId: "computer-use-preview-2025-03-11",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/gpt-audio")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-audio-1.5")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-audio-mini")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4o-audio-preview")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4o-search-preview")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-5-search-api")).toBeNull()
		expect(
			resolveModelSpecifier("openai/gpt-3.5-turbo-instruct", { minContextWindow: 4096 }),
		).toBeNull()
		expect(
			resolveModelSpecifier("openai/gpt-3.5-turbo-instruct-0914", { minContextWindow: 1024 }),
		).toBeNull()
		expect(
			resolveModelSpecifier("openai/ft:gpt-3.5-turbo-instruct:org:helper:id", {
				minContextWindow: 1024,
			}),
		).toBeNull()
		expect(resolveModelSpecifier("openai/ft:gpt-4o-mini:org:my-transcribe-helper:id")).toEqual({
			provider: "openai",
			modelId: "ft:gpt-4o-mini:org:my-transcribe-helper:id",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/ft:gpt-4o-mini:org:my-search-preview-bot:id")).toEqual({
			provider: "openai",
			modelId: "ft:gpt-4o-mini:org:my-search-preview-bot:id",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/ft:gpt-4o-mini:org:my-audio-preview-bot:id")).toEqual({
			provider: "openai",
			modelId: "ft:gpt-4o-mini:org:my-audio-preview-bot:id",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/ft:gpt-4o-transcribe:org:chat-helper:id")).toBeNull()
		expect(resolveModelSpecifier("openai/ft:gpt-4o-search-preview:org:chat-helper:id")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-future-2027")).toEqual({
			provider: "openai",
			modelId: "gpt-future-2027",
			cataloged: false,
		})
		const maxOkId = `openai/${"a".repeat(MAX_MODEL_ID_LENGTH - "openai/".length)}`
		expect(resolveModelSpecifier(maxOkId)).toEqual({
			provider: "openai",
			modelId: "a".repeat(MAX_MODEL_ID_LENGTH - "openai/".length),
			cataloged: false,
		})
		expect(resolveModelSpecifier(`${maxOkId}x`)).toBeNull()
		expect(resolveModelSpecifier("gemini-2.5-flash")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-future-2027")).toEqual({
			provider: "openai",
			modelId: "gpt-future-2027",
			cataloged: false,
		})
		expect(resolveModelSpecifier("anthropic/claude-future-6")).toEqual({
			provider: "anthropic",
			modelId: "claude-future-6",
			cataloged: false,
		})
		expect(resolveModelSpecifier("unknown-provider/foo")).toBeNull()
		expect(resolveModelSpecifier("openai/")).toBeNull()
		expect(resolveModelSpecifier("openai/has spaces")).toBeNull()
	})

	it("collects secret env vars and infers providers by longest key prefix", () => {
		expect(providerRequiredSecretEnvs(BUILTIN_PROVIDERS)).toEqual([
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"OPENROUTER_API_KEY",
			CLOUDFLARE_AI_API_KEY_ENV,
		])
		expect(providerRequiredSecretEnvs(BUILTIN_PROVIDERS)).not.toContain("CLOUDFLARE_API_KEY")
		expect(inferProviderForApiKey("sk-ant-api03-123")?.id).toBe("anthropic")
		expect(inferProviderForApiKey("sk-or-v1-abc")?.id).toBe("openrouter")
		expect(inferProviderForApiKey("sk-proj-123")?.id).toBe("openai")
		expect(inferProviderForApiKey("unknown-prefix")).toBeUndefined()
		expect(shouldBindCloudflareAiGateway({ CLOUDFLARE_GATEWAY_ID: "gw" })).toBe(true)
		expect(
			shouldBindCloudflareAiGateway({
				CLOUDFLARE_GATEWAY_ID: "gw",
				CLOUDFLARE_AI_API_KEY: "token",
			}),
		).toBe(false)
		expect(shouldBindCloudflareAiGateway({})).toBe(false)
	})

	it("keeps compact catalog indexes, capabilities, and non-chat exclusions in sync with pi-ai", () => {
		const assertCatalogParity = (
			providerId: string,
			rawCatalog: Readonly<Record<string, Model<Api>>>,
			index: ReturnType<typeof getOpenRouterCatalogIndex>,
		) => {
			const chatModels = Object.values(rawCatalog).filter(
				(model) =>
					(model.type === "chat" || model.type === undefined) &&
					(hasApi(model, "openai-completions") ||
						hasApi(model, "anthropic-messages") ||
						hasApi(model, "openai-responses")),
			)
			expect(
				index.size,
				`${providerId}: run bun packages/pi-providers/scripts/sync-catalog-index.ts`,
			).toBe(chatModels.length)
			for (const model of chatModels) {
				const entry = index.get(model.id)
				expect(entry, `${providerId} missing ${model.id}`).toBeDefined()
				const hydrated = hydrateIndexedModel(entry!, {
					provider: providerId,
					baseUrl: model.baseUrl,
				})
				expect(hydrated.api).toBe(model.api)
				expect(hydrated.contextWindow).toBe(model.contextWindow)
				expect(hydrated.maxTokens).toBe(model.maxTokens)
				expect(hydrated.reasoning).toBe(model.reasoning)
				expect(hydrated.input).toEqual(model.input)
				expect(hydrated.cost).toEqual(model.cost)
				expect(hydrated.thinkingLevelMap).toEqual(model.thinkingLevelMap)
				expect(hydrated.compat).toEqual(model.compat)
				expect(hydrated.inputLimits).toEqual(model.inputLimits)
			}
		}

		assertCatalogParity("openrouter", OPENROUTER_MODELS, getOpenRouterCatalogIndex())
		assertCatalogParity(
			"cloudflare-ai-gateway",
			CLOUDFLARE_AI_GATEWAY_MODELS,
			getCloudflareAiGatewayCatalogIndex(),
		)
		assertCatalogParity(
			"cloudflare-workers-ai",
			CLOUDFLARE_WORKERS_AI_MODELS,
			getCloudflareWorkersAiCatalogIndex(),
		)

		const stripVariant = (id: string): string => {
			const colonIndex = id.indexOf(":")
			return colonIndex === -1 ? id : id.slice(0, colonIndex)
		}

		const assertNonChatParity = (
			providerId: string,
			chatCatalog: Readonly<Record<string, { readonly id: string }>>,
			otherCatalogs: ReadonlyArray<Readonly<Record<string, { readonly id: string }>>>,
			options?: {
				readonly openRouterPrefix?: string
				readonly indexVariantBaseIds?: boolean
				readonly allowSuperset?: boolean
			},
		) => {
			const chatIds = new Set(Object.values(chatCatalog).map((model) => model.id))
			const chatBaseIds = new Set(Object.values(chatCatalog).map((model) => stripVariant(model.id)))
			const expected = new Set<string>()
			const record = (id: string) => {
				if (!chatIds.has(id)) {
					expected.add(id)
				}
				if (options?.indexVariantBaseIds) {
					const baseId = stripVariant(id)
					if (baseId !== id && !chatIds.has(baseId) && !chatBaseIds.has(baseId)) {
						expected.add(baseId)
					}
				}
			}
			for (const catalog of otherCatalogs) {
				for (const model of Object.values(catalog)) {
					record(model.id)
				}
			}
			if (options?.openRouterPrefix !== undefined) {
				const openRouterNonChatCatalogs: ReadonlyArray<
					Readonly<Record<string, { readonly id: string }>>
				> = [OPENROUTER_IMAGE_MODELS, OPENROUTER_CLASSIFIER_MODELS]
				for (const catalog of openRouterNonChatCatalogs) {
					for (const model of Object.values(catalog)) {
						if (model.id.startsWith(options.openRouterPrefix)) {
							const stripped = model.id.slice(options.openRouterPrefix.length)
							record(stripped)
							const base = stripVariant(stripped)
							if (base !== stripped) {
								record(base)
							}
						}
					}
				}
			}
			const actual = getKnownNonChatModelIds(providerId) ?? new Set<string>()
			if (options?.allowSuperset) {
				for (const id of expected) {
					expect(
						actual.has(id),
						`${providerId} missing non-chat model ${id}: run bun packages/pi-providers/scripts/sync-catalog-index.ts`,
					).toBe(true)
				}
				for (const id of actual) {
					expect(
						chatIds.has(id),
						`${providerId} non-chat index must not exclude chat model ${id}`,
					).toBe(false)
				}
				return
			}
			expect(
				[...actual].toSorted(),
				`${providerId} non-chat mismatch: run bun packages/pi-providers/scripts/sync-catalog-index.ts`,
			).toEqual([...expected].toSorted())
		}

		assertNonChatParity("openai", OPENAI_MODELS, [OPENAI_IMAGE_MODELS, OPENAI_CLASSIFIER_MODELS], {
			openRouterPrefix: "openai/",
		})
		expect(getKnownNonChatModelIds("openai")?.has("gpt-image-1")).toBe(true)
		assertNonChatParity(
			"anthropic",
			ANTHROPIC_MODELS,
			[ANTHROPIC_IMAGE_MODELS, ANTHROPIC_CLASSIFIER_MODELS],
			{ openRouterPrefix: "anthropic/" },
		)
		assertNonChatParity(
			"openrouter",
			OPENROUTER_MODELS,
			[OPENROUTER_IMAGE_MODELS, OPENROUTER_CLASSIFIER_MODELS],
			{ indexVariantBaseIds: true, allowSuperset: true },
		)
		expect(getKnownNonChatModelIds("openrouter")?.has("qwen/qwen3-embedding-8b")).toBe(true)
		expect(getKnownNonChatModelIds("openrouter")?.has("google/gemini-embedding-001")).toBe(true)
		expect(getKnownNonChatModelIds("openrouter")?.has("mistralai/mistral-embed-2312")).toBe(true)
		assertNonChatParity("cloudflare-ai-gateway", CLOUDFLARE_AI_GATEWAY_MODELS, [
			CLOUDFLARE_AI_GATEWAY_IMAGE_MODELS,
			CLOUDFLARE_AI_GATEWAY_CLASSIFIER_MODELS,
		])
		assertNonChatParity(
			"cloudflare-workers-ai",
			CLOUDFLARE_WORKERS_AI_MODELS,
			[CLOUDFLARE_WORKERS_AI_IMAGE_MODELS, CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS],
			{ allowSuperset: true },
		)
		expect(
			getKnownNonChatModelIds("cloudflare-workers-ai")?.has("@cf/google/embeddinggemma-300m"),
		).toBe(true)
		expect(getKnownNonChatModelIds("cloudflare-workers-ai")?.has("@cf/microsoft/resnet-50")).toBe(
			true,
		)
		expect(getKnownNonChatModelIds("cloudflare-workers-ai")?.has("@cf/meta/llama-guard-3-8b")).toBe(
			true,
		)
	})

	it("resolves OpenRouter, Cloudflare AI Gateway, and Workers AI specifiers", () => {
		expect(resolveModelSpecifier("openrouter/anthropic/claude-sonnet-5.5")).toEqual({
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-5.5",
			cataloged: true,
		})
		expect(resolveModelSpecifier("openrouter/google/gemini-2.5-pro")).toEqual({
			provider: "openrouter",
			modelId: "google/gemini-2.5-pro",
			cataloged: true,
		})
		// Unlisted OpenRouter :variant suffixes inherit base capabilities while reporting cataloged: false.
		expect(getOpenRouterCatalogEntry("google/gemini-2.5-pro:nitro")).toBeUndefined()
		expect(resolveModelSpecifier("openrouter/google/gemini-2.5-pro:nitro")).toEqual({
			provider: "openrouter",
			modelId: "google/gemini-2.5-pro:nitro",
			cataloged: false,
		})
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/openrouter/google/gemini-2.5-pro:nitro"),
		).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "openrouter/google/gemini-2.5-pro:nitro",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openrouter/openai/computer-use-preview")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/computer-use-preview")).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/openai/computer-use-preview-2025-03-11"),
		).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/computer-use-preview")).toBeNull()
		// Chat Completions-only OpenAI models are rejected on Gateway native openai-responses routes,
		// while remaining supported on OpenRouter's openai-completions route.
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/gpt-audio-1.5")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/gpt-audio-1.5")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/gpt-4o-search-preview")).toBeNull()
		expect(resolveModelSpecifier("openrouter/openai/gpt-audio")).toEqual({
			provider: "openrouter",
			modelId: "openai/gpt-audio",
			cataloged: true,
		})
		expect(resolveModelSpecifier("openrouter/openai/gpt-audio-1.5")).toEqual({
			provider: "openrouter",
			modelId: "openai/gpt-audio-1.5",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openrouter/new-vendor/brand-new-model")).toEqual({
			provider: "openrouter",
			modelId: "new-vendor/brand-new-model",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openrouter/openai/gpt-4")).toBeNull()
		expect(resolveModelSpecifier("openrouter/qwen/qwen3-14b")).toBeNull()
		expect(resolveModelSpecifier("openrouter/qwen/qwen3-14b:free")).toBeNull()
		// Non-chat-only OpenRouter (including families cataloged only under a :variant) and native
		// OpenAI image models are excluded before Day-1 synthesis.
		expect(resolveModelSpecifier("openrouter/black-forest-labs/flux.2-pro")).toBeNull()
		expect(resolveModelSpecifier("openrouter/black-forest-labs/flux.2-pro:free")).toBeNull()
		expect(resolveModelSpecifier("openrouter/perplexity/pplx-decider-v1.3:free")).toBeNull()
		expect(resolveModelSpecifier("openrouter/perplexity/pplx-decider-v1.3")).toBeNull()
		expect(resolveModelSpecifier("openrouter/perplexity/pplx-decider-v1.3:nitro")).toBeNull()
		expect(resolveModelSpecifier("openrouter/recraft/recraft-v4.1-flash-v2")).toBeNull()
		expect(resolveModelSpecifier("openrouter/recraft/recraft-v4.1-flash-v2:nitro")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-image-1")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/gpt-image-1")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/text-embedding-3-small")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/whisper-1")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/whisper-1")).toBeNull()
		expect(resolveModelSpecifier("openrouter/openai/text-embedding-3-small")).toBeNull()
		expect(resolveModelSpecifier("openrouter/openai/whisper-1")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/baai/bge-base-en-v1.5")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/openai/whisper")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/google/embeddinggemma-300m")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/microsoft/resnet-50")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/facebook/bart-large-cnn")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/meta/llama-guard-3-8b")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/leonardo/phoenix-1.0")).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/workers-ai/@cf/baai/bge-base-en-v1.5"),
		).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/workers-ai/@cf/google/embeddinggemma-300m"),
		).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/workers-ai/@cf/microsoft/resnet-50"),
		).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/workers-ai/@cf/meta/llama-guard-3-8b"),
		).toBeNull()
		// Legacy small-context Workers AI models are excluded before Day-1 128k synthesis.
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/meta/llama-2-7b-chat-int8")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/meta/llama-3-8b-instruct")).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct"),
		).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/meta/llama-3.2-1b-instruct")).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/workers-ai/@cf/meta/llama-2-7b-chat-int8"),
		).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/workers-ai/@cf/meta/llama-3-8b-instruct"),
		).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-workers-ai/@cf/meta/llama-2-7b-chat-int8", {
				minContextWindow: 2048,
			}),
		).toEqual({
			provider: "cloudflare-workers-ai",
			modelId: "@cf/meta/llama-2-7b-chat-int8",
			cataloged: false,
		})
		expect(
			resolveModelSpecifier("cloudflare-workers-ai/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"),
		).toEqual({
			provider: "cloudflare-workers-ai",
			modelId: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
			cataloged: false,
		})
		expect(
			resolveModelSpecifier("cloudflare-workers-ai/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", {
				minContextWindow: 100_000,
			}),
		).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/gpt-image-1")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/ft:gpt-4:org:pilot:id")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/gpt-4-0613")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/gpt-4-0613")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/gpt-3.5-turbo-0125")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/gpt-4-32k-0613")).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/openrouter/perplexity/pplx-decider-v1.3"),
		).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/openrouter/perplexity/pplx-decider-v1.3:nitro"),
		).toBeNull()

		expect(resolveModelSpecifier("cloudflare-ai-gateway/claude-sonnet-5-5")).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "claude-sonnet-5-5",
			cataloged: true,
		})
		// Explicit upstream prefixes are preserved until transport and wire model ID are chosen.
		expect(resolveModelSpecifier("cloudflare-ai-gateway/anthropic/claude-sonnet-5-5")).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "anthropic/claude-sonnet-5-5",
			cataloged: true,
		})
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/gpt-6.2-sol")).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "openai/gpt-6.2-sol",
			cataloged: true,
		})
		// Gateway's own 128k limit for gpt-5 takes precedence over OpenAI's 400k limit.
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/openai/gpt-5", { minContextWindow: 200_000 }),
		).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/gpt-5", { minContextWindow: 200_000 }),
		).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-5", { minContextWindow: 200_000 })).toEqual({
			provider: "openai",
			modelId: "gpt-5",
			cataloged: true,
		})
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/openai/ft:gpt-4o-mini:org:pilot:id"),
		).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "openai/ft:gpt-4o-mini:org:pilot:id",
			cataloged: false,
		})
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/gpt-4")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/anthropic/")).toBeNull()
		// Nested slashes are rejected on explicit native OpenAI/Anthropic gateway routes,
		// while remaining allowed on the /compat route.
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openai/team/model")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/anthropic/team/model")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/dynamic/team/route")).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "dynamic/team/route",
			cataloged: false,
		})
		// OpenRouter limits and non-chat exclusions apply on the Gateway /compat route too.
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openrouter/qwen/qwen3-14b")).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openrouter/qwen/qwen3-14b:free")).toBeNull()
		expect(
			resolveModelSpecifier("cloudflare-ai-gateway/openrouter/black-forest-labs/flux.2-pro"),
		).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openrouter/google/gemini-2.5-pro")).toEqual(
			{
				provider: "cloudflare-ai-gateway",
				modelId: "openrouter/google/gemini-2.5-pro",
				cataloged: true,
			},
		)
		expect(
			resolveModelSpecifier(
				"cloudflare-ai-gateway/workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017",
			),
		).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017",
			cataloged: true,
		})
		expect(resolveModelSpecifier("cloudflare-ai-gateway/dynamic/my-route")).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "dynamic/my-route",
			cataloged: false,
		})
		expect(
			resolveModelSpecifier(
				"cloudflare-ai-gateway/workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			),
		).toBeNull()
		expect(resolveModelSpecifier("cloudflare-ai-gateway/workers-ai/@cf/cloudflare/clef")).toBeNull()

		expect(
			resolveModelSpecifier("cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017"),
		).toEqual({
			provider: "cloudflare-workers-ai",
			modelId: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
			cataloged: true,
		})
		expect(
			resolveModelSpecifier("cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
		).toBeNull()
		expect(resolveModelSpecifier("cloudflare-workers-ai/@cf/cloudflare/clef")).toBeNull()
	})

	it("validates HTTPS base URLs and blocks private/loopback targets outside local dev", () => {
		expect(parseProviderBaseUrl("https://api.example.com/v1/", { allowLoopbackHttp: false })).toBe(
			"https://api.example.com/v1",
		)
		expect(parseProviderBaseUrl("http://127.0.0.1:11434/v1/", { allowLoopbackHttp: true })).toBe(
			"http://127.0.0.1:11434/v1",
		)
		expect(() =>
			parseProviderBaseUrl("http://127.0.0.1:11434/v1", { allowLoopbackHttp: false }),
		).toThrow(/https:\/\//)
		for (const disallowed of [
			"https://127.0.0.1/v1",
			"https://localhost/v1",
			"https://169.254.169.254/latest",
			"https://10.0.0.1/v1",
			"https://192.168.1.5/v1",
			"https://[::1]/v1",
			"https://user:pass@api.example.com/v1",
			"https://api.example.com/v1?foo=bar",
			"https://api.example.com/v1#frag",
		]) {
			expect(() => parseProviderBaseUrl(disallowed, { allowLoopbackHttp: false })).toThrow(
				TypeError,
			)
		}
		expect(parseLoopbackBaseUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1")
	})

	it("checks credentials across bearer, api_key_header, none, and secretHeaders", () => {
		const bearer = defineProvider({
			id: "acme",
			name: "Acme",
			source: "custom",
			defaultModel: "acme/model-1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://api.acme.example/v1",
			auth: { kind: "bearer", env: "ACME_KEY", label: "Acme key" },
			secretHeaders: { "x-gw": "ACME_GW_TOKEN" },
		})
		expect(checkProviderCredentials(bearer, { env: {} })).toEqual({
			ok: false,
			missing: ["ACME_KEY", "ACME_GW_TOKEN"],
			message: 'Missing ACME_KEY, ACME_GW_TOKEN for provider "acme".',
		})
		expect(
			checkProviderCredentials(bearer, { env: { ACME_KEY: "k", ACME_GW_TOKEN: "t" } }),
		).toEqual({ ok: true })

		const keyless = defineProvider({
			id: "ollama",
			name: "Ollama",
			source: "custom",
			defaultModel: "ollama/llama3",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "http://127.0.0.1:11434/v1",
			auth: { kind: "none" },
		})
		expect(checkProviderCredentials(keyless, { env: {} })).toEqual({ ok: true })
	})
})

describe("@checkfu/pi-providers runtime & wire-format hardening", () => {
	it("synthesizes Day-1 unlisted models and refuses undersized static catalog models", () => {
		const models = createProviderModels({
			env: { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" },
		})
		expect(models.getModel("openai", "gpt-4")).toBeUndefined()
		const cataloged = models.getModel("openai", "gpt-4o-mini")
		expect(cataloged?.contextWindow).toBeGreaterThanOrEqual(DEFAULT_MIN_CONTEXT_WINDOW)
		const unlisted = models.getModel("openai", "gpt-future-2027")
		expect(unlisted).toMatchObject({
			id: "gpt-future-2027",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 128_000,
			maxTokens: 16_384,
		})
	})

	it("classifies confirmed refusals per wire format across any provider", () => {
		expect(isWireFormatRefusalStopReason("anthropic-messages", "refusal")).toBe(true)
		expect(isWireFormatRefusalStopReason("anthropic-messages", "sensitive")).toBe(true)
		expect(isWireFormatRefusalStopReason("anthropic-messages", "content_filter")).toBe(false)
		expect(isWireFormatRefusalStopReason("openai-responses", "refusal")).toBe(true)
		expect(isWireFormatRefusalStopReason("openai-responses", "incomplete.content_filter")).toBe(
			true,
		)
		expect(isWireFormatRefusalStopReason("openai-responses", "content_filter")).toBe(false)
		expect(isWireFormatRefusalStopReason("openai-completions", "refusal")).toBe(true)
		expect(isWireFormatRefusalStopReason("openai-completions", "content_filter")).toBe(true)
		expect(isWireFormatRefusalStopReason("openai-completions", "CONTENT_FILTER")).toBe(false)

		const filterMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial unsafe output" }],
			api: "openai-completions",
			provider: "custom-compat",
			model: "model-1",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			rawStopReason: "content_filter",
			errorMessage: OPENAI_COMPLETIONS_CONTENT_FILTER_ERROR,
			timestamp: 0,
		}
		expect(isRefusalAssistantMessage(filterMsg)).toBe(true)
		const normalized = normalizeRefusalAssistantMessage(filterMsg)
		expect(normalized.stopReason).toBe("stop")
		expect(normalized.content).toEqual([{ type: "text", text: DEFAULT_REFUSAL_TEXT }])
		expect(normalized.errorMessage).toBeUndefined()
	})

	it("guards openai-completions streams against content_filter and delta.refusal", async () => {
		const customProvider = defineProvider({
			id: "compat",
			name: "Compat",
			source: "custom",
			defaultModel: "compat/test-model",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://compat.example/v1",
			auth: { kind: "bearer", env: "COMPAT_KEY", label: "Compat key" },
		})
		const models = createProviderModels({
			env: { COMPAT_KEY: "sk-compat" },
			customProviders: [customProvider],
		})
		const model = models.getModel("compat", "test-model")
		expect(model).toBeDefined()

		const contentFilterSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_1",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [
					{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null },
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_1",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const filterResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async () =>
					new Response(contentFilterSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(filterResult.stopReason).toBe("error")
		expect(filterResult.rawStopReason).toBe("content_filter")
		expect(isRefusalAssistantMessage(filterResult)).toBe(true)

		const deltaRefusalSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_2",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", refusal: "I cannot assist with that." },
						finish_reason: null,
					},
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_2",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const refusalResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async () =>
					new Response(deltaRefusalSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(refusalResult.stopReason).toBe("error")
		expect(refusalResult.rawStopReason).toBe("refusal")
		expect(refusalResult.content).toEqual([{ type: "text", text: "I cannot assist with that." }])
		const normalized = normalizeRefusalAssistantMessage(refusalResult)
		expect(normalized.content).toEqual([{ type: "text", text: "I cannot assist with that." }])

		const emptyRefusalDeltaSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_3",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "Normal answer", refusal: "" },
						finish_reason: null,
					},
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_3",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, delta: { refusal: "" }, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const normalResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async () =>
					new Response(emptyRefusalDeltaSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(normalResult.stopReason).toBe("stop")
		expect(normalResult.content).toEqual([{ type: "text", text: "Normal answer" }])
		expect(isRefusalAssistantMessage(normalResult)).toBe(false)

		const lengthRefusalSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_4",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", refusal: "I cannot comply with " },
						finish_reason: null,
					},
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_4",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, delta: { refusal: "that request." }, finish_reason: "length" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const lengthRefusalResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async () =>
					new Response(lengthRefusalSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(lengthRefusalResult.stopReason).toBe("error")
		expect(lengthRefusalResult.rawStopReason).toBe("refusal")
		expect(lengthRefusalResult.content).toEqual([
			{ type: "text", text: "I cannot comply with that request." },
		])
		expect(isRefusalAssistantMessage(lengthRefusalResult)).toBe(true)
		expect(normalizeRefusalAssistantMessage(lengthRefusalResult).content).toEqual([
			{ type: "text", text: "I cannot comply with that request." },
		])

		let pullCount = 0
		const brokenRefusalStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount += 1
				if (pullCount === 1) {
					controller.enqueue(
						new TextEncoder().encode(
							`data: ${JSON.stringify({
								id: "chatcmpl_5",
								object: "chat.completion.chunk",
								created: 1,
								model: "test-model",
								choices: [
									{
										index: 0,
										delta: { role: "assistant", refusal: "Partial refusal" },
										finish_reason: null,
									},
								],
							})}\n\n`,
						),
					)
					return
				}
				controller.error(new Error("socket reset"))
			},
		})
		let observedRefusalDelta = false
		const transportErrorResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				onProviderStreamEvent: (data) => {
					if (
						typeof data === "object" &&
						data !== null &&
						"choices" in data &&
						Array.isArray(data.choices)
					) {
						const first: unknown = data.choices[0]
						if (
							typeof first === "object" &&
							first !== null &&
							"delta" in first &&
							typeof first.delta === "object" &&
							first.delta !== null &&
							"refusal" in first.delta &&
							first.delta.refusal === "Partial refusal"
						) {
							observedRefusalDelta = true
						}
					}
				},
				fetch: async () =>
					new Response(brokenRefusalStream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(observedRefusalDelta).toBe(true)
		expect(transportErrorResult.stopReason).toBe("error")
		expect(isRefusalAssistantMessage(transportErrorResult)).toBe(false)
	})

	it("routes OpenRouter Claude models to Anthropic Messages and other models to OpenAI Completions", async () => {
		const models = createProviderModels({
			env: { OPENROUTER_API_KEY: "sk-or-v1-test" },
		})
		const claude = models.getModel("openrouter", "anthropic/claude-sonnet-5.5")
		expect(claude).toMatchObject({
			id: "anthropic/claude-sonnet-5.5",
			provider: "openrouter",
			api: "anthropic-messages",
			baseUrl: "https://openrouter.ai/api",
			contextWindow: 1_000_000,
		})
		const claudeBatch = models.getModel("openrouter", "anthropic/claude-sonnet-5.5:batch")
		expect(claudeBatch).toMatchObject({
			id: "anthropic/claude-sonnet-5.5:batch",
			provider: "openrouter",
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { thinkingFormat: "openrouter", cacheControlFormat: "anthropic" },
		})
		const gemini = models.getModel("openrouter", "google/gemini-2.5-pro")
		expect(gemini).toMatchObject({
			id: "google/gemini-2.5-pro",
			provider: "openrouter",
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			contextWindow: 1_048_576,
			reasoning: true,
			thinkingLevelMap: { off: null },
			compat: { thinkingFormat: "openrouter", supportsStrictMode: true },
		})
		expect(models.getModel("openrouter", "new-vendor/brand-new-model")?.reasoning).toBe(false)
		expect(models.getModelOfType("chat", "openrouter", "anthropic/claude-sonnet-5.5")).toEqual(
			claude,
		)
		expect(models.getModel("openrouter", "openai/gpt-4")).toBeUndefined()
		expect(models.getModel("openrouter", "qwen/qwen3-14b")).toBeUndefined()
		expect(models.getModelOfType("chat", "openrouter", "qwen/qwen3-14b")).toBeUndefined()
		expect(models.getModel("openrouter", "black-forest-labs/flux.2-pro")).toBeUndefined()

		const seenRequests: Array<{
			readonly url: string
			readonly auth: string | null
			readonly hasReasoning: boolean
		}> = []
		const sseBody = [
			`data: ${JSON.stringify({
				id: "chatcmpl_or",
				object: "chat.completion.chunk",
				created: 1,
				model: "google/gemini-2.5-pro",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "Hello from OpenRouter" },
						finish_reason: null,
					},
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_or",
				object: "chat.completion.chunk",
				created: 1,
				model: "google/gemini-2.5-pro",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")
		const result = await models.complete(
			gemini!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (input, init) => {
					const headers = new Headers(init?.headers)
					const body =
						typeof init?.body === "string"
							? (JSON.parse(init.body) as { readonly reasoning?: unknown })
							: {}
					seenRequests.push({
						url: String(input),
						auth: headers.get("authorization"),
						hasReasoning: body.reasoning !== undefined,
					})
					return new Response(sseBody, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(result.stopReason).toBe("stop")
		expect(result.content).toEqual([{ type: "text", text: "Hello from OpenRouter" }])
		// google/gemini-2.5-pro sets thinkingLevelMap.off = null, so default turns must NOT
		// send `reasoning: { effort: "none" }`.
		expect(seenRequests).toEqual([
			{
				url: "https://openrouter.ai/api/v1/chat/completions",
				auth: "Bearer sk-or-v1-test",
				hasReasoning: false,
			},
		])
		// Listing methods expose eligible indexed OpenRouter models filtered by minContextWindow.
		const availableOpenRouterIds = (await models.getAvailable("openrouter")).map((m) => m.id)
		expect(availableOpenRouterIds).toContain("anthropic/claude-sonnet-5.5")
		expect(availableOpenRouterIds).toContain("google/gemini-2.5-pro")
		expect(availableOpenRouterIds).not.toContain("qwen/qwen3-14b")

		// OpenRouter wire guards pin both anthropic-messages and openai-completions streams to
		// the active registry's configured endpoint so retained local-override models cannot
		// redirect production keys and transcripts to an old origin or wrong route path.
		const localOrModels = createProviderModels({
			env: { OPENROUTER_API_KEY: "sk-or-local" },
			baseUrlOverrides: { openrouter: "http://127.0.0.1:18999/v1" },
		})
		const retainedLocalOrClaude = localOrModels.getModel(
			"openrouter",
			"anthropic/claude-sonnet-5.5",
		)!
		const retainedLocalOrGemini = localOrModels.getModel("openrouter", "google/gemini-2.5-pro")!
		let openRouterLeakedFetches = 0
		const leakCountingFetch: typeof fetch = async () => {
			openRouterLeakedFetches += 1
			return new Response(sseBody, { status: 200 })
		}
		const rejectedOrAnthropic = await models.complete(
			retainedLocalOrClaude,
			{ messages: [{ role: "user", content: "secret", timestamp: 0 }] },
			{ fetch: leakCountingFetch },
		)
		expect(rejectedOrAnthropic.stopReason).toBe("error")
		expect(rejectedOrAnthropic.errorMessage).toMatch(/disallowed origin/i)
		const rejectedOrCompletions = await models.complete(
			retainedLocalOrGemini,
			{ messages: [{ role: "user", content: "secret", timestamp: 0 }] },
			{ fetch: leakCountingFetch },
		)
		expect(rejectedOrCompletions.stopReason).toBe("error")
		expect(rejectedOrCompletions.errorMessage).toMatch(/disallowed origin/i)
		const rejectedReverseOr = await localOrModels.complete(
			gemini!,
			{ messages: [{ role: "user", content: "secret", timestamp: 0 }] },
			{ fetch: leakCountingFetch },
		)
		expect(rejectedReverseOr.stopReason).toBe("error")
		expect(rejectedReverseOr.errorMessage).toMatch(/disallowed origin/i)
		const rejectedSwappedPath = await models.complete(
			{ ...claude!, baseUrl: "https://openrouter.ai/api/v1" },
			{ messages: [{ role: "user", content: "secret", timestamp: 0 }] },
			{ fetch: leakCountingFetch },
		)
		expect(rejectedSwappedPath.stopReason).toBe("error")
		expect(rejectedSwappedPath.errorMessage).toMatch(/mismatched endpoint/i)
		expect(openRouterLeakedFetches).toBe(0)

		// OpenRouter suppresses native OpenAI and Anthropic SDK env headers on both codecs.
		const savedOrSdkEnv = {
			OPENAI_CUSTOM_HEADERS: process.env["OPENAI_CUSTOM_HEADERS"],
			OPENAI_ORG_ID: process.env["OPENAI_ORG_ID"],
			ANTHROPIC_CUSTOM_HEADERS: process.env["ANTHROPIC_CUSTOM_HEADERS"],
		}
		process.env["OPENAI_CUSTOM_HEADERS"] = "X-Native-OAI-Leak: should-not-send"
		process.env["OPENAI_ORG_ID"] = "org-should-not-send"
		process.env["ANTHROPIC_CUSTOM_HEADERS"] = "X-Native-Anth-Leak: should-not-send"
		try {
			let orCompHeaders: Headers | undefined
			await models.complete(
				gemini!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						orCompHeaders = new Headers(init?.headers)
						return new Response(sseBody, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(orCompHeaders?.get("x-native-oai-leak")).toBeNull()
			expect(orCompHeaders?.get("openai-organization")).toBeNull()

			let orAnthHeaders: Headers | undefined
			const orAnthSse = [
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_or",
						type: "message",
						role: "assistant",
						model: "anthropic/claude-sonnet-5.5",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				})}\n\n`,
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 1 },
				})}\n\n`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
			].join("")
			await models.complete(
				claude!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						orAnthHeaders = new Headers(init?.headers)
						return new Response(orAnthSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(orAnthHeaders?.get("x-native-anth-leak")).toBeNull()
		} finally {
			for (const [key, value] of Object.entries(savedOrSdkEnv)) {
				if (value === undefined) {
					delete process.env[key]
				} else {
					process.env[key] = value
				}
			}
		}
	})

	it("routes Cloudflare AI Gateway over HTTPS and zero-token native AI binding", async () => {
		// 1. HTTPS transport with explicit CLOUDFLARE_AI_API_KEY + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_GATEWAY_ID
		const httpsModels = createProviderModels({
			env: {
				CLOUDFLARE_AI_API_KEY: "cf-secret-token",
				CLOUDFLARE_ACCOUNT_ID: "acct-123",
				CLOUDFLARE_GATEWAY_ID: "gw-main",
			},
		})
		const httpsAnthropic = httpsModels.getModel("cloudflare-ai-gateway", "claude-sonnet-5-5")
		const httpsExplicitAnthropic = httpsModels.getModel(
			"cloudflare-ai-gateway",
			"anthropic/claude-sonnet-5-5",
		)
		const httpsOpenAI = httpsModels.getModel("cloudflare-ai-gateway", "gpt-6.2-sol")
		const httpsFineTune = httpsModels.getModel(
			"cloudflare-ai-gateway",
			"openai/ft:gpt-4o-mini:org:pilot:id",
		)
		const httpsCompat = httpsModels.getModel("cloudflare-ai-gateway", "dynamic/my-route")
		expect(httpsAnthropic).toMatchObject({
			id: "claude-sonnet-5-5",
			api: "anthropic-messages",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-123/gw-main/anthropic",
		})
		expect(httpsExplicitAnthropic).toMatchObject({
			id: "claude-sonnet-5-5",
			api: "anthropic-messages",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-123/gw-main/anthropic",
		})
		expect(httpsOpenAI).toMatchObject({
			id: "gpt-6.2-sol",
			api: "openai-responses",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-123/gw-main/openai",
		})
		expect(httpsFineTune).toMatchObject({
			id: "ft:gpt-4o-mini:org:pilot:id",
			api: "openai-responses",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-123/gw-main/openai",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 16_384,
		})
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "openai/ft:o4-mini:org:pilot:id"),
		).toMatchObject({
			id: "ft:o4-mini:org:pilot:id",
			api: "openai-responses",
			reasoning: true,
			contextWindow: 200_000,
		})
		// Unknown unlisted Gateway models omit reasoning controls instead of assuming support.
		expect(httpsModels.getModel("cloudflare-ai-gateway", "openai/gpt-future-2027")?.reasoning).toBe(
			false,
		)
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "openai/ft:gpt-4:org:pilot:id"),
		).toBeUndefined()
		expect(httpsModels.getModel("openai", "gpt-image-1")).toBeUndefined()
		expect(httpsModels.getModel("openai", "gpt-image-1-2025-04-23")).toBeUndefined()
		expect(resolveModelSpecifier("openai/gpt-image-1-2025-04-23")).toBeNull()
		expect(httpsModels.getModel("cloudflare-ai-gateway", "openai/gpt-image-1")).toBeUndefined()
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "openai/gpt-image-1-2025-04-23"),
		).toBeUndefined()
		expect(httpsModels.getModel("cloudflare-ai-gateway", "gpt-image-1")).toBeUndefined()
		expect(httpsModels.getModel("cloudflare-ai-gateway", "gpt-image-1-2025-04-23")).toBeUndefined()

		// Dated snapshots on Gateway routes inherit Gateway/base limits and refuse undersized bases.
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "openai/gpt-4-turbo-2024-04-09"),
		).toMatchObject({
			id: "gpt-4-turbo-2024-04-09",
			api: "openai-responses",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 4096,
		})
		expect(httpsModels.getModel("cloudflare-ai-gateway", "gpt-4-turbo-2024-04-09")).toMatchObject({
			id: "gpt-4-turbo-2024-04-09",
			api: "openai-responses",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 4096,
		})
		expect(httpsModels.getModel("cloudflare-ai-gateway", "openai/gpt-5-2025-08-07")).toMatchObject({
			id: "gpt-5-2025-08-07",
			api: "openai-responses",
			contextWindow: 128_000,
		})
		expect(httpsModels.getModel("cloudflare-ai-gateway", "openai/gpt-4-2024-04-09")).toBeUndefined()
		expect(httpsModels.getModel("cloudflare-ai-gateway", "gpt-4-2024-04-09")).toBeUndefined()
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "anthropic/claude-sonnet-4-6-20260301"),
		).toMatchObject({
			id: "claude-sonnet-4-6-20260301",
			api: "anthropic-messages",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-123/gw-main/anthropic",
		})

		// Verify completeSimple on a non-reasoning fine-tune omits `reasoning` from the request body.
		let fineTuneBody: { readonly reasoning?: unknown } | undefined
		const responsesSse = [
			`event: response.completed\ndata: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_ft_1",
					object: "response",
					status: "completed",
					model: "ft:gpt-4o-mini:org:pilot:id",
					output: [
						{
							id: "msg_1",
							type: "message",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Fine-tuned reply", annotations: [] }],
						},
					],
					usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
				},
			})}\n\n`,
		].join("")
		const fineTuneResult = await httpsModels.completeSimple(
			httpsFineTune!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (_input, init) => {
					if (typeof init?.body === "string") {
						fineTuneBody = JSON.parse(init.body) as { readonly reasoning?: unknown }
					}
					return new Response(responsesSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(fineTuneResult.stopReason).toBe("stop")
		expect(fineTuneBody?.reasoning).toBeUndefined()

		// Listing methods expose eligible Gateway models with real catalog limits & pricing.
		const availableGatewayModels = await httpsModels.getAvailable("cloudflare-ai-gateway")
		expect(availableGatewayModels.some((m) => m.id === "claude-sonnet-5-5")).toBe(true)
		const gatewayGpt5 = availableGatewayModels.find((m) => m.id === "gpt-5")
		expect(gatewayGpt5?.contextWindow).toBe(128_000)
		expect(gatewayGpt5?.cost.input).toBeGreaterThan(0)
		expect(
			availableGatewayModels.some(
				(m) => m.id === "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			),
		).toBe(false)
		expect(httpsCompat).toMatchObject({
			id: "dynamic/my-route",
			api: "openai-completions",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-123/gw-main/compat",
		})
		// Gateway catalog limits take precedence over direct OpenAI upstream limits (128k vs 400k).
		expect(httpsModels.getModel("cloudflare-ai-gateway", "openai/gpt-5")?.contextWindow).toBe(
			128_000,
		)
		expect(httpsModels.getModel("cloudflare-ai-gateway", "gpt-5")?.contextWindow).toBe(128_000)
		expect(httpsModels.getModel("cloudflare-ai-gateway", "openai/gpt-audio-1.5")).toBeUndefined()
		expect(httpsModels.getModel("cloudflare-ai-gateway", "gpt-audio-1.5")).toBeUndefined()

		// Delegated Gateway /compat models preserve downstream replay requirements (such as
		// requiresReasoningContentOnAssistantMessages for DeepSeek V4) alongside Gateway settings.
		const gwDeepSeek = httpsModels.getModel(
			"cloudflare-ai-gateway",
			"openrouter/deepseek/deepseek-v4-flash",
		)
		expect(gwDeepSeek?.api).toBe("openai-completions")
		expect(gwDeepSeek).toMatchObject({
			compat: {
				requiresReasoningContentOnAssistantMessages: true,
				supportsStore: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
		})
		let gwFollowUpMessages: ReadonlyArray<{
			readonly role?: string
			readonly reasoning_content?: string
		}> = []
		const deepSeekSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_ds",
				object: "chat.completion.chunk",
				created: 1,
				model: "openrouter/deepseek/deepseek-v4-flash",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")
		await httpsModels.completeSimple(
			gwDeepSeek!,
			{
				messages: [
					{ role: "user", content: "first turn", timestamp: 0 },
					{
						role: "assistant",
						content: [{ type: "text", text: "first reply without thinking block" }],
						api: "openai-completions",
						provider: "cloudflare-ai-gateway",
						model: "openrouter/deepseek/deepseek-v4-flash",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 1,
					},
					{ role: "user", content: "second turn", timestamp: 2 },
				],
			},
			{
				fetch: async (_input, init) => {
					if (typeof init?.body === "string") {
						const parsed = JSON.parse(init.body) as {
							readonly messages?: ReadonlyArray<{
								readonly role?: string
								readonly reasoning_content?: string
							}>
						}
						gwFollowUpMessages = parsed.messages ?? []
					}
					return new Response(deepSeekSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		const assistantTurn = gwFollowUpMessages.find((msg) => msg.role === "assistant")
		expect(assistantTurn).toBeDefined()
		expect(assistantTurn).toHaveProperty("reasoning_content")
		const strictGwModels = createProviderModels({
			env: {
				CLOUDFLARE_AI_API_KEY: "cf-secret-token",
				CLOUDFLARE_ACCOUNT_ID: "acct-123",
				CLOUDFLARE_GATEWAY_ID: "gw-main",
			},
			minContextWindow: 200_000,
		})
		expect(strictGwModels.getModel("cloudflare-ai-gateway", "openai/gpt-5")).toBeUndefined()
		expect(strictGwModels.getModel("cloudflare-ai-gateway", "gpt-5")).toBeUndefined()

		// OpenRouter limits, invalid native slashes, and non-chat exclusions apply on Gateway routes.
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "openrouter/qwen/qwen3-14b"),
		).toBeUndefined()
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "openrouter/qwen/qwen3-14b:free"),
		).toBeUndefined()
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "openrouter/google/gemini-2.5-pro"),
		).toMatchObject({
			id: "openrouter/google/gemini-2.5-pro",
			api: "openai-completions",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-123/gw-main/compat",
			contextWindow: 1_048_576,
		})
		expect(httpsModels.getModel("cloudflare-ai-gateway", "openai/team/model")).toBeUndefined()
		expect(httpsModels.getModel("cloudflare-ai-gateway", "anthropic/team/model")).toBeUndefined()
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "workers-ai/@cf/cloudflare/clef"),
		).toBeUndefined()
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "openrouter/black-forest-labs/flux.2-pro"),
		).toBeUndefined()
		const httpsHeadersSeen: Array<{
			readonly url: string
			readonly cfAuth: string | null
			readonly authorization: string | null
			readonly xApiKey: string | null
		}> = []
		const compatSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_cf",
				object: "chat.completion.chunk",
				created: 1,
				model: "dynamic/my-route",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "Via Gateway HTTPS" },
						finish_reason: null,
					},
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_cf",
				object: "chat.completion.chunk",
				created: 1,
				model: "dynamic/my-route",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")
		const httpsResult = await httpsModels.complete(
			httpsCompat!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (input, init) => {
					const headers = new Headers(init?.headers)
					httpsHeadersSeen.push({
						url: String(input),
						cfAuth: headers.get("cf-aig-authorization"),
						authorization: headers.get("authorization"),
						xApiKey: headers.get("x-api-key"),
					})
					return new Response(compatSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(httpsResult.stopReason).toBe("stop")
		expect(httpsHeadersSeen).toEqual([
			{
				url: "https://gateway.ai.cloudflare.com/v1/acct-123/gw-main/compat/chat/completions",
				cfAuth: "Bearer cf-secret-token",
				authorization: null,
				xApiKey: null,
			},
		])

		// 2. Zero-token native Cloudflare Worker AI binding transport
		const bindingCalls: Array<{
			readonly url: string
			readonly cfAuth: string | null
			readonly authorization: string | null
		}> = []
		const fakeAiBinding = {
			fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const headers = new Headers(init?.headers)
				bindingCalls.push({
					url: String(input),
					cfAuth: headers.get("cf-aig-authorization"),
					authorization: headers.get("authorization"),
				})
				return new Response(compatSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})
			},
		}
		const gatewaySpec = BUILTIN_PROVIDERS.find((p) => p.id === "cloudflare-ai-gateway")!
		expect(
			checkProviderCredentials(gatewaySpec, {
				env: { CLOUDFLARE_GATEWAY_ID: "gw-binding" },
				aiBinding: fakeAiBinding,
			}),
		).toEqual({ ok: true })
		expect(
			checkProviderCredentials(gatewaySpec, {
				env: { CLOUDFLARE_GATEWAY_ID: "gw-binding" },
			}),
		).toMatchObject({ ok: false, missing: ["CLOUDFLARE_ACCOUNT_ID", CLOUDFLARE_AI_API_KEY_ENV] })
		// When CLOUDFLARE_AI_API_KEY is set, HTTPS mode is selected (never binding fallback), so
		// missing CLOUDFLARE_ACCOUNT_ID fails both preflight credential checks and runtime dispatch.
		expect(
			checkProviderCredentials(gatewaySpec, {
				env: { CLOUDFLARE_GATEWAY_ID: "gw-binding", CLOUDFLARE_AI_API_KEY: "cf-tok" },
				aiBinding: fakeAiBinding,
			}),
		).toMatchObject({ ok: false, missing: ["CLOUDFLARE_ACCOUNT_ID"] })
		expect(
			checkProviderCredentials(gatewaySpec, {
				env: {},
				aiBinding: fakeAiBinding,
			}),
		).toMatchObject({ ok: false, missing: ["CLOUDFLARE_GATEWAY_ID"] })
		const partialHttpsModels = createProviderModels({
			env: { CLOUDFLARE_GATEWAY_ID: "gw-binding", CLOUDFLARE_AI_API_KEY: "cf-tok" },
			aiBinding: fakeAiBinding,
		})
		const partialHttpsModel = partialHttpsModels.getModel(
			"cloudflare-ai-gateway",
			"dynamic/my-route",
		)!
		const hitsBeforePartial = bindingCalls.length
		const partialHttpsResult = await partialHttpsModels.complete(partialHttpsModel, {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		})
		expect(partialHttpsResult.stopReason).toBe("error")
		expect(partialHttpsResult.errorMessage).toMatch(/not configured/i)
		expect(bindingCalls.length).toBe(hitsBeforePartial)

		const bindingModels = createProviderModels({
			env: { CLOUDFLARE_GATEWAY_ID: "gw-binding" },
			aiBinding: fakeAiBinding,
		})
		const bindingModel = bindingModels.getModel("cloudflare-ai-gateway", "dynamic/my-route")
		expect(bindingModel?.baseUrl).toBe(
			"https://workers-binding.ai/ai-gateway/gateways/gw-binding/compat",
		)
		const bindingResult = await bindingModels.complete(bindingModel!, {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		})
		expect(bindingResult.stopReason).toBe("stop")
		expect(bindingCalls).toEqual([
			{
				url: "https://workers-binding.ai/ai-gateway/gateways/gw-binding/compat/chat/completions",
				cfAuth: "Bearer cloudflare-gateway-binding",
				authorization: null,
			},
		])

		// 3. Cloudflare Workers AI direct endpoint
		const workersAiModels = createProviderModels({
			env: {
				CLOUDFLARE_AI_API_KEY: "cf-workers-key",
				CLOUDFLARE_ACCOUNT_ID: "acct-999",
			},
		})
		const deepseek = workersAiModels.getModel(
			"cloudflare-workers-ai",
			"@cf/deepseek-ai/deepseek-v4.1-flash-1017",
		)
		expect(deepseek).toMatchObject({
			api: "openai-completions",
			provider: "cloudflare-workers-ai",
			baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct-999/ai/v1",
		})
		expect(
			workersAiModels.getModel("cloudflare-workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
		).toBeUndefined()
		expect(workersAiModels.getModel("cloudflare-workers-ai", "@cf/cloudflare/clef")).toBeUndefined()
		expect(
			workersAiModels.getModel("cloudflare-workers-ai", "@cf/google/embeddinggemma-300m"),
		).toBeUndefined()
		expect(
			workersAiModels.getModel("cloudflare-workers-ai", "@cf/microsoft/resnet-50"),
		).toBeUndefined()
		expect(
			workersAiModels.getModel("cloudflare-workers-ai", "@cf/meta/llama-2-7b-chat-int8"),
		).toBeUndefined()
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "workers-ai/@cf/google/embeddinggemma-300m"),
		).toBeUndefined()
		expect(
			httpsModels.getModel("cloudflare-ai-gateway", "workers-ai/@cf/meta/llama-2-7b-chat-int8"),
		).toBeUndefined()
		const lowFloorWorkers = createProviderModels({
			env: { CLOUDFLARE_AI_API_KEY: "cf-workers-key", CLOUDFLARE_ACCOUNT_ID: "acct-999" },
			minContextWindow: 2048,
		})
		expect(
			lowFloorWorkers.getModel("cloudflare-workers-ai", "@cf/meta/llama-2-7b-chat-int8"),
		).toMatchObject({
			contextWindow: 4096,
			maxTokens: 4096,
			reasoning: false,
		})
		expect(
			workersAiModels.getModel(
				"cloudflare-workers-ai",
				"@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
			),
		).toMatchObject({
			contextWindow: 80_000,
		})

		// 4. Per-request Cloudflare overrides resolve route, transport, and credentials together
		//    even from an initially empty registry or when overriding a configured gateway/binding.
		const emptyRegistry = createProviderModels({ env: {} })
		const emptyGwModel = emptyRegistry.getModel("cloudflare-ai-gateway", "dynamic/my-route")!
		const reqOverrideCalls: Array<{
			readonly url: string
			readonly cfAuth: string | null
			readonly authorization: string | null
		}> = []
		await emptyRegistry.completeSimple(
			emptyGwModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "req-gw-token",
				env: { CLOUDFLARE_ACCOUNT_ID: "req-acct", CLOUDFLARE_GATEWAY_ID: "req-gw" },
				fetch: async (input, init) => {
					const headers = new Headers(init?.headers)
					reqOverrideCalls.push({
						url: String(input),
						cfAuth: headers.get("cf-aig-authorization"),
						authorization: headers.get("authorization"),
					})
					return new Response(compatSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(reqOverrideCalls).toEqual([
			{
				url: "https://gateway.ai.cloudflare.com/v1/req-acct/req-gw/compat/chat/completions",
				cfAuth: "Bearer req-gw-token",
				authorization: null,
			},
		])

		// Overriding a binding-configured Gateway with per-request HTTPS credentials switches
		// both destination URL and transport away from the binding.
		let bindingTouchedOnHttpsOverride = false
		const spyBinding = {
			fetch: async () => {
				bindingTouchedOnHttpsOverride = true
				return new Response(compatSse, { status: 200 })
			},
		}
		const boundRegistry = createProviderModels({
			env: { CLOUDFLARE_GATEWAY_ID: "old-bind-gw" },
			aiBinding: spyBinding,
		})
		const boundModel = boundRegistry.getModel("cloudflare-ai-gateway", "dynamic/my-route")!
		let overrideUrl = ""
		let overrideCfAuth: string | null = null
		await boundRegistry.completeSimple(
			boundModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "override-https-token",
				env: { CLOUDFLARE_ACCOUNT_ID: "override-acct", CLOUDFLARE_GATEWAY_ID: "override-gw" },
				fetch: async (input, init) => {
					overrideUrl = String(input)
					overrideCfAuth = new Headers(init?.headers).get("cf-aig-authorization")
					return new Response(compatSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(bindingTouchedOnHttpsOverride).toBe(false)
		expect(overrideUrl).toBe(
			"https://gateway.ai.cloudflare.com/v1/override-acct/override-gw/compat/chat/completions",
		)
		expect(overrideCfAuth).toBe("Bearer override-https-token")

		// Per-request Workers AI override replaces account ID on the wire even from an empty registry.
		const emptyWorkersModel = emptyRegistry.getModel(
			"cloudflare-workers-ai",
			"@cf/deepseek-ai/deepseek-v4.1-flash-1017",
		)!
		let workersOverrideUrl = ""
		let workersOverrideAuth: string | null = null
		await emptyRegistry.completeSimple(
			emptyWorkersModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "wa-req-key",
				env: { CLOUDFLARE_ACCOUNT_ID: "wa-req-acct" },
				fetch: async (input, init) => {
					workersOverrideUrl = String(input)
					workersOverrideAuth = new Headers(init?.headers).get("authorization")
					return new Response(compatSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(workersOverrideUrl).toBe(
			"https://api.cloudflare.com/client/v4/accounts/wa-req-acct/ai/v1/chat/completions",
		)
		expect(workersOverrideAuth).toBe("Bearer wa-req-key")

		// Two registries share immutable hydrated OpenRouter models across sessions.
		const orSessionA = createProviderModels({ env: { OPENROUTER_API_KEY: "sk-or-a" } })
		const orSessionB = createProviderModels({ env: { OPENROUTER_API_KEY: "sk-or-b" } })
		expect(orSessionA.getModels("openrouter")[0]).toBe(orSessionB.getModels("openrouter")[0])

		// Dynamic lookup enforces spec.formats against the resolved plan's wire format, matching listing.
		const openRouterSpec = BUILTIN_PROVIDERS.find((provider) => provider.id === "openrouter")!
		const completionsOnlyOpenRouter = createProviderModels({
			env: { OPENROUTER_API_KEY: "sk-or-only" },
		})
		completionsOnlyOpenRouter.setProvider(
			buildPiProvider(
				{
					...openRouterSpec,
					defaultFormat: "openai-completions",
					formats: ["openai-completions"],
				},
				{ env: { OPENROUTER_API_KEY: "sk-or-only" } },
			),
		)
		expect(
			completionsOnlyOpenRouter.getModel("openrouter", "anthropic/claude-sonnet-5.5"),
		).toBeUndefined()
		expect(
			completionsOnlyOpenRouter.getModel("openrouter", "anthropic/claude-future-7"),
		).toBeUndefined()
		expect(
			completionsOnlyOpenRouter.getModel("openrouter", "anthropic/claude-sonnet-5.5:nitro")?.api,
		).toBe("openai-completions")
		expect(completionsOnlyOpenRouter.getModel("openrouter", "openai/gpt-4o-mini")?.api).toBe(
			"openai-completions",
		)

		// Upstream-only OpenRouter matches (with or without a :variant suffix, including Claude
		// fallbacks) preserve upstream capabilities while reporting cataloged: false and honoring
		// allowUnlistedModels: false on both direct OpenRouter and Gateway routes.
		expect(getOpenRouterCatalogEntry("openai/o1")).toBeUndefined()
		expect(getOpenRouterCatalogEntry("anthropic/claude-sonnet-4-5")).toBeUndefined()
		expect(resolveModelSpecifier("openrouter/openai/o1")).toEqual({
			provider: "openrouter",
			modelId: "openai/o1",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openrouter/openai/o1:nitro")).toEqual({
			provider: "openrouter",
			modelId: "openai/o1:nitro",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openrouter/anthropic/claude-sonnet-4-5")).toEqual({
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-4-5",
			cataloged: false,
		})
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openrouter/openai/o1")).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "openrouter/openai/o1",
			cataloged: false,
		})
		expect(resolveModelSpecifier("cloudflare-ai-gateway/openrouter/openai/o1:nitro")).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "openrouter/openai/o1:nitro",
			cataloged: false,
		})
		const orO1 = orSessionA.getModel("openrouter", "openai/o1")
		expect(orO1).toMatchObject({
			id: "openai/o1",
			contextWindow: 200_000,
			reasoning: true,
		})
		const lockedOpenRouter = createProviderModels({ env: { OPENROUTER_API_KEY: "sk-or-lock" } })
		lockedOpenRouter.setProvider(
			buildPiProvider(
				{ ...openRouterSpec, allowUnlistedModels: false },
				{ env: { OPENROUTER_API_KEY: "sk-or-lock" } },
			),
		)
		expect(lockedOpenRouter.getModel("openrouter", "anthropic/claude-sonnet-5.5")).toBeDefined()
		expect(lockedOpenRouter.getModel("openrouter", "openai/o1")).toBeUndefined()
		expect(lockedOpenRouter.getModel("openrouter", "openai/o1:nitro")).toBeUndefined()
		expect(lockedOpenRouter.getModel("openrouter", "anthropic/claude-sonnet-4-5")).toBeUndefined()
		const gwSpec = BUILTIN_PROVIDERS.find((provider) => provider.id === "cloudflare-ai-gateway")!
		const lockedGw = createProviderModels({
			env: {
				CLOUDFLARE_GATEWAY_ID: "gw-1",
				CLOUDFLARE_AI_API_KEY: "k",
				CLOUDFLARE_ACCOUNT_ID: "a",
			},
		})
		lockedGw.setProvider(
			buildPiProvider(
				{ ...gwSpec, allowUnlistedModels: false },
				{
					env: {
						CLOUDFLARE_GATEWAY_ID: "gw-1",
						CLOUDFLARE_AI_API_KEY: "k",
						CLOUDFLARE_ACCOUNT_ID: "a",
					},
				},
			),
		)
		expect(lockedGw.getModel("cloudflare-ai-gateway", "openrouter/openai/o1")).toBeUndefined()
		expect(lockedGw.getModel("cloudflare-ai-gateway", "openrouter/openai/o1:nitro")).toBeUndefined()

		// Cloudflare AI Gateway (HTTPS + binding) and Workers AI resolve configured secretHeaders,
		// fail auth when a required secret header is missing, and preserve Cloudflare auth-header precedence.
		const workersAiSpec = BUILTIN_PROVIDERS.find(
			(provider) => provider.id === "cloudflare-workers-ai",
		)!
		const gwWithSecrets = defineProvider({
			...gwSpec,
			headers: { "x-cf-route": "primary" },
			secretHeaders: {
				"x-cf-edge-token": "CF_EDGE_SECRET",
				"cf-aig-authorization": "EVIL_OVERRIDE",
			},
		})
		const workersWithSecrets = defineProvider({
			...workersAiSpec,
			headers: { "x-workers-route": "edge" },
			secretHeaders: {
				"x-cf-edge-token": "CF_EDGE_SECRET",
				Authorization: "EVIL_OVERRIDE",
			},
		})
		const missingSecretEnv = {
			CLOUDFLARE_GATEWAY_ID: "gw-sec",
			CLOUDFLARE_ACCOUNT_ID: "acct-sec",
			CLOUDFLARE_AI_API_KEY: "cf-real-key",
			EVIL_OVERRIDE: "Bearer evil",
		}
		expect(checkProviderCredentials(gwWithSecrets, { env: missingSecretEnv }).ok).toBe(false)
		expect(checkProviderCredentials(workersWithSecrets, { env: missingSecretEnv }).ok).toBe(false)
		const cfSecretMissingRegistry = createProviderModels({ env: {} })
		cfSecretMissingRegistry.setProvider(buildPiProvider(gwWithSecrets, { env: missingSecretEnv }))
		cfSecretMissingRegistry.setProvider(
			buildPiProvider(workersWithSecrets, { env: missingSecretEnv }),
		)
		expect(await cfSecretMissingRegistry.checkAuth("cloudflare-ai-gateway")).toBeUndefined()
		expect(await cfSecretMissingRegistry.checkAuth("cloudflare-workers-ai")).toBeUndefined()
		const cfSecretBindingMissingRegistry = createProviderModels({ env: {} })
		cfSecretBindingMissingRegistry.setProvider(
			buildPiProvider(gwWithSecrets, {
				env: { CLOUDFLARE_GATEWAY_ID: "gw-sec", EVIL_OVERRIDE: "Bearer evil" },
				aiBinding: { fetch: async () => new Response(compatSse, { status: 200 }) },
			}),
		)
		expect(await cfSecretBindingMissingRegistry.checkAuth("cloudflare-ai-gateway")).toBeUndefined()

		const fullSecretEnv = { ...missingSecretEnv, CF_EDGE_SECRET: "edge-token-123" }
		const cfSecretFullRegistry = createProviderModels({ env: {} })
		cfSecretFullRegistry.setProvider(buildPiProvider(gwWithSecrets, { env: fullSecretEnv }))
		cfSecretFullRegistry.setProvider(buildPiProvider(workersWithSecrets, { env: fullSecretEnv }))
		const gwEligibleModel = cfSecretFullRegistry.getModel(
			"cloudflare-ai-gateway",
			"workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
		)
		expect(gwEligibleModel).toBeDefined()
		const gwHttpsAuth = await cfSecretFullRegistry.getAuth(gwEligibleModel!)
		expect(gwHttpsAuth?.auth.headers).toMatchObject({
			"cf-aig-authorization": "Bearer cf-real-key",
			"x-cf-edge-token": "edge-token-123",
			"x-cf-route": "primary",
		})
		const workersEligibleModel = cfSecretFullRegistry.getModel(
			"cloudflare-workers-ai",
			"@cf/deepseek-ai/deepseek-v4.1-flash-1017",
		)
		expect(workersEligibleModel).toBeDefined()
		const workersSecretAuth = await cfSecretFullRegistry.getAuth(workersEligibleModel!)
		expect(workersSecretAuth?.auth.apiKey).toBe("cf-real-key")
		expect(workersSecretAuth?.auth.headers).toMatchObject({
			Authorization: "Bearer cf-real-key",
			"x-cf-edge-token": "edge-token-123",
			"x-workers-route": "edge",
		})
		const cfSecretBindingFullRegistry = createProviderModels({ env: {} })
		cfSecretBindingFullRegistry.setProvider(
			buildPiProvider(gwWithSecrets, {
				env: {
					CLOUDFLARE_GATEWAY_ID: "gw-sec",
					CF_EDGE_SECRET: "edge-token-123",
					EVIL_OVERRIDE: "Bearer evil",
				},
				aiBinding: { fetch: async () => new Response(compatSse, { status: 200 }) },
			}),
		)
		const gwBindingEligibleModel = cfSecretBindingFullRegistry.getModel(
			"cloudflare-ai-gateway",
			"workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
		)
		expect(gwBindingEligibleModel).toBeDefined()
		const gwBindingAuth = await cfSecretBindingFullRegistry.getAuth(gwBindingEligibleModel!)
		expect(gwBindingAuth?.auth.headers).toMatchObject({
			"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
			"x-cf-edge-token": "edge-token-123",
			"x-cf-route": "primary",
		})

		// Custom provider IDs using cloudflare_workers_ai or cloudflare_ai_gateway auth select
		// Cloudflare's origin guards by auth kind so per-request credentials & account IDs work.
		const customWorkersSpec = defineProvider({
			id: "my-workers-ai",
			name: "My Workers AI",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			auth: {
				kind: "cloudflare_workers_ai",
				apiKeyEnv: "MY_CF_AI_KEY",
				accountIdEnv: "MY_CF_ACCOUNT_ID",
			},
		})
		const customWorkersRegistry = createProviderModels({
			env: {},
			customProviders: [customWorkersSpec],
		})
		const customWorkersModel = customWorkersRegistry.getModel(
			"my-workers-ai",
			"@cf/deepseek-ai/deepseek-v4.1-flash-1017",
		)
		expect(customWorkersModel).toBeDefined()
		let customWorkersUrl = ""
		const customWorkersRes = await customWorkersRegistry.completeSimple(
			customWorkersModel!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "custom-wa-key",
				env: { MY_CF_ACCOUNT_ID: "custom-acct-77" },
				fetch: async (input) => {
					customWorkersUrl = String(input)
					return new Response(compatSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(customWorkersRes.stopReason).toBe("stop")
		expect(customWorkersUrl).toBe(
			"https://api.cloudflare.com/client/v4/accounts/custom-acct-77/ai/v1/chat/completions",
		)

		// Externally created providers (e.g. Pi's createProvider) are strictly static-only under
		// withDynamicModelLookup: registered eligible chat models are preserved, while unlisted
		// IDs, aliases, prefixed Gateway aliases, and non-chat models never trigger synthesis.
		const basePreloaded = createModels()
		basePreloaded.setProvider(
			createProvider({
				id: "openai",
				name: "OpenAI Preloaded Proxy",
				baseUrl: "https://preloaded-proxy.example/v1",
				api: { "openai-responses": createOpenAIResponsesWire() },
				auth: {
					apiKey: {
						name: "Preloaded Key",
						login: () => Promise.reject(new Error("unsupported")),
						resolve: () => Promise.resolve({ auth: { apiKey: "sk-preloaded" }, source: "test" }),
					},
				},
				models: [
					{
						id: "gpt-4o-mini",
						name: "Proxy GPT-4o mini",
						api: "openai-responses",
						provider: "openai",
						baseUrl: "https://preloaded-proxy.example/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 4096,
					},
					{
						id: "tiny-preloaded",
						name: "Tiny Preloaded",
						api: "openai-responses",
						provider: "openai",
						baseUrl: "https://preloaded-proxy.example/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 1024,
					},
					{
						id: "gpt-4o",
						name: "Capped Proxy GPT-4o",
						api: "openai-responses",
						provider: "openai",
						baseUrl: "https://preloaded-proxy.example/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 32_000,
						maxTokens: 4096,
					},
					{
						type: "image",
						id: "private-image-gen-v1",
						name: "Private Image Gen",
						api: "openrouter-images",
						provider: "openai",
						baseUrl: "https://preloaded-proxy.example/v1",
						input: ["text"],
						output: ["image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			}),
		)
		basePreloaded.setProvider(
			createProvider({
				id: "cloudflare-ai-gateway",
				name: "Pinned Gateway A",
				api: { "openai-responses": createOpenAIResponsesWire() },
				auth: {
					apiKey: {
						name: "Gateway A Key",
						login: () => Promise.reject(new Error("unsupported")),
						resolve: () => Promise.resolve({ auth: { apiKey: "cf-gw-a" }, source: "test" }),
					},
				},
				models: [
					{
						id: "gpt-4o",
						name: "Capped GW GPT-4o",
						api: "openai-responses",
						provider: "cloudflare-ai-gateway",
						baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-A/gw-A/openai",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 32_000,
						maxTokens: 4096,
					},
				],
			}),
		)
		const wrappedPreloaded = withDynamicModelLookup(basePreloaded, {
			env: { CLOUDFLARE_ACCOUNT_ID: "acct-B", CLOUDFLARE_GATEWAY_ID: "gw-B" },
		})
		expect(wrappedPreloaded.getModel("openai", "gpt-4o-mini")).toMatchObject({
			id: "gpt-4o-mini",
			baseUrl: "https://preloaded-proxy.example/v1",
			maxTokens: 4096,
		})
		expect(wrappedPreloaded.getModel("openai", "tiny-preloaded")).toBeUndefined()
		expect(wrappedPreloaded.getModel("openai", "gpt-4o")).toBeUndefined()
		expect(wrappedPreloaded.getModel("openai", "gpt-4o-mini-2024-07-18")).toBeUndefined()
		expect(wrappedPreloaded.getModel("openai", "ft:gpt-4o-mini:org:pilot:id")).toBeUndefined()
		expect(wrappedPreloaded.getModel("openai", "gpt-future-2027")).toBeUndefined()
		expect(wrappedPreloaded.getModel("openai", "private-image-gen-v1")).toBeUndefined()
		expect(wrappedPreloaded.getModel("openai", "private-image-gen-v1-2026-01-01")).toBeUndefined()
		expect(wrappedPreloaded.getModelOfType("image", "openai", "private-image-gen-v1")?.id).toBe(
			"private-image-gen-v1",
		)
		expect(wrappedPreloaded.getModel("cloudflare-ai-gateway", "gpt-4o")).toBeUndefined()
		expect(wrappedPreloaded.getModel("cloudflare-ai-gateway", "openai/gpt-4o")).toBeUndefined()
		expect(
			wrappedPreloaded.getModel(
				"cloudflare-ai-gateway",
				"workers-ai/@cf/meta/llama-3.2-3b-instruct",
			),
		).toBeUndefined()

		// Dynamic lookup with custom wire formats or scripted streams uses buildPiProvider,
		// preserving exact ProviderSpec rules, Responses-only format gating, and Gateway wire IDs.
		const openAiSpec = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai")!
		const completionsOpenAiRegistry = createProviderModels({ env: {} })
		completionsOpenAiRegistry.setProvider(
			buildPiProvider(
				{
					...openAiSpec,
					baseUrl: "https://completions-proxy.example/v1",
					defaultFormat: "openai-completions",
					formats: ["openai-completions"],
				},
				{ env: { OPENAI_API_KEY: "sk-proxy" } },
			),
		)
		expect(completionsOpenAiRegistry.getModel("openai", "gpt-future-2027")).toMatchObject({
			id: "gpt-future-2027",
			api: "openai-completions",
			baseUrl: "https://completions-proxy.example/v1",
		})
		expect(completionsOpenAiRegistry.getModel("openai", "gpt-4o-search-preview")).toMatchObject({
			id: "gpt-4o-search-preview",
			api: "openai-completions",
			baseUrl: "https://completions-proxy.example/v1",
		})
		expect(completionsOpenAiRegistry.getModel("openai", "gpt-audio-1.5")).toMatchObject({
			id: "gpt-audio-1.5",
			api: "openai-completions",
			baseUrl: "https://completions-proxy.example/v1",
		})
		expect(completionsOpenAiRegistry.getModel("openai", "text-embedding-3-small")).toBeUndefined()
		expect(completionsOpenAiRegistry.getModel("openai", "whisper-1")).toBeUndefined()
		expect(completionsOpenAiRegistry.getModel("openai", "gpt-image-1")).toBeUndefined()
		expect(completionsOpenAiRegistry.getModel("openai", "o1")).toBeUndefined()

		const scriptedBase = createModels()
		const dummyStreams = createOpenAICompletionsWire()
		scriptedBase.setProvider(
			buildPiProvider(
				gwSpec,
				{ env: { CLOUDFLARE_ACCOUNT_ID: "acct-scripted", CLOUDFLARE_GATEWAY_ID: "gw-scripted" } },
				{
					streams: dummyStreams,
					auth: {
						apiKey: {
							name: "Scripted GW",
							login: () => Promise.reject(new Error("unsupported")),
							resolve: () => Promise.resolve({ auth: { apiKey: "cf-scripted" }, source: "test" }),
						},
					},
				},
			),
		)
		const wrappedScripted = withDynamicModelLookup(scriptedBase, { env: {} })
		expect(
			wrappedScripted.getModel("cloudflare-ai-gateway", "openai/gpt-4o-2024-11-20"),
		).toMatchObject({
			id: "gpt-4o-2024-11-20",
			api: "openai-responses",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-scripted/gw-scripted/openai",
		})
		expect(
			wrappedScripted.getModel("cloudflare-ai-gateway", "anthropic/claude-sonnet-5-5-20260301"),
		).toMatchObject({
			id: "claude-sonnet-5-5-20260301",
			api: "anthropic-messages",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-scripted/gw-scripted/anthropic",
		})

		// Custom provider IDs using cloudflare_ai_gateway auth route by resolved wire format
		// (/anthropic, /openai, /compat) instead of posting native codecs to /compat.
		const customAnthGwSpec = defineProvider({
			id: "my-anthropic-gw",
			name: "My Anthropic Gateway",
			source: "custom",
			defaultFormat: "anthropic-messages",
			formats: ["anthropic-messages"],
			auth: {
				kind: "cloudflare_ai_gateway",
				apiKeyEnv: "MY_CF_AI_KEY",
				accountIdEnv: "MY_CF_ACCOUNT_ID",
				gatewayIdEnv: "MY_CF_GATEWAY_ID",
			},
		})
		const customOpenAiGwSpec = defineProvider({
			id: "my-openai-gw",
			name: "My OpenAI Gateway",
			source: "custom",
			defaultFormat: "openai-responses",
			formats: ["openai-responses"],
			auth: {
				kind: "cloudflare_ai_gateway",
				apiKeyEnv: "MY_CF_AI_KEY",
				accountIdEnv: "MY_CF_ACCOUNT_ID",
				gatewayIdEnv: "MY_CF_GATEWAY_ID",
			},
		})
		const customGwRegistry = createProviderModels({
			env: {
				MY_CF_AI_KEY: "cf-custom-gw-key",
				MY_CF_ACCOUNT_ID: "custom-acct-88",
				MY_CF_GATEWAY_ID: "custom-gw-88",
			},
			customProviders: [customAnthGwSpec, customOpenAiGwSpec],
		})
		const customAnthGwModel = customGwRegistry.getModel("my-anthropic-gw", "claude-sonnet-5-5")
		expect(customAnthGwModel).toMatchObject({
			id: "claude-sonnet-5-5",
			api: "anthropic-messages",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/custom-acct-88/custom-gw-88/anthropic",
		})
		const customGwAnthSse = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_custom_gw",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-5-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			})}\n\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
		].join("")
		let customAnthGwUrl = ""
		const customAnthGwRes = await customGwRegistry.completeSimple(
			customAnthGwModel!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (input) => {
					customAnthGwUrl = String(input)
					return new Response(customGwAnthSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(customAnthGwRes.stopReason).toBe("stop")
		const parsedCustomAnthGwUrl = new URL(customAnthGwUrl)
		expect(parsedCustomAnthGwUrl.origin).toBe("https://gateway.ai.cloudflare.com")
		expect(parsedCustomAnthGwUrl.pathname).toBe(
			"/v1/custom-acct-88/custom-gw-88/anthropic/v1/messages",
		)

		const customOpenAiGwModel = customGwRegistry.getModel("my-openai-gw", "gpt-6.2-sol")
		expect(customOpenAiGwModel).toMatchObject({
			id: "gpt-6.2-sol",
			api: "openai-responses",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/custom-acct-88/custom-gw-88/openai",
		})
		let customOpenAiGwUrl = ""
		const customOpenAiGwRes = await customGwRegistry.completeSimple(
			customOpenAiGwModel!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (input) => {
					customOpenAiGwUrl = String(input)
					return new Response(responsesSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(customOpenAiGwRes.stopReason).toBe("stop")
		expect(customOpenAiGwUrl).toBe(
			"https://gateway.ai.cloudflare.com/v1/custom-acct-88/custom-gw-88/openai/responses",
		)

		// Cloudflare AI Gateway /compat requires a provider-qualified upstream target
		// (`<upstream>/<model>`) and rejects unroutable bare IDs and malformed slashes.
		const gatewayRoutingRegistry = createProviderModels({ env: {} })
		for (const unroutable of [
			"cloudflare-ai-gateway/mistral-large-latest",
			"cloudflare-ai-gateway/gemini-2.5-pro",
			"cloudflare-ai-gateway/deepseek-chat",
			"cloudflare-ai-gateway//mistral-large-latest",
			"cloudflare-ai-gateway/mistral//mistral-large-latest",
		]) {
			expect(resolveModelSpecifier(unroutable), unroutable).toBeNull()
			expect(
				gatewayRoutingRegistry.getModel(
					"cloudflare-ai-gateway",
					unroutable.slice("cloudflare-ai-gateway/".length),
				),
				unroutable,
			).toBeUndefined()
		}
		expect(resolveModelSpecifier("cloudflare-ai-gateway/mistral/mistral-large-latest")).toEqual({
			provider: "cloudflare-ai-gateway",
			modelId: "mistral/mistral-large-latest",
			cataloged: false,
		})
		expect(
			gatewayRoutingRegistry.getModel("cloudflare-ai-gateway", "google-ai-studio/gemini-3-pro"),
		).toMatchObject({
			id: "google-ai-studio/gemini-3-pro",
			api: "openai-completions",
		})
		expect(
			gatewayRoutingRegistry.getModel("cloudflare-ai-gateway", "claude-future-7"),
		).toMatchObject({
			id: "claude-future-7",
			api: "anthropic-messages",
		})
		expect(
			gatewayRoutingRegistry.getModel("cloudflare-ai-gateway", "gpt-future-2027"),
		).toMatchObject({
			id: "gpt-future-2027",
			api: "openai-responses",
		})

		// Custom Cloudflare auth providers reject static baseUrl declarations during validation.
		const invalidStaticGwSpec = defineProvider({
			id: "bad-static-gw",
			name: "Bad Static Gateway",
			source: "custom",
			baseUrl: "https://proxy.example/v1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			auth: {
				kind: "cloudflare_ai_gateway",
				apiKeyEnv: "MY_CF_AI_KEY",
				accountIdEnv: "MY_CF_ACCOUNT_ID",
				gatewayIdEnv: "MY_CF_GATEWAY_ID",
			},
		})
		const invalidStaticWorkersSpec = defineProvider({
			id: "bad-static-workers",
			name: "Bad Static Workers AI",
			source: "custom",
			baseUrl: "https://proxy.example/v1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			auth: {
				kind: "cloudflare_workers_ai",
				apiKeyEnv: "MY_CF_AI_KEY",
				accountIdEnv: "MY_CF_ACCOUNT_ID",
			},
		})
		expect(() => createProviderModels({ env: {}, customProviders: [invalidStaticGwSpec] })).toThrow(
			/static baseUrl/i,
		)
		expect(() =>
			createProviderModels({ env: {}, customProviders: [invalidStaticWorkersSpec] }),
		).toThrow(/static baseUrl/i)
		expect(() =>
			resolveModelSpecifier("bad-static-gw/m1", { customProviders: [invalidStaticGwSpec] }),
		).toThrow(/static baseUrl/i)

		// Direct Workers AI specs reject wire formats incompatible with /ai/v1 Chat Completions.
		const invalidWorkersFormatSpec = defineProvider({
			id: "bad-workers-anth",
			name: "Bad Workers Anthropic",
			source: "custom",
			defaultFormat: "anthropic-messages",
			formats: ["anthropic-messages"],
			auth: {
				kind: "cloudflare_workers_ai",
				apiKeyEnv: "MY_CF_AI_KEY",
				accountIdEnv: "MY_CF_ACCOUNT_ID",
			},
		})
		const invalidWorkersMixedFormatSpec = defineProvider({
			id: "bad-workers-mixed",
			name: "Bad Workers Mixed",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions", "openai-responses"],
			auth: {
				kind: "cloudflare_workers_ai",
				apiKeyEnv: "MY_CF_AI_KEY",
				accountIdEnv: "MY_CF_ACCOUNT_ID",
			},
		})
		expect(() =>
			createProviderModels({ env: {}, customProviders: [invalidWorkersFormatSpec] }),
		).toThrow(/openai-completions/i)
		expect(() =>
			resolveModelSpecifier("bad-workers-anth/m1", {
				customProviders: [invalidWorkersFormatSpec],
			}),
		).toThrow(/openai-completions/i)
		expect(() =>
			createProviderModels({ env: {}, customProviders: [invalidWorkersMixedFormatSpec] }),
		).toThrow(/openai-completions/i)

		// OpenRouter embedding models (both indexed and Day-1 patterns) are excluded from chat
		// resolution on both direct OpenRouter and Gateway /compat routes.
		const embeddingCheckRegistry = createProviderModels({ env: {} })
		for (const embeddingSpec of [
			"openrouter/qwen/qwen3-embedding-8b",
			"openrouter/qwen/qwen3-embedding-8b:free",
			"cloudflare-ai-gateway/openrouter/qwen/qwen3-embedding-8b",
			"cloudflare-ai-gateway/openrouter/qwen/qwen3-embedding-8b:free",
			"openrouter/google/gemini-embedding-001",
			"cloudflare-ai-gateway/openrouter/google/gemini-embedding-001",
			"openrouter/mistralai/mistral-embed-2312",
			"cloudflare-ai-gateway/openrouter/mistralai/mistral-embed-2312",
			"openrouter/baai/bge-m3",
			"openrouter/new-vendor/future-embedding-2027",
			"cloudflare-ai-gateway/openrouter/new-vendor/future-embedding-2027",
		]) {
			expect(resolveModelSpecifier(embeddingSpec), embeddingSpec).toBeNull()
			const slash = embeddingSpec.indexOf("/")
			expect(
				embeddingCheckRegistry.getModel(
					embeddingSpec.slice(0, slash),
					embeddingSpec.slice(slash + 1),
				),
				embeddingSpec,
			).toBeUndefined()
		}

		// OpenRouter and Gateway Anthropic snapshots never inherit direct-Anthropic-only beta flags
		// (supportsMidConvoToolChanges, supportsMidConvoSystemMessages, supportsStrictTools, etc.).
		const proxyCompatRegistry = createProviderModels({ env: {} })
		const catalogedOrSonnet = proxyCompatRegistry.getModel(
			"openrouter",
			"anthropic/claude-sonnet-5.5",
		)
		const snapshotOrSonnet = proxyCompatRegistry.getModel(
			"openrouter",
			"anthropic/claude-sonnet-5.5-20260301",
		)
		expect(catalogedOrSonnet !== undefined && hasApi(catalogedOrSonnet, "anthropic-messages")).toBe(
			true,
		)
		expect(snapshotOrSonnet !== undefined && hasApi(snapshotOrSonnet, "anthropic-messages")).toBe(
			true,
		)
		if (
			catalogedOrSonnet !== undefined &&
			hasApi(catalogedOrSonnet, "anthropic-messages") &&
			snapshotOrSonnet !== undefined &&
			hasApi(snapshotOrSonnet, "anthropic-messages")
		) {
			expect(snapshotOrSonnet.contextWindow).toBe(catalogedOrSonnet.contextWindow)
			expect(snapshotOrSonnet.maxTokens).toBe(catalogedOrSonnet.maxTokens)
			expect(snapshotOrSonnet.compat).toEqual(catalogedOrSonnet.compat)
			expect(snapshotOrSonnet.compat?.supportsMidConvoToolChanges).toBeUndefined()
			expect(snapshotOrSonnet.compat?.supportsMidConvoSystemMessages).toBeUndefined()
			expect(snapshotOrSonnet.compat?.supportsStrictTools).toBeUndefined()
			expect(snapshotOrSonnet.compat?.allowedFallbackModels).toBeUndefined()
		}
		const snapshotGwSonnet = proxyCompatRegistry.getModel(
			"cloudflare-ai-gateway",
			"claude-sonnet-5-5-20260301",
		)
		expect(snapshotGwSonnet !== undefined && hasApi(snapshotGwSonnet, "anthropic-messages")).toBe(
			true,
		)
		if (snapshotGwSonnet !== undefined && hasApi(snapshotGwSonnet, "anthropic-messages")) {
			expect(snapshotGwSonnet.compat?.sendSessionAffinityHeaders).toBe(true)
			expect(snapshotGwSonnet.compat?.supportsMidConvoToolChanges).toBeUndefined()
			expect(snapshotGwSonnet.compat?.supportsMidConvoSystemMessages).toBeUndefined()
			expect(snapshotGwSonnet.compat?.supportsStrictTools).toBeUndefined()
			expect(snapshotGwSonnet.compat?.allowedFallbackModels).toBeUndefined()
		}
		const snapshotGwOpenAi = proxyCompatRegistry.getModel(
			"cloudflare-ai-gateway",
			"gpt-6.2-sol-2026-04-01",
		)
		expect(snapshotGwOpenAi !== undefined && hasApi(snapshotGwOpenAi, "openai-responses")).toBe(
			true,
		)
		if (snapshotGwOpenAi !== undefined && hasApi(snapshotGwOpenAi, "openai-responses")) {
			expect(snapshotGwOpenAi.compat?.supportsStrictMode).toBe(true)
			expect(snapshotGwOpenAi.compat?.supportsAdditionalTools).toBeUndefined()
			expect(snapshotGwOpenAi.compat?.supportsToolSearch).toBeUndefined()
			expect(snapshotGwOpenAi.compat?.supportsMidConvoSystemMessages).toBeUndefined()
		}

		// OpenRouter snapshots resolve against OpenRouter's own catalog first across native,
		// :variant, and Gateway routes so limits stay consistent (1M vs direct Anthropic's 200k).
		const orSnapshotDirect = proxyCompatRegistry.getModel(
			"openrouter",
			"anthropic/claude-sonnet-4.5-20250929",
		)
		const orSnapshotNitro = proxyCompatRegistry.getModel(
			"openrouter",
			"anthropic/claude-sonnet-4.5-20250929:nitro",
		)
		const orSnapshotFree = proxyCompatRegistry.getModel(
			"openrouter",
			"anthropic/claude-sonnet-4.5-20250929:free",
		)
		const gwOrSnapshot = proxyCompatRegistry.getModel(
			"cloudflare-ai-gateway",
			"openrouter/anthropic/claude-sonnet-4.5-20250929",
		)
		const gwOrSnapshotNitro = proxyCompatRegistry.getModel(
			"cloudflare-ai-gateway",
			"openrouter/anthropic/claude-sonnet-4.5-20250929:nitro",
		)
		const gwOrSnapshotFree = proxyCompatRegistry.getModel(
			"cloudflare-ai-gateway",
			"openrouter/anthropic/claude-sonnet-4.5-20250929:free",
		)
		expect(orSnapshotDirect).toMatchObject({
			id: "anthropic/claude-sonnet-4.5-20250929",
			api: "anthropic-messages",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		})
		expect(orSnapshotNitro).toMatchObject({
			id: "anthropic/claude-sonnet-4.5-20250929:nitro",
			api: "openai-completions",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		})
		expect(orSnapshotFree).toMatchObject({
			id: "anthropic/claude-sonnet-4.5-20250929:free",
			api: "openai-completions",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})
		expect(gwOrSnapshot).toMatchObject({
			id: "openrouter/anthropic/claude-sonnet-4.5-20250929",
			api: "openai-completions",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		})
		expect(gwOrSnapshotNitro).toMatchObject({
			id: "openrouter/anthropic/claude-sonnet-4.5-20250929:nitro",
			api: "openai-completions",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		})
		expect(gwOrSnapshotFree).toMatchObject({
			id: "openrouter/anthropic/claude-sonnet-4.5-20250929:free",
			api: "openai-completions",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})
		for (const spec of [
			"openrouter/anthropic/claude-sonnet-4.5-20250929",
			"openrouter/anthropic/claude-sonnet-4.5-20250929:nitro",
			"cloudflare-ai-gateway/openrouter/anthropic/claude-sonnet-4.5-20250929",
			"cloudflare-ai-gateway/openrouter/anthropic/claude-sonnet-4.5-20250929:nitro",
		]) {
			const slash = spec.indexOf("/")
			expect(resolveModelSpecifier(spec, { minContextWindow: 500_000 }), spec).toEqual({
				provider: spec.slice(0, slash),
				modelId: spec.slice(slash + 1),
				cataloged: false,
			})
		}

		// Known Workers AI fallback models expose Cloudflare's published context windows and
		// per-model reasoning/input capabilities through both direct and Gateway lookup.
		const workersFallbackDefault = createProviderModels({ env: {} })
		expect(
			workersFallbackDefault.getModel("cloudflare-workers-ai", "@cf/meta/llama-3.2-3b-instruct"),
		).toMatchObject({
			id: "@cf/meta/llama-3.2-3b-instruct",
			contextWindow: 80_000,
			reasoning: false,
			input: ["text"],
		})
		expect(
			workersFallbackDefault.getModel(
				"cloudflare-ai-gateway",
				"workers-ai/@cf/meta/llama-3.2-3b-instruct",
			),
		).toMatchObject({
			id: "workers-ai/@cf/meta/llama-3.2-3b-instruct",
			contextWindow: 80_000,
			reasoning: false,
			input: ["text"],
		})
		expect(
			resolveModelSpecifier("cloudflare-workers-ai/@cf/meta/llama-3.2-3b-instruct", {
				minContextWindow: 100_000,
			}),
		).toBeNull()
		expect(
			workersFallbackDefault.getModel(
				"cloudflare-workers-ai",
				"@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
			),
		).toMatchObject({
			id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
			contextWindow: 80_000,
			reasoning: true,
			input: ["text"],
		})
		expect(
			workersFallbackDefault.getModel(
				"cloudflare-ai-gateway",
				"workers-ai/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
			),
		).toMatchObject({
			id: "workers-ai/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
			contextWindow: 80_000,
			reasoning: true,
			input: ["text"],
		})
		expect(
			workersFallbackDefault.getModel("cloudflare-workers-ai", "@cf/google/gemma-3-12b-it"),
		).toMatchObject({
			id: "@cf/google/gemma-3-12b-it",
			contextWindow: 80_000,
			reasoning: false,
			input: ["text", "image"],
		})
		expect(
			workersFallbackDefault.getModel(
				"cloudflare-ai-gateway",
				"workers-ai/@cf/google/gemma-3-12b-it",
			),
		).toMatchObject({
			id: "workers-ai/@cf/google/gemma-3-12b-it",
			contextWindow: 80_000,
			reasoning: false,
			input: ["text", "image"],
		})
		expect(
			resolveModelSpecifier("cloudflare-workers-ai/@cf/mistral/mistral-7b-instruct-v0.2-lora", {
				minContextWindow: 16_000,
			}),
		).toBeNull()
		expect(
			resolveModelSpecifier(
				"cloudflare-ai-gateway/workers-ai/@cf/mistral/mistral-7b-instruct-v0.2-lora",
				{ minContextWindow: 16_000 },
			),
		).toBeNull()
		const workersFallbackLowFloor = createProviderModels({ env: {}, minContextWindow: 8192 })
		expect(
			workersFallbackLowFloor.getModel(
				"cloudflare-workers-ai",
				"@cf/mistral/mistral-7b-instruct-v0.2-lora",
			),
		).toMatchObject({
			id: "@cf/mistral/mistral-7b-instruct-v0.2-lora",
			contextWindow: 15_000,
			reasoning: false,
			input: ["text"],
		})
		expect(
			workersFallbackLowFloor.getModel(
				"cloudflare-ai-gateway",
				"workers-ai/@cf/mistral/mistral-7b-instruct-v0.2-lora",
			),
		).toMatchObject({
			id: "workers-ai/@cf/mistral/mistral-7b-instruct-v0.2-lora",
			contextWindow: 15_000,
			reasoning: false,
			input: ["text"],
		})

		// Unlisted OpenRouter :free variants zero out paid base-model pricing (including tiers)
		// while preserving base capabilities across both direct OpenRouter and Gateway /compat.
		expect(getOpenRouterCatalogEntry("google/gemini-2.5-pro:free")).toBeUndefined()
		const paidGemini = workersFallbackDefault.getModel("openrouter", "google/gemini-2.5-pro")
		const freeGemini = workersFallbackDefault.getModel("openrouter", "google/gemini-2.5-pro:free")
		const nitroGemini = workersFallbackDefault.getModel("openrouter", "google/gemini-2.5-pro:nitro")
		const gwFreeGemini = workersFallbackDefault.getModel(
			"cloudflare-ai-gateway",
			"openrouter/google/gemini-2.5-pro:free",
		)
		expect(paidGemini?.cost.input).toBeGreaterThan(0)
		expect(nitroGemini?.cost.input).toBe(paidGemini?.cost.input)
		expect(freeGemini).toMatchObject({
			id: "google/gemini-2.5-pro:free",
			contextWindow: paidGemini?.contextWindow,
			maxTokens: paidGemini?.maxTokens,
			reasoning: paidGemini?.reasoning,
			input: paidGemini?.input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})
		expect(freeGemini?.cost.tiers).toBeUndefined()
		expect(gwFreeGemini).toMatchObject({
			id: "openrouter/google/gemini-2.5-pro:free",
			contextWindow: paidGemini?.contextWindow,
			maxTokens: paidGemini?.maxTokens,
			reasoning: paidGemini?.reasoning,
			input: paidGemini?.input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})
		expect(gwFreeGemini?.cost.tiers).toBeUndefined()
		const freeUpstreamO1 = workersFallbackDefault.getModel("openrouter", "openai/o1:free")
		const gwFreeUpstreamO1 = workersFallbackDefault.getModel(
			"cloudflare-ai-gateway",
			"openrouter/openai/o1:free",
		)
		expect(freeUpstreamO1).toMatchObject({
			id: "openai/o1:free",
			contextWindow: 200_000,
			reasoning: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})
		expect(gwFreeUpstreamO1).toMatchObject({
			id: "openrouter/openai/o1:free",
			contextWindow: 200_000,
			reasoning: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})
	})

	it("blocks HTTP redirects and cross-origin requests", async () => {
		const guarded = createNoRedirectProviderFetch(
			"https://api.example.com/v1",
			async () =>
				new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
		)
		await expect(guarded("https://api.example.com/v1/responses")).rejects.toThrow(/redirect/i)
		await expect(guarded("https://other.example.com/v1/responses")).rejects.toThrow(
			/disallowed origin/i,
		)
	})

	it("applies dynamic lookup, context floor, listing, and provider removal consistently", async () => {
		const smallCustom = defineProvider({
			id: "small-custom",
			name: "Small Custom",
			source: "custom",
			defaultModel: "small-custom/tiny",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://small.example/v1",
			auth: { kind: "none" },
			modelDefaults: { contextWindow: 32_000 },
			models: {
				large: { contextWindow: 256_000 },
			},
		})

		expect(
			resolveModelSpecifier("openai/gpt-future-2027", { minContextWindow: 200_000 }),
		).toBeNull()
		expect(
			resolveModelSpecifier("small-custom/tiny", { customProviders: [smallCustom] }),
		).toBeNull()
		expect(
			resolveModelSpecifier("small-custom/large", {
				customProviders: [smallCustom],
				minContextWindow: 200_000,
			}),
		).toEqual({ provider: "small-custom", modelId: "large", cataloged: true })

		const lockedCustom = defineProvider({
			id: "locked-custom",
			name: "Locked Custom",
			source: "custom",
			defaultModel: "locked-custom/foo",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://locked.example/v1",
			auth: { kind: "none" },
			allowUnlistedModels: false,
			models: {
				foo: { contextWindow: 128_000, maxTokens: 8192 },
				tiny: { contextWindow: 32_000 },
			},
		})
		expect(resolveModelSpecifier("locked-custom/foo", { customProviders: [lockedCustom] })).toEqual(
			{ provider: "locked-custom", modelId: "foo", cataloged: true },
		)
		expect(
			resolveModelSpecifier("locked-custom/bar", { customProviders: [lockedCustom] }),
		).toBeNull()
		expect(
			resolveModelSpecifier("locked-custom/tiny", { customProviders: [lockedCustom] }),
		).toBeNull()
		expect(
			resolveModelSpecifier("locked-custom/constructor", { customProviders: [lockedCustom] }),
		).toBeNull()

		const lockedModels = createProviderModels({
			env: {},
			customProviders: [lockedCustom],
		})
		expect(lockedModels.getModel("locked-custom", "foo")).toMatchObject({
			id: "foo",
			contextWindow: 128_000,
			maxTokens: 8192,
		})
		expect(lockedModels.getModelOfType("chat", "locked-custom", "foo")?.id).toBe("foo")
		expect(lockedModels.getModel("locked-custom", "bar")).toBeUndefined()
		expect(lockedModels.getModel("locked-custom", "tiny")).toBeUndefined()
		expect(lockedModels.getModel("locked-custom", "constructor")).toBeUndefined()
		expect(lockedModels.getModels("locked-custom").map((model) => model.id)).toEqual(["foo"])
		expect((await lockedModels.getAvailable("locked-custom")).map((model) => model.id)).toEqual([
			"foo",
		])
		expect(lockedModels.getModels("openai").some((model) => model.id === "gpt-4")).toBe(false)
		expect(lockedModels.getModels("openai").some((model) => model.id === "gpt-4o-mini")).toBe(true)

		expect(resolveModelSpecifier("openai/ft:gpt-4:org:pilot:id")).toBeNull()
		expect(resolveModelSpecifier("openai/ft:gpt-4-0613:org:pilot:id")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-2024-04-09")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-0613")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-0314")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-32k")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-32k-0613")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-3.5-turbo")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-3.5-turbo-0125")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-3.5-turbo-0613")).toBeNull()
		for (const nonChat of [
			"openai/text-embedding-3-small",
			"openai/text-embedding-3-large",
			"openai/text-embedding-ada-002",
			"openai/whisper-1",
			"openai/gpt-4o-transcribe",
			"openai/tts-1",
			"openai/gpt-4o-mini-tts",
			"openai/gpt-4o-realtime-preview",
			"openai/dall-e-3",
			"openai/sora-2",
			"openai/omni-moderation-latest",
			"openai/babbage-002",
		]) {
			expect(resolveModelSpecifier(nonChat), nonChat).toBeNull()
			expect(
				lockedModels.getModel("openai", nonChat.slice("openai/".length)),
				nonChat,
			).toBeUndefined()
		}
		expect(resolveModelSpecifier("openai/ft:gpt-4o-mini:org:pilot:id")).toEqual({
			provider: "openai",
			modelId: "ft:gpt-4o-mini:org:pilot:id",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/gpt-4-turbo-2024-04-09")).toEqual({
			provider: "openai",
			modelId: "gpt-4-turbo-2024-04-09",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/gpt-4-0125-preview")).toEqual({
			provider: "openai",
			modelId: "gpt-4-0125-preview",
			cataloged: false,
		})
		expect(resolveModelSpecifier("anthropic/claude-sonnet-4-6-20260301")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6-20260301",
			cataloged: false,
		})
		const openAIFineTune = lockedModels.getModel("openai", "ft:gpt-4o-mini:org:pilot:id")
		expect(openAIFineTune).toMatchObject({
			id: "ft:gpt-4o-mini:org:pilot:id",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 16_384,
		})
		expect(lockedModels.getModel("openai", "gpt-4-2024-04-09")).toBeUndefined()
		expect(lockedModels.getModel("openai", "gpt-4-0613")).toBeUndefined()
		expect(lockedModels.getModel("openai", "gpt-4-32k-0613")).toBeUndefined()
		expect(lockedModels.getModel("openai", "gpt-3.5-turbo-0125")).toBeUndefined()
		const gpt4TurboSnapshot = lockedModels.getModel("openai", "gpt-4-turbo-2024-04-09")
		expect(gpt4TurboSnapshot).toMatchObject({
			id: "gpt-4-turbo-2024-04-09",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 4096,
		})
		expect(lockedModels.getModel("openai", "gpt-4-0125-preview")).toMatchObject({
			id: "gpt-4-0125-preview",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 4096,
		})
		const sonnetBase = lockedModels.getModel("anthropic", "claude-sonnet-4-6")!
		const sonnetSnapshot = lockedModels.getModel("anthropic", "claude-sonnet-4-6-20260301")
		expect(sonnetSnapshot).toMatchObject({
			id: "claude-sonnet-4-6-20260301",
			contextWindow: sonnetBase.contextWindow,
			maxTokens: sonnetBase.maxTokens,
			reasoning: sonnetBase.reasoning,
		})

		let snapshotRequestBody: object | undefined
		const openAIModels = createProviderModels({ env: { OPENAI_API_KEY: "sk-test" } })
		const snapshotWireModel = openAIModels.getModel("openai", "gpt-4-turbo-2024-04-09")!
		await openAIModels.completeSimple(
			snapshotWireModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (_input, init) => {
					const parsed: unknown = JSON.parse(String(init?.body ?? "{}"))
					if (typeof parsed === "object" && parsed !== null) {
						snapshotRequestBody = parsed
					}
					return new Response(
						[
							`data: ${JSON.stringify({
								type: "response.completed",
								response: {
									id: "resp_snap",
									status: "completed",
									output: [
										{
											type: "message",
											role: "assistant",
											content: [{ type: "output_text", text: "ok" }],
										},
									],
									usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
								},
							})}\n\n`,
						].join(""),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					)
				},
			},
		)
		expect(snapshotRequestBody).toMatchObject({ model: "gpt-4-turbo-2024-04-09" })
		expect(snapshotRequestBody).not.toHaveProperty("reasoning")
		expect(
			snapshotRequestBody !== undefined &&
				"max_output_tokens" in snapshotRequestBody &&
				typeof snapshotRequestBody.max_output_tokens === "number" &&
				snapshotRequestBody.max_output_tokens <= 4096,
		).toBe(true)

		const protoNamed = defineProvider({
			id: "constructor",
			name: "Constructor Provider",
			source: "custom",
			defaultModel: "constructor/model-1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://ctor.example/v1",
			auth: { kind: "none" },
		})
		const protoModels = createProviderModels({
			env: { OPENAI_API_KEY: "sk-test" },
			baseUrlOverrides: { openai: null },
			customProviders: [protoNamed],
		})
		expect(protoModels.getModel("constructor", "model-1")).toMatchObject({
			id: "model-1",
			provider: "constructor",
			baseUrl: "https://ctor.example/v1",
		})
		expect(protoModels.getModel("openai", "gpt-4o-mini")?.id).toBe("gpt-4o-mini")

		const strictModels = createProviderModels({
			env: { OPENAI_API_KEY: "sk-test" },
			customProviders: [smallCustom],
			minContextWindow: 200_000,
		})
		expect(strictModels.getModel("openai", "gpt-future-2027")).toBeUndefined()
		expect(strictModels.getModelOfType("chat", "openai", "gpt-future-2027")).toBeUndefined()
		expect(strictModels.getModel("small-custom", "tiny")).toBeUndefined()
		expect(strictModels.getModel("small-custom", "large")?.contextWindow).toBe(256_000)
		expect(strictModels.getModelOfType("chat", "small-custom", "large")?.contextWindow).toBe(
			256_000,
		)

		const models = createProviderModels({
			env: { OPENAI_API_KEY: "sk-test" },
		})
		expect(models.getModel("openai", "gpt-4")).toBeUndefined()
		expect(models.getModelOfType("chat", "openai", "gpt-4")).toBeUndefined()
		expect(models.getModel("openai", "gpt-future-2027")?.id).toBe("gpt-future-2027")
		expect(models.getModelOfType("chat", "openai", "gpt-future-2027")?.id).toBe("gpt-future-2027")

		const replaceable = defineProvider({
			id: "acme",
			name: "Acme Old",
			source: "custom",
			defaultModel: "acme/old-model",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://old.acme.example/v1",
			auth: { kind: "bearer", env: "ACME_KEY", label: "Acme key" },
		})
		const replaceableModels = createProviderModels({
			env: { ACME_KEY: "old-secret" },
			customProviders: [replaceable],
		})
		expect(replaceableModels.getModel("acme", "unlisted-before")?.baseUrl).toBe(
			"https://old.acme.example/v1",
		)
		replaceableModels.setProvider(
			createProvider({
				id: "acme",
				name: "Acme New",
				baseUrl: "https://new.acme.example/v1",
				auth: {
					apiKey: {
						name: "Acme New Key",
						login: () => Promise.reject(new Error("unsupported")),
						resolve: () => Promise.resolve({ auth: { apiKey: "new-secret" }, source: "test" }),
					},
				},
				api: { "openai-completions": createOpenAICompletionsWire() },
				models: [
					{
						id: "new-model",
						name: "New Model",
						api: "openai-completions",
						provider: "acme",
						baseUrl: "https://new.acme.example/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8192,
					},
					{
						id: "too-small",
						name: "Too Small",
						api: "openai-completions",
						provider: "acme",
						baseUrl: "https://new.acme.example/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 2048,
					},
				],
			}),
		)
		expect(replaceableModels.getModel("acme", "new-model")?.baseUrl).toBe(
			"https://new.acme.example/v1",
		)
		expect(replaceableModels.getModel("acme", "too-small")).toBeUndefined()
		expect(replaceableModels.getModels("acme").map((model) => model.id)).toEqual(["new-model"])
		expect(replaceableModels.getModelsOfType("chat", "acme").map((model) => model.id)).toEqual([
			"new-model",
		])
		expect(replaceableModels.getAllModels("acme").map((model) => model.id)).toEqual(["new-model"])
		expect((await replaceableModels.getAvailable("acme")).map((model) => model.id)).toEqual([
			"new-model",
		])
		expect(
			(await replaceableModels.getAvailableOfType("chat", "acme")).map((model) => model.id),
		).toEqual(["new-model"])
		expect((await replaceableModels.getAllAvailable("acme")).map((model) => model.id)).toEqual([
			"new-model",
		])
		expect(replaceableModels.getModel("acme", "unlisted-after")).toBeUndefined()
		expect(replaceableModels.getModelOfType("chat", "acme", "unlisted-after")).toBeUndefined()

		const dupA = defineProvider({
			id: "dup",
			name: "Dup A",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://a.dup.example/v1",
			auth: { kind: "bearer", env: "DUP_A_KEY", label: "Dup A" },
		})
		const dupB = defineProvider({
			id: "dup",
			name: "Dup B",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://b.dup.example/v1",
			auth: { kind: "bearer", env: "DUP_B_KEY", label: "Dup B" },
		})
		const builtinCollision = defineProvider({
			id: "openai",
			name: "Fake OpenAI",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://fake.example/v1",
			auth: { kind: "none" },
		})
		expect(() =>
			createProviderModels({
				env: { DUP_A_KEY: "a", DUP_B_KEY: "b" },
				customProviders: [dupA, dupB],
			}),
		).toThrow(/Duplicate custom provider id "dup"/)
		expect(() =>
			createProviderModels({
				env: {},
				customProviders: [builtinCollision],
			}),
		).toThrow(/collides with a built-in provider/)
		expect(() => resolveModelSpecifier("dup/m1", { customProviders: [dupA, dupB] })).toThrow(
			/Duplicate custom provider id "dup"/,
		)

		models.deleteProvider("openai")
		expect(models.getModel("openai", "gpt-future-2027")).toBeUndefined()
		expect(models.getModelOfType("chat", "openai", "gpt-future-2027")).toBeUndefined()
		expect(models.getModel("anthropic", "claude-future-6")?.id).toBe("claude-future-6")
		models.clearProviders()
		expect(models.getModel("anthropic", "claude-future-6")).toBeUndefined()
		expect(models.getModelOfType("chat", "anthropic", "claude-future-6")).toBeUndefined()
	})

	it("preserves explicit Authorization and secondary secret headers without clobbering defaults", async () => {
		const authHeaderProvider = defineProvider({
			id: "auth-hdr",
			name: "Auth Header",
			source: "custom",
			defaultModel: "auth-hdr/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://auth-hdr.example/v1",
			auth: { kind: "api_key_header", header: "Authorization", env: "RAW_AUTH_KEY", label: "Key" },
			secretHeaders: { "x-api-key": "SECONDARY_KEY" },
		})
		const dualSecretProvider = defineProvider({
			id: "dual-hdr",
			name: "Dual Header",
			source: "custom",
			defaultModel: "dual-hdr/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://dual-hdr.example/v1",
			auth: { kind: "api_key_header", header: "x-corp-key", env: "CORP_KEY", label: "Corp Key" },
			secretHeaders: { authorization: "PROXY_BEARER" },
		})
		const noneWithAuthSecret = defineProvider({
			id: "none-proxy",
			name: "None Proxy",
			source: "custom",
			defaultModel: "none-proxy/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://none-proxy.example/v1",
			auth: { kind: "none" },
			secretHeaders: { authorization: "PROXY_BEARER" },
		})

		const models = createProviderModels({
			env: {
				RAW_AUTH_KEY: "ApiKey raw-secret",
				SECONDARY_KEY: "sec-x-api-key",
				CORP_KEY: "corp-secret",
				PROXY_BEARER: "Bearer proxy-tok",
			},
			customProviders: [authHeaderProvider, dualSecretProvider, noneWithAuthSecret],
		})

		const sse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_auth",
				object: "chat.completion.chunk",
				created: 1,
				model: "m1",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_auth",
				object: "chat.completion.chunk",
				created: 1,
				model: "m1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const captureHeaders = async (providerId: string): Promise<Headers> => {
			let captured: Headers | undefined
			const model = models.getModel(providerId, "m1")!
			const result = await models.complete(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						captured = new Headers(init?.headers)
						return new Response(sse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(result.stopReason).toBe("stop")
			return captured!
		}

		const authHeaders = await captureHeaders("auth-hdr")
		expect(authHeaders.get("authorization")).toBe("ApiKey raw-secret")
		expect(authHeaders.get("x-api-key")).toBe("sec-x-api-key")

		const dualHeaders = await captureHeaders("dual-hdr")
		expect(dualHeaders.get("x-corp-key")).toBe("corp-secret")
		expect(dualHeaders.get("authorization")).toBe("Bearer proxy-tok")

		const noneHeaders = await captureHeaders("none-proxy")
		expect(noneHeaders.get("authorization")).toBe("Bearer proxy-tok")
		expect(noneHeaders.get("x-api-key")).toBeNull()

		const copilotAnthropic = defineProvider({
			id: "github-copilot",
			name: "Custom Copilot Proxy",
			source: "custom",
			defaultModel: "github-copilot/claude-custom",
			defaultFormat: "anthropic-messages",
			formats: ["anthropic-messages"],
			baseUrl: "https://copilot-proxy.example",
			auth: { kind: "api_key_header", header: "x-api-key", env: "COPILOT_PROXY_KEY", label: "Key" },
		})
		const oatTokenAnthropic = defineProvider({
			id: "oat-proxy",
			name: "OAT Proxy",
			source: "custom",
			defaultModel: "oat-proxy/claude-custom",
			defaultFormat: "anthropic-messages",
			formats: ["anthropic-messages"],
			baseUrl: "https://oat-proxy.example",
			auth: { kind: "api_key_header", header: "x-api-key", env: "OAT_PROXY_KEY", label: "Key" },
		})
		const anthModels = createProviderModels({
			env: {
				COPILOT_PROXY_KEY: "copilot-x-api-secret",
				OAT_PROXY_KEY: "sk-ant-oat01-proxy-secret",
			},
			customProviders: [copilotAnthropic, oatTokenAnthropic],
		})
		const anthSse = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-custom",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			})}\n\n`,
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			})}\n\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "ok" },
			})}\n\n`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			})}\n\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
		].join("")

		for (const [providerId, expectedKey] of [
			["github-copilot", "copilot-x-api-secret"],
			["oat-proxy", "sk-ant-oat01-proxy-secret"],
		] as const) {
			let captured: Headers | undefined
			const model = anthModels.getModel(providerId, "claude-custom")!
			const result = await anthModels.complete(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						captured = new Headers(init?.headers)
						return new Response(anthSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(result.stopReason).toBe("stop")
			expect(captured?.get("x-api-key")).toBe(expectedKey)
			expect(captured?.get("authorization")).toBeNull()
		}

		const bearerCustom = defineProvider({
			id: "bearer-override",
			name: "Bearer Override",
			source: "custom",
			defaultModel: "bearer-override/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://bearer-override.example/v1",
			auth: { kind: "bearer", env: "BEARER_OVERRIDE_KEY", label: "Key" },
			secretHeaders: { "x-gw-secret": "BEARER_GW_SECRET" },
		})
		const withEnvModels = createProviderModels({
			env: { BEARER_OVERRIDE_KEY: "env-key", BEARER_GW_SECRET: "gw-sec" },
			customProviders: [bearerCustom, copilotAnthropic],
		})
		const withoutEnvModels = createProviderModels({
			env: { BEARER_GW_SECRET: "gw-sec" },
			customProviders: [bearerCustom, copilotAnthropic],
		})
		for (const registry of [withEnvModels, withoutEnvModels]) {
			let capturedBearer: Headers | undefined
			const bModel = registry.getModel("bearer-override", "m1")!
			const bRes = await registry.completeSimple(
				bModel,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					apiKey: "request-replacement-bearer",
					fetch: async (_input, init) => {
						capturedBearer = new Headers(init?.headers)
						return new Response(sse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(bRes.stopReason).toBe("stop")
			expect(capturedBearer?.get("authorization")).toBe("Bearer request-replacement-bearer")
			expect(capturedBearer?.get("x-gw-secret")).toBe("gw-sec")

			let capturedAnth: Headers | undefined
			const aModel = registry.getModel("github-copilot", "claude-custom")!
			const aRes = await registry.completeSimple(
				aModel,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					apiKey: "sk-ant-oat01-request-override",
					fetch: async (_input, init) => {
						capturedAnth = new Headers(init?.headers)
						return new Response(anthSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(aRes.stopReason).toBe("stop")
			expect(capturedAnth?.get("x-api-key")).toBe("sk-ant-oat01-request-override")
			expect(capturedAnth?.get("authorization")).toBeNull()
		}

		const sessionA = createProviderModels({ env: { OPENAI_API_KEY: "sk-a" } })
		const sessionB = createProviderModels({ env: { OPENAI_API_KEY: "sk-b" } })
		expect(sessionA.getModels("openai")[0]).toBe(sessionB.getModels("openai")[0])

		const oldEndpointSpec = defineProvider({
			id: "acme-pin",
			name: "Acme Old",
			source: "custom",
			defaultModel: "acme-pin/chat",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://old.acme-pin.example/v1",
			auth: { kind: "bearer", env: "ACME_PIN_KEY", label: "Key" },
		})
		const newOriginSpec = defineProvider({
			...oldEndpointSpec,
			name: "Acme New",
			baseUrl: "https://new.acme-pin.example/v1",
		})
		const newPathSpec = defineProvider({
			...oldEndpointSpec,
			name: "Acme New Path",
			baseUrl: "https://old.acme-pin.example/tenant-b/v1",
		})
		const oldRegistry = createProviderModels({
			env: { ACME_PIN_KEY: "old-secret" },
			customProviders: [oldEndpointSpec],
		})
		const staleModel = oldRegistry.getModel("acme-pin", "chat")!

		const newOriginRegistry = createProviderModels({
			env: { ACME_PIN_KEY: "new-secret" },
			customProviders: [newOriginSpec],
		})
		let leakedFetchCalls = 0
		const originRejected = await newOriginRegistry.complete(
			staleModel,
			{ messages: [{ role: "user", content: "secret prompt", timestamp: 0 }] },
			{
				fetch: async () => {
					leakedFetchCalls += 1
					return new Response(sse, { status: 200 })
				},
			},
		)
		expect(originRejected.stopReason).toBe("error")
		expect(originRejected.errorMessage).toMatch(/disallowed origin/i)
		expect(leakedFetchCalls).toBe(0)

		oldRegistry.setProvider(
			buildPiProvider(newPathSpec, { env: { ACME_PIN_KEY: "new-path-secret" } }),
		)
		const pathRejected = await oldRegistry.complete(
			staleModel,
			{ messages: [{ role: "user", content: "secret prompt", timestamp: 0 }] },
			{
				fetch: async () => {
					leakedFetchCalls += 1
					return new Response(sse, { status: 200 })
				},
			},
		)
		expect(pathRejected.stopReason).toBe("error")
		expect(pathRejected.errorMessage).toMatch(/mismatched endpoint/i)
		expect(leakedFetchCalls).toBe(0)

		const openAiModel = sessionA.getModel("openai", "gpt-4o-mini")!
		sessionA.setProvider(
			createProvider({
				id: "openai-pinned",
				name: "OpenAI Pinned",
				baseUrl: "https://api.openai.com/v1",
				api: {
					"openai-responses": createOpenAIResponsesWire({
						allowedOrigins: ["https://api.openai.com"],
					}),
				},
				auth: {
					apiKey: {
						name: "OpenAI Pinned",
						login: () => Promise.reject(new Error("unsupported")),
						resolve: () => Promise.resolve({ auth: { apiKey: "sk-pinned" }, source: "test" }),
					},
				},
				models: [{ ...openAiModel, provider: "openai-pinned" }],
			}),
		)
		const forgedBuiltIn = await sessionA.complete(
			{ ...openAiModel, provider: "openai-pinned", baseUrl: "https://evil.example/v1" },
			{ messages: [{ role: "user", content: "secret prompt", timestamp: 0 }] },
			{
				fetch: async () => {
					leakedFetchCalls += 1
					return new Response("", { status: 200 })
				},
			},
		)
		expect(forgedBuiltIn.stopReason).toBe("error")
		expect(forgedBuiltIn.errorMessage).toMatch(/disallowed origin/i)
		expect(leakedFetchCalls).toBe(0)

		const tenantASpec = defineProvider({
			id: "acme-rot",
			name: "Acme Rot A",
			source: "custom",
			defaultModel: "acme-rot/chat",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://shared.acme-rot.example/v1",
			auth: { kind: "bearer", env: "ACME_ROT_KEY", label: "Key" },
			headers: { "x-tenant": "tenant-a", "x-legacy-flag": "enabled" },
			secretHeaders: { "x-gw-secret": "ACME_ROT_GW" },
		})
		const tenantBSpec = defineProvider({
			...tenantASpec,
			name: "Acme Rot B",
			headers: { "x-tenant": "tenant-b" },
		})
		const rotRegistry = createProviderModels({
			env: { ACME_ROT_KEY: "old-key", ACME_ROT_GW: "old-gw-secret" },
			customProviders: [tenantASpec],
		})
		const retainedSameUrlModel = rotRegistry.getModel("acme-rot", "chat")!
		expect(retainedSameUrlModel.headers).toBeUndefined()

		rotRegistry.setProvider(
			buildPiProvider(tenantBSpec, {
				env: { ACME_ROT_KEY: "new-key", ACME_ROT_GW: "new-gw-secret" },
			}),
		)
		const rotatedAuth = await rotRegistry.getAuth(retainedSameUrlModel)
		expect(rotatedAuth?.auth.headers).toMatchObject({
			Authorization: "Bearer new-key",
			"x-gw-secret": "new-gw-secret",
			"x-tenant": "tenant-b",
		})
		expect(rotatedAuth?.auth.headers).not.toHaveProperty("x-legacy-flag")

		const overrideAuth = await rotRegistry.getAuth(retainedSameUrlModel, {
			apiKey: "req-key",
			env: { ACME_ROT_GW: "req-gw-secret" },
		})
		expect(overrideAuth?.auth.headers).toMatchObject({
			Authorization: "Bearer req-key",
			"x-gw-secret": "req-gw-secret",
			"x-tenant": "tenant-b",
		})
		const envOnlyOverrideAuth = await rotRegistry.getAuth(retainedSameUrlModel, {
			env: { ACME_ROT_KEY: "req-env-key" },
		})
		expect(envOnlyOverrideAuth?.auth.headers).toMatchObject({
			Authorization: "Bearer req-env-key",
			"x-gw-secret": "new-gw-secret",
		})

		rotRegistry.setProvider(buildPiProvider(tenantBSpec, { env: {} }))
		expect(await rotRegistry.getAuth(retainedSameUrlModel)).toBeUndefined()
		expect(await rotRegistry.checkAuth("acme-rot")).toBeUndefined()

		const customReasoningSpec = defineProvider({
			id: "xai-custom",
			name: "xAI Custom",
			source: "custom",
			defaultModel: "xai-custom/grok-4.6",
			defaultFormat: "openai-responses",
			formats: ["openai-responses"],
			baseUrl: "https://api.xai-custom.example/v1",
			auth: { kind: "bearer", env: "XAI_CUSTOM_KEY", label: "Key" },
			modelDefaults: { reasoning: true },
		})
		const reasoningRegistry = createProviderModels({
			env: { XAI_CUSTOM_KEY: "xai-secret" },
			customProviders: [customReasoningSpec],
		})
		const reasoningModel = reasoningRegistry.getModel("xai-custom", "grok-4.6")!
		expect(reasoningModel.reasoning).toBe(true)
		expect(reasoningModel.thinkingLevelMap).toEqual({ off: null })

		const capturedBodies: Array<{ readonly reasoning?: { readonly effort?: string } }> = []
		const responsesSse = [
			`event: response.completed\ndata: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					output: [
						{
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "ok" }],
						},
					],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			})}\n\n`,
		].join("")
		const capturingFetch: typeof fetch = async (_input, init) => {
			if (typeof init?.body === "string") {
				capturedBodies.push(
					JSON.parse(init.body) as { readonly reasoning?: { readonly effort?: string } },
				)
			}
			return new Response(responsesSse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}
		await reasoningRegistry.completeSimple(
			reasoningModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ fetch: capturingFetch },
		)
		expect(capturedBodies[0]).not.toHaveProperty("reasoning")

		await reasoningRegistry.completeSimple(
			reasoningModel,
			{ messages: [{ role: "user", content: "think hard", timestamp: 0 }] },
			{ reasoning: "high", fetch: capturingFetch },
		)
		expect(capturedBodies[1]?.reasoning).toMatchObject({ effort: "high" })

		expect(sessionA.getModel("openai", "computer-use-preview")).toBeUndefined()
		expect(sessionA.getModel("openai", "computer-use-preview-2025-03-11")).toBeUndefined()
		const lowFloorOpenAI = createProviderModels({
			env: { OPENAI_API_KEY: "sk-a" },
			minContextWindow: 4096,
		})
		expect(lowFloorOpenAI.getModel("openai", "computer-use-preview-2025-03-11")).toMatchObject({
			id: "computer-use-preview-2025-03-11",
			contextWindow: 8192,
			maxTokens: 1024,
		})
		expect(lowFloorOpenAI.getModel("openai", "gpt-3.5-turbo-instruct")).toBeUndefined()
		expect(lowFloorOpenAI.getModel("openai", "gpt-3.5-turbo-instruct-0914")).toBeUndefined()
		expect(sessionA.getModel("openai", "ft:gpt-4o-mini:org:my-transcribe-helper:id")).toMatchObject(
			{
				id: "ft:gpt-4o-mini:org:my-transcribe-helper:id",
				contextWindow: 128_000,
			},
		)
		expect(
			sessionA.getModel("openai", "ft:gpt-4o-mini:org:my-search-preview-bot:id"),
		).toMatchObject({
			id: "ft:gpt-4o-mini:org:my-search-preview-bot:id",
			contextWindow: 128_000,
		})
		expect(sessionA.getModel("openai", "ft:gpt-4o-transcribe:org:chat-helper:id")).toBeUndefined()
		expect(
			sessionA.getModel("openai", "ft:gpt-4o-search-preview:org:chat-helper:id"),
		).toBeUndefined()
		expect(sessionA.getModel("openai", "gpt-audio-1.5")).toBeUndefined()
		expect(sessionA.getModel("openai", "a".repeat(MAX_MODEL_ID_LENGTH + 1))).toBeUndefined()

		const rotatedEndpointSpec = defineProvider({
			...tenantBSpec,
			baseUrl: "https://v2.acme-rot.example/v1",
		})
		rotRegistry.setProvider(
			buildPiProvider(rotatedEndpointSpec, {
				env: { ACME_ROT_KEY: "v2-key", ACME_ROT_GW: "v2-gw-secret" },
			}),
		)
		const unlistedAfterRotation = rotRegistry.getModel("acme-rot", "brand-new-unlisted-model")
		expect(unlistedAfterRotation).toMatchObject({
			id: "brand-new-unlisted-model",
			baseUrl: "https://v2.acme-rot.example/v1",
		})
		const lockedAfterRotationSpec = defineProvider({
			...rotatedEndpointSpec,
			allowUnlistedModels: false,
			models: { "allowed-only": { contextWindow: 128_000 } },
		})
		rotRegistry.setProvider(
			buildPiProvider(lockedAfterRotationSpec, {
				env: { ACME_ROT_KEY: "v3-key", ACME_ROT_GW: "v3-gw-secret" },
			}),
		)
		expect(rotRegistry.getModel("acme-rot", "brand-new-unlisted-model")).toBeUndefined()
		expect(rotRegistry.getModel("acme-rot", "allowed-only")?.baseUrl).toBe(
			"https://v2.acme-rot.example/v1",
		)

		const localNativeRegistry = createProviderModels({
			env: { OPENAI_API_KEY: "sk-local", ANTHROPIC_API_KEY: "sk-ant-local" },
			baseUrlOverrides: {
				openai: "http://127.0.0.1:18991/v1",
				anthropic: "http://127.0.0.1:18992",
			},
		})
		const retainedLocalOpenAI = localNativeRegistry.getModel("openai", "gpt-4o-mini")!
		const retainedLocalAnthropic = localNativeRegistry.getModel("anthropic", "claude-sonnet-4-5")!
		const prodNativeRegistry = createProviderModels({
			env: { OPENAI_API_KEY: "sk-prod", ANTHROPIC_API_KEY: "sk-ant-prod" },
		})
		let nativeLeaks = 0
		const nativeLeakFetch: typeof fetch = async () => {
			nativeLeaks += 1
			return new Response("", { status: 200 })
		}
		const rejectedNativeOpenAI = await prodNativeRegistry.complete(
			retainedLocalOpenAI,
			{ messages: [{ role: "user", content: "secret", timestamp: 0 }] },
			{ fetch: nativeLeakFetch },
		)
		expect(rejectedNativeOpenAI.stopReason).toBe("error")
		expect(rejectedNativeOpenAI.errorMessage).toMatch(/disallowed origin/i)
		const rejectedNativeAnthropic = await prodNativeRegistry.complete(
			retainedLocalAnthropic,
			{ messages: [{ role: "user", content: "secret", timestamp: 0 }] },
			{ fetch: nativeLeakFetch },
		)
		expect(rejectedNativeAnthropic.stopReason).toBe("error")
		expect(rejectedNativeAnthropic.errorMessage).toMatch(/disallowed origin/i)
		expect(nativeLeaks).toBe(0)

		const savedSdkEnv = {
			OPENAI_CUSTOM_HEADERS: process.env["OPENAI_CUSTOM_HEADERS"],
			OPENAI_ORG_ID: process.env["OPENAI_ORG_ID"],
			OPENAI_PROJECT_ID: process.env["OPENAI_PROJECT_ID"],
			ANTHROPIC_CUSTOM_HEADERS: process.env["ANTHROPIC_CUSTOM_HEADERS"],
		}
		process.env["OPENAI_CUSTOM_HEADERS"] =
			"X-Native-Proxy-Secret: openai-secret\nX-Shared-Header: from-openai-env"
		process.env["OPENAI_ORG_ID"] = "org-native-secret"
		process.env["OPENAI_PROJECT_ID"] = "proj-native-secret"
		process.env["ANTHROPIC_CUSTOM_HEADERS"] =
			"X-Anthropic-Proxy-Secret: anthropic-secret\nX-Shared-Header: from-anthropic-env"
		try {
			const thirdPartyNoneOai = defineProvider({
				id: "local-oai-none",
				name: "Local OAI None",
				source: "custom",
				defaultModel: "local-oai-none/llama",
				defaultFormat: "openai-completions",
				formats: ["openai-completions"],
				baseUrl: "https://local-oai.example/v1",
				auth: { kind: "none" },
				headers: { "x-shared-header": "from-custom-oai" },
			})
			const thirdPartyNoneAnth = defineProvider({
				id: "local-anth-none",
				name: "Local Anth None",
				source: "custom",
				defaultModel: "local-anth-none/claude-compat",
				defaultFormat: "anthropic-messages",
				formats: ["anthropic-messages"],
				baseUrl: "https://local-anth.example",
				auth: { kind: "none" },
				headers: { "x-shared-header": "from-custom-anth" },
			})
			const isolatedModels = createProviderModels({
				env: {},
				customProviders: [thirdPartyNoneOai, thirdPartyNoneAnth],
			})
			let capturedThirdPartyOai: Headers | undefined
			await isolatedModels.complete(
				isolatedModels.getModel("local-oai-none", "llama")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedThirdPartyOai = new Headers(init?.headers)
						return new Response(sse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedThirdPartyOai?.get("x-native-proxy-secret")).toBeNull()
			expect(capturedThirdPartyOai?.get("openai-organization")).toBeNull()
			expect(capturedThirdPartyOai?.get("openai-project")).toBeNull()
			expect(capturedThirdPartyOai?.get("x-shared-header")).toBe("from-custom-oai")

			let capturedThirdPartyAnth: Headers | undefined
			await isolatedModels.complete(
				isolatedModels.getModel("local-anth-none", "claude-compat")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedThirdPartyAnth = new Headers(init?.headers)
						return new Response(anthSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedThirdPartyAnth?.get("x-anthropic-proxy-secret")).toBeNull()
			expect(capturedThirdPartyAnth?.get("x-shared-header")).toBe("from-custom-anth")

			let capturedNativeOai: Headers | undefined
			await prodNativeRegistry.complete(
				prodNativeRegistry.getModel("openai", "gpt-4o-mini")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedNativeOai = new Headers(init?.headers)
						return new Response(responsesSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedNativeOai?.get("x-native-proxy-secret")).toBe("openai-secret")
			expect(capturedNativeOai?.get("openai-organization")).toBe("org-native-secret")
			expect(capturedNativeOai?.get("openai-project")).toBe("proj-native-secret")

			const openAiBuiltinSpec = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai")!
			const anthropicBuiltinSpec = BUILTIN_PROVIDERS.find(
				(provider) => provider.id === "anthropic",
			)!
			const proxiedVendors = createProviderModels({ env: {} })
			proxiedVendors.setProvider(
				buildPiProvider(
					{ ...openAiBuiltinSpec, baseUrl: "https://proxy-openai.example/v1" },
					{ env: { OPENAI_API_KEY: "sk-proxy" } },
				),
			)
			proxiedVendors.setProvider(
				buildPiProvider(
					{ ...anthropicBuiltinSpec, baseUrl: "https://proxy-anthropic.example" },
					{ env: { ANTHROPIC_API_KEY: "sk-ant-proxy" } },
				),
			)
			let capturedProxyOai: Headers | undefined
			await proxiedVendors.complete(
				proxiedVendors.getModel("openai", "gpt-4o-mini")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedProxyOai = new Headers(init?.headers)
						return new Response(responsesSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedProxyOai?.get("x-native-proxy-secret")).toBeNull()
			expect(capturedProxyOai?.get("openai-organization")).toBeNull()
			expect(capturedProxyOai?.get("openai-project")).toBeNull()

			let capturedProxyAnth: Headers | undefined
			await proxiedVendors.complete(
				proxiedVendors.getModel("anthropic", "claude-sonnet-4-5")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedProxyAnth = new Headers(init?.headers)
						return new Response(anthSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedProxyAnth?.get("x-anthropic-proxy-secret")).toBeNull()
		} finally {
			for (const [key, value] of Object.entries(savedSdkEnv)) {
				if (value === undefined) {
					delete process.env[key]
				} else {
					process.env[key] = value
				}
			}
		}

		const missingBaseSpec = defineProvider({
			id: "acme-nobase",
			name: "Acme No Base",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			auth: { kind: "bearer", env: "ACME_PIN_KEY", label: "Key" },
		})
		const malformedBaseSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-badbase",
			baseUrl: "not a url",
		})
		const nonHttpBaseSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-filebase",
			baseUrl: "file:///etc/passwd",
		})
		const credInUrlSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-credbase",
			baseUrl: "https://user:pass@api.acme.example/v1",
		})
		const remoteCleartextSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-httpbase",
			baseUrl: "http://api.acme.example/v1",
		})
		const privateHttpsSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-ssrfbase",
			baseUrl: "https://169.254.169.254/latest",
		})
		for (const badSpec of [
			missingBaseSpec,
			malformedBaseSpec,
			nonHttpBaseSpec,
			credInUrlSpec,
			remoteCleartextSpec,
			privateHttpsSpec,
		]) {
			expect(() => buildPiProvider(badSpec, { env: { ACME_PIN_KEY: "new-secret" } })).toThrow(
				TypeError,
			)
			expect(() =>
				createProviderModels({ env: { ACME_PIN_KEY: "new-secret" }, customProviders: [badSpec] }),
			).toThrow(TypeError)
		}
		expect(() =>
			resolveModelSpecifier("acme-nobase/chat", { customProviders: [missingBaseSpec] }),
		).toThrow(TypeError)
		expect(() =>
			resolveModelSpecifier("acme-badbase/chat", { customProviders: [malformedBaseSpec] }),
		).toThrow(TypeError)
		expect(() =>
			resolveModelSpecifier("acme-httpbase/chat", { customProviders: [remoteCleartextSpec] }),
		).toThrow(TypeError)
		const slashIdSpec = defineProvider({
			id: "openai/team",
			name: "OpenAI Team",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://team.acme.example/v1",
			auth: { kind: "none" },
		})
		expect(() =>
			resolveModelSpecifier("openai/team/chat", { customProviders: [slashIdSpec] }),
		).toThrow(/must not contain "\/"/)
		expect(() => buildPiProvider(slashIdSpec, { env: {} })).toThrow(/must not contain "\/"/)
		expect(() => createProviderModels({ env: {}, customProviders: [slashIdSpec] })).toThrow(
			/must not contain "\/"/,
		)
		const loopbackDevSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-loopback",
			baseUrl: "http://127.0.0.1:11434/v1",
			auth: { kind: "none" },
		})
		expect(
			createProviderModels({ env: {}, customProviders: [loopbackDevSpec] }).getModel(
				"acme-loopback",
				"chat",
			)?.baseUrl,
		).toBe("http://127.0.0.1:11434/v1")
		const rotationGuardRegistry = createProviderModels({
			env: { ACME_PIN_KEY: "old-secret" },
			customProviders: [oldEndpointSpec],
		})
		const retainedRotationModel = rotationGuardRegistry.getModel("acme-pin", "chat")!
		const { baseUrl: _omittedBaseUrl, ...oldEndpointWithoutBase } = oldEndpointSpec
		expect(() =>
			rotationGuardRegistry.setProvider(
				buildPiProvider(oldEndpointWithoutBase, { env: { ACME_PIN_KEY: "rotated-secret" } }),
			),
		).toThrow(TypeError)
		expect(
			(await rotationGuardRegistry.getAuth(retainedRotationModel))?.auth.headers,
		).toMatchObject({ Authorization: "Bearer old-secret" })

		const bareAliasCustom = defineProvider({
			id: "acme-bare",
			name: "Acme Bare",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://acme-bare.example/v1",
			auth: { kind: "none" },
			resolveBareModelIds: true,
			models: {
				"acme-fast": { contextWindow: 128_000 },
				"acme-tiny": { contextWindow: 8192 },
			},
		})
		expect(resolveModelSpecifier("acme-fast", { customProviders: [bareAliasCustom] })).toEqual({
			provider: "acme-bare",
			modelId: "acme-fast",
			cataloged: true,
		})
		expect(resolveModelSpecifier("acme-tiny", { customProviders: [bareAliasCustom] })).toBeNull()
		expect(
			resolveModelSpecifier("acme-unlisted", { customProviders: [bareAliasCustom] }),
		).toBeNull()
		expect(
			resolveModelSpecifier("acme-bare/acme-unlisted", { customProviders: [bareAliasCustom] }),
		).toEqual({
			provider: "acme-bare",
			modelId: "acme-unlisted",
			cataloged: false,
		})

		const blankAuthProvider = defineProvider({
			id: "blank-auth",
			name: "Blank Auth",
			source: "custom",
			defaultModel: "blank-auth/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://blank-auth.example/v1",
			auth: { kind: "bearer", env: "BLANK_API_KEY", label: "Blank Key" },
			secretHeaders: { "x-gw-token": "BLANK_GW_TOKEN" },
		})
		const blankKeyEnv = { BLANK_API_KEY: "   \t  ", BLANK_GW_TOKEN: "valid-gw" }
		const blankSecretEnv = { BLANK_API_KEY: "valid-key", BLANK_GW_TOKEN: "  \n " }
		for (const blankEnv of [blankKeyEnv, blankSecretEnv]) {
			expect(checkProviderCredentials(blankAuthProvider, { env: blankEnv }).ok).toBe(false)
			const blankRegistry = createProviderModels({
				env: blankEnv,
				customProviders: [blankAuthProvider],
			})
			expect(await blankRegistry.checkAuth("blank-auth")).toBeUndefined()
			expect(
				await blankRegistry.getAuth(blankRegistry.getModel("blank-auth", "m1")!),
			).toBeUndefined()
			expect(await blankRegistry.getAvailable("blank-auth")).toEqual([])
		}

		const mismatchedFormatSpec = defineProvider({
			id: "bad-format",
			name: "Bad Format",
			source: "custom",
			defaultFormat: "openai-responses",
			formats: ["openai-completions"],
			baseUrl: "https://bad-format.example/v1",
			auth: { kind: "none" },
		})
		expect(() =>
			resolveModelSpecifier("bad-format/m1", { customProviders: [mismatchedFormatSpec] }),
		).toThrow(/defaultFormat "openai-responses" must be listed in formats/)
		expect(() => buildPiProvider(mismatchedFormatSpec, { env: {} })).toThrow(
			/defaultFormat "openai-responses" must be listed in formats/,
		)
		expect(() =>
			createProviderModels({ env: {}, customProviders: [mismatchedFormatSpec] }),
		).toThrow(/defaultFormat "openai-responses" must be listed in formats/)

		for (const unsupportedAuth of [{ kind: "unsupported_oauth" }]) {
			const unsupportedSpec = {
				id: `unsupported-${unsupportedAuth.kind}`,
				name: "Unsupported Auth",
				source: "custom" as const,
				defaultFormat: "openai-completions" as const,
				formats: ["openai-completions" as const],
				baseUrl: "https://unsupported.example/v1",
				auth: unsupportedAuth,
			} as unknown as (typeof BUILTIN_PROVIDERS)[number]
			expect(
				checkProviderCredentials(unsupportedSpec, {
					env: {},
				}),
			).toEqual({
				ok: false,
				missing: [],
				message: `Provider "${unsupportedSpec.id}" uses unsupported auth kind "${unsupportedAuth.kind}".`,
			})
			expect(() => buildPiProvider(unsupportedSpec, { env: {} })).toThrow(/unsupported auth kind/)
			expect(() => createProviderModels({ env: {}, customProviders: [unsupportedSpec] })).toThrow(
				/unsupported auth kind/,
			)
			expect(() =>
				resolveModelSpecifier(`${unsupportedSpec.id}/m1`, { customProviders: [unsupportedSpec] }),
			).toThrow(/unsupported auth kind/)
		}

		const openAiSpec = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai")!
		const proxyOpenAiSpec = defineProvider({
			...openAiSpec,
			baseUrl: "https://proxy-openai.example/v1",
		})
		const proxyOpenAiRegistry = createProviderModels({ env: { OPENAI_API_KEY: "sk-default" } })
		proxyOpenAiRegistry.setProvider(
			buildPiProvider(proxyOpenAiSpec, { env: { OPENAI_API_KEY: "sk-proxy" } }),
		)
		const proxyListed = proxyOpenAiRegistry.getModels("openai")
		const proxyAvailable = await proxyOpenAiRegistry.getAvailable("openai")
		expect(proxyListed.length).toBeGreaterThan(0)
		expect(proxyAvailable.length).toBe(proxyListed.length)
		expect(proxyListed.every((m) => m.baseUrl === "https://proxy-openai.example/v1")).toBe(true)
		expect(proxyAvailable.every((m) => m.baseUrl === "https://proxy-openai.example/v1")).toBe(true)
		expect(
			prodNativeRegistry
				.getModels("openai")
				.every((m) => m.baseUrl === "https://api.openai.com/v1"),
		).toBe(true)
		let proxyRequestedUrl = ""
		const proxyListedResult = await proxyOpenAiRegistry.complete(
			proxyListed[0]!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (input) => {
					proxyRequestedUrl = String(input)
					return new Response(responsesSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(proxyListedResult.stopReason).toBe("stop")
		expect(proxyRequestedUrl).toBe("https://proxy-openai.example/v1/responses")

		const lowFloorRegistry = createProviderModels({ env: {}, minContextWindow: 4096 })
		const rotatedSmallSpec = defineProvider({
			id: "acme-floor",
			name: "Acme Floor",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://acme-floor.example/v1",
			auth: { kind: "none" },
			models: {
				"model-8k": { contextWindow: 8192 },
				"model-2k": { contextWindow: 2048 },
			},
		})
		const replacementWithoutFloor = buildPiProvider(rotatedSmallSpec, { env: {} })
		lowFloorRegistry.setProvider(replacementWithoutFloor)
		expect(lowFloorRegistry.getModel("acme-floor", "model-8k")?.contextWindow).toBe(8192)
		expect(lowFloorRegistry.getModel("acme-floor", "model-2k")).toBeUndefined()
		expect(lowFloorRegistry.getModels("acme-floor").map((m) => m.id)).toEqual(["model-8k"])
		expect((await lowFloorRegistry.getAvailable("acme-floor")).map((m) => m.id)).toEqual([
			"model-8k",
		])
		lowFloorRegistry.setProvider(
			buildPiProvider(rotatedSmallSpec, { env: {}, minContextWindow: 32_768 }),
		)
		expect(lowFloorRegistry.getModel("acme-floor", "model-8k")).toBeUndefined()
		expect(lowFloorRegistry.getModels("acme-floor")).toEqual([])
		expect(await lowFloorRegistry.getAvailable("acme-floor")).toEqual([])
	})
})

describe("@checkfu/pi-providers custom format-compatible providers", () => {
	it("parses object and array CHECKFU_PROVIDERS manifests and enforces security invariants", async () => {
		expect(CUSTOM_PROVIDER_SECRET_ENV_PREFIX).toBe("CHECKFU_PROVIDER_SECRET_")
		expect(isCustomProviderSecretEnv("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")).toBe(true)
		expect(isCustomProviderSecretEnv("CHECKFU_PROVIDER_SECRET_")).toBe(false)
		expect(isCustomProviderSecretEnv("CHECKFU_PROVIDER_SECRET__BAD")).toBe(false)
		expect(isCustomProviderSecretEnv("GH_ENTERPRISE_TOKEN")).toBe(false)
		expect(isCustomProviderSecretEnv("OPENAI_API_KEY")).toBe(false)
		expect(isCustomProviderSecretEnv("AI")).toBe(false)

		const fromObject = parseCustomProvidersManifest(
			JSON.stringify({
				xai: {
					name: "xAI",
					format: "openai-responses",
					base_url: "https://api.x.ai/v1/",
					api_key_env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
					default_model: "grok-4",
					context_window: 256_000,
					max_tokens: 32_768,
					reasoning: true,
					headers: { "x-team": "agents" },
					secret_headers: { "x-gateway-token": "CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN" },
					models: {
						"grok-4-fast": { context_window: 131_072, max_tokens: 16_384, reasoning: false },
					},
				},
				"corp-claude": {
					format: "anthropic-messages",
					base_url: "https://llm.corp.example",
					auth: { type: "bearer", env: "CHECKFU_PROVIDER_SECRET_CORP_CLAUDE_BEARER" },
				},
				azureish: {
					format: "openai-completions",
					base_url: "https://gw.corp.example/v1",
					auth: {
						type: "api_key_header",
						header: "api-key",
						env: "CHECKFU_PROVIDER_SECRET_AZUREISH_KEY",
					},
					headers: { "CF-Access-Client-Id": "public-client-id" },
					secret_headers: {
						"CF-Access-Client-Secret": "CHECKFU_PROVIDER_SECRET_CF_ACCESS_SECRET",
						Cookie: "CHECKFU_PROVIDER_SECRET_SESSION_COOKIE",
					},
				},
			}),
		)
		expect(fromObject).toHaveLength(3)
		expect(fromObject[0]).toMatchObject({
			id: "xai",
			name: "xAI",
			source: "custom",
			defaultModel: "xai/grok-4",
			defaultFormat: "openai-responses",
			baseUrl: "https://api.x.ai/v1",
			auth: { kind: "bearer", env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY" },
			headers: { "x-team": "agents" },
			secretHeaders: { "x-gateway-token": "CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN" },
		})
		expect(providerRequiredSecretEnvs(fromObject)).toEqual([
			"CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
			"CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN",
			"CHECKFU_PROVIDER_SECRET_CORP_CLAUDE_BEARER",
			"CHECKFU_PROVIDER_SECRET_AZUREISH_KEY",
			"CHECKFU_PROVIDER_SECRET_CF_ACCESS_SECRET",
			"CHECKFU_PROVIDER_SECRET_SESSION_COOKIE",
		])
		expect(fromObject[1]?.defaultModel).toBeUndefined()
		const declaredDefault = parseCustomProvidersManifest(
			JSON.stringify({
				declared: {
					format: "openai-completions",
					base_url: "https://api.declared.example/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_DECLARED_KEY",
					models: { "model-a": { context_window: 131_072 } },
				},
				acme: {
					format: "openai-completions",
					base_url: "https://api.acme.example/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_KEY",
					context_window: 200_000,
					models: {
						"acme/chat": {},
						chat: {},
					},
				},
			}),
		)
		expect(declaredDefault[0]?.defaultModel).toBe("declared/model-a")
		// Declared models with empty `{}` overrides are retained and namespaced wire IDs keep their prefix.
		expect(declaredDefault[1]?.defaultModel).toBe("acme/acme/chat")
		expect(declaredDefault[1]?.models).toEqual({ "acme/chat": {}, chat: {} })
		expect(resolveModelSpecifier("acme/acme/chat", { customProviders: declaredDefault })).toEqual({
			provider: "acme",
			modelId: "acme/chat",
			cataloged: true,
		})
		expect(resolveModelSpecifier("acme/chat", { customProviders: declaredDefault })).toEqual({
			provider: "acme",
			modelId: "chat",
			cataloged: true,
		})
		const declaredCatalogRoundtrip = parseCustomProviderCatalog(
			serializeCustomProviderCatalog(declaredDefault),
		)
		expect(declaredCatalogRoundtrip[1]?.defaultModel).toBe("acme/acme/chat")
		expect(declaredCatalogRoundtrip[1]?.models).toEqual({ "acme/chat": {}, chat: {} })
		expect(
			resolveModelSpecifier("acme/acme/chat", { customProviders: declaredCatalogRoundtrip }),
		).toEqual({
			provider: "acme",
			modelId: "acme/chat",
			cataloged: true,
		})
		const declaredRuntimeModels = createProviderModels({
			env: {
				CHECKFU_PROVIDER_SECRET_DECLARED_KEY: "k1",
				CHECKFU_PROVIDER_SECRET_ACME_KEY: "k2",
			},
			customProviders: declaredDefault,
		})
		expect(declaredRuntimeModels.getModels("acme").map((model) => model.id)).toEqual([
			"acme/chat",
			"chat",
		])
		expect((await declaredRuntimeModels.getAvailable("acme")).map((model) => model.id)).toEqual([
			"acme/chat",
			"chat",
		])
		expect(declaredRuntimeModels.getModel("acme", "acme/chat")?.contextWindow).toBe(200_000)
		expect(declaredRuntimeModels.getModel("acme", "chat")?.contextWindow).toBe(200_000)
		const explicitNamespacedDefault = parseCustomProvidersManifest(
			JSON.stringify({
				acme: {
					format: "openai-completions",
					base_url: "https://api.acme.example/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_KEY",
					default_model: "acme/chat",
					models: { "acme/chat": {} },
				},
			}),
		)
		expect(explicitNamespacedDefault[0]?.defaultModel).toBe("acme/acme/chat")

		// Stripped API catalog projection omits headers, secret_headers, auth, and base_url.
		const serializedCatalog = serializeCustomProviderCatalog(fromObject)
		expect(serializedCatalog).not.toContain("x-team")
		expect(serializedCatalog).not.toContain("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")
		expect(serializedCatalog).not.toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
		expect(serializedCatalog).not.toContain("https://api.x.ai")
		const reparsedCatalog = parseCustomProviderCatalog(serializedCatalog)
		expect(resolveModelSpecifier("xai/grok-4", { customProviders: reparsedCatalog })).toEqual({
			provider: "xai",
			modelId: "grok-4",
			cataloged: false,
		})
		expect(resolveModelSpecifier("xai/grok-4-fast", { customProviders: reparsedCatalog })).toEqual({
			provider: "xai",
			modelId: "grok-4-fast",
			cataloged: true,
		})
		expect(() =>
			parseCustomProviderCatalog(
				JSON.stringify([{ id: "bad", format: "openai-responses", headers: { "x-a": "1" } }]),
			),
		).toThrow(/Disallowed field "headers"/)
		// Catalog-only projections are rejected at runtime registration boundaries even if a
		// loopback baseUrlOverride supplies an endpoint for that provider ID.
		const catalogOnlyXai = reparsedCatalog[0]!
		expect(() =>
			buildPiProvider(catalogOnlyXai, {
				env: {},
				baseUrlOverrides: { xai: "http://127.0.0.1:11434/v1" },
			}),
		).toThrow(/catalog-only projection/i)
		expect(() =>
			createProviderModels({
				env: {},
				customProviders: reparsedCatalog,
				baseUrlOverrides: { xai: "http://127.0.0.1:11434/v1" },
			}),
		).toThrow(/catalog-only projection/i)
		expect(() =>
			synthesizeProviderModel(catalogOnlyXai, "grok-4", {
				env: {},
				baseUrlOverrides: { xai: "http://127.0.0.1:11434/v1" },
			}),
		).toThrow(/catalog-only projection/i)

		// Custom provider named "constructor" is valid and must not trip Object.prototype lookups.
		const ctorParsed = parseCustomProvidersManifest(
			JSON.stringify({
				constructor: {
					format: "openai-completions",
					base_url: "https://ctor.example/v1",
					auth: { type: "none" },
				},
			}),
		)
		const ctorModels = createProviderModels({
			env: { OPENAI_API_KEY: "sk-test" },
			baseUrlOverrides: { openai: null },
			customProviders: ctorParsed,
		})
		expect(ctorModels.getModel("constructor", "m1")?.baseUrl).toBe("https://ctor.example/v1")
		expect(ctorModels.getModel("openai", "gpt-4o-mini")?.id).toBe("gpt-4o-mini")
		expect(resolveModelSpecifier("xai/grok-4", { customProviders: fromObject })).toEqual({
			provider: "xai",
			modelId: "grok-4",
			cataloged: false,
		})

		// Array form with local loopback HTTP allowed ONLY when allowLoopbackHttp: true
		const localJson = JSON.stringify([
			{
				id: "ollama",
				format: "openai-completions",
				base_url: "http://127.0.0.1:11434/v1",
				auth: { type: "none" },
			},
		])
		expect(() => parseCustomProvidersManifest(localJson, { allowLoopbackHttp: false })).toThrow(
			CustomProviderConfigError,
		)
		const localParsed = parseCustomProvidersManifest(localJson, { allowLoopbackHttp: true })
		expect(localParsed[0]).toMatchObject({
			id: "ollama",
			baseUrl: "http://127.0.0.1:11434/v1",
			auth: { kind: "none" },
		})

		// Underscore-separated credential headers are permitted in auth/secret_headers (and non-credential
		// underscore headers in static headers) with their original header names preserved on the wire.
		const underscoreHeaders = parseCustomProvidersManifest(
			JSON.stringify({
				underscore: {
					format: "openai-completions",
					base_url: "https://api.example.com/v1",
					auth: {
						type: "api_key_header",
						header: "X_API_KEY",
						env: "CHECKFU_PROVIDER_SECRET_UNDERSCORE_API_KEY",
					},
					headers: { x_tenant_id: "tenant-42" },
					secret_headers: { x_gateway_token: "CHECKFU_PROVIDER_SECRET_UNDERSCORE_GW_TOKEN" },
				},
			}),
		)
		expect(underscoreHeaders[0]).toMatchObject({
			id: "underscore",
			auth: {
				kind: "api_key_header",
				header: "X_API_KEY",
				env: "CHECKFU_PROVIDER_SECRET_UNDERSCORE_API_KEY",
			},
			headers: { x_tenant_id: "tenant-42" },
			secretHeaders: { x_gateway_token: "CHECKFU_PROVIDER_SECRET_UNDERSCORE_GW_TOKEN" },
		})

		// Cloudflare Workers 5 KB UTF-8 byte-limit helper & HTTP header value validator
		expect(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES).toBe(5120)
		expect(utf8ByteLength("東")).toBe(3)
		expect(() =>
			assertCloudflareWorkerEnvByteLimit(
				"CHECKFU_PROVIDER_CATALOG",
				"a".repeat(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES),
			),
		).not.toThrow()
		expect(() =>
			assertCloudflareWorkerEnvByteLimit(
				"CHECKFU_PROVIDER_CATALOG",
				"a".repeat(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES + 1),
			),
		).toThrow(/CHECKFU_PROVIDER_CATALOG.*5121 UTF-8 bytes.*5120-byte/i)
		const multibyteOverLimit = "東".repeat(1707)
		expect(multibyteOverLimit.length).toBeLessThan(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES)
		expect(() =>
			assertCloudflareWorkerEnvByteLimit("CHECKFU_PROVIDERS", multibyteOverLimit),
		).toThrow(/CHECKFU_PROVIDERS.*5121 UTF-8 bytes.*5120-byte/i)
		const packedOverflowManifest = JSON.stringify({
			acme: {
				format: "openai-responses",
				base_url: "https://api.acme.example/v1",
				auth: { type: "none" },
				headers: Object.fromEntries(
					Array.from({ length: 300 }, (_, index) => [`x-h-${String(index).padStart(3, "0")}`, "v"]),
				),
			},
		})
		expect(utf8ByteLength(packedOverflowManifest)).toBeLessThan(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES)
		expect(utf8ByteLength(packAlchemyConfigEnvValue(packedOverflowManifest))).toBeGreaterThan(
			CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES,
		)
		expect(() =>
			assertCloudflareWorkerEnvByteLimit("CHECKFU_PROVIDERS", packedOverflowManifest, {
				packedConfigBinding: true,
			}),
		).toThrow(/CHECKFU_PROVIDERS encodes to \d+ UTF-8 bytes.*5120-byte/i)
		expect(isValidHeaderValue("Basic dXNlcjpwYXNz")).toBe(true)
		expect(isValidHeaderValue("a\tb")).toBe(true)
		expect(isValidHeaderValue("line1\nline2")).toBe(false)
		expect(isValidHeaderValue("line1\rline2")).toBe(false)
		expect(isValidHeaderValue("nul\u0000byte")).toBe(false)
		expect(isValidHeaderValue("tok-東京")).toBe(false)

		// Packed 5 KiB secret binding limit & whitespace rejection on custom credentials
		const xaiOnly = [fromObject[0]!]
		expect(utf8ByteLength(packAlchemyConfigEnvValue("k".repeat(5090)))).toBe(
			CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES,
		)
		expect(
			validateCustomProviderCredentials(xaiOnly, {
				CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "k".repeat(5090),
				CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "t".repeat(5090),
			}).ok,
		).toBe(true)
		const oversizedPrimaryCred = validateCustomProviderCredentials(xaiOnly, {
			CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "k".repeat(5091),
			CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "gw-ok",
		})
		expect(oversizedPrimaryCred.ok).toBe(false)
		expect(oversizedPrimaryCred.invalidCredentialErrors).toEqual([
			"CHECKFU_PROVIDER_SECRET_XAI_API_KEY encodes to 5121 UTF-8 bytes, exceeding Cloudflare Workers' 5120-byte secret limit.",
		])
		const oversizedHeaderCred = validateCustomProviderCredentials(xaiOnly, {
			CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "sk-ok",
			CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "t".repeat(5091),
		})
		expect(oversizedHeaderCred.ok).toBe(false)
		expect(oversizedHeaderCred.invalidCredentialErrors).toEqual([
			"CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN encodes to 5121 UTF-8 bytes, exceeding Cloudflare Workers' 5120-byte secret limit.",
		])
		const trailingWhitespaceCred = validateCustomProviderCredentials(xaiOnly, {
			CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "sk-ok\n",
			CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: " gw-ok ",
		})
		expect(trailingWhitespaceCred.ok).toBe(false)
		expect(trailingWhitespaceCred.invalidCredentialErrors).toHaveLength(2)
		expect(trailingWhitespaceCred.invalidCredentialErrors[0]).toContain(
			"CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
		)
		expect(trailingWhitespaceCred.invalidCredentialErrors[1]).toContain(
			"CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN",
		)

		// Fail-closed security & schema rejections
		const GOOD_SECRET_ENV = "CHECKFU_PROVIDER_SECRET_GOOD_KEY"
		const invalidManifests: ReadonlyArray<[string, RegExp]> = [
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key: "sk-inline-secret",
					},
				}),
				/inline secret/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "CHECKFU_API_KEY",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "CLOUDFLARE_API_KEY",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						secret_headers: { "x-email": "CLOUDFLARE_ACCOUNT_EMAIL" },
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "CLOUDFLARE_API_TOKEN",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "CLOUDFLARE_ACCESS_CLIENT_SECRET",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						secret_headers: { "CF-Access-Client-Id": "CLOUDFLARE_ACCESS_CLIENT_ID" },
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						secret_headers: { "CF-Access-Client-Secret": "CLOUDFLARE_ACCESS_CLIENT_SECRET" },
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						secret_headers: { "x-leak": "ALCHEMY_PASSWORD" },
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "AI",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						secret_headers: { "x-auth": "AI" },
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "GH_TOKEN",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "GH_ENTERPRISE_TOKEN",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						secret_headers: { "x-auth": "GH_ENTERPRISE_TOKEN" },
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "NODE_AUTH_TOKEN",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "AWS_SECRET_ACCESS_KEY",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "OPENAI_API_KEY",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: "CHECKFU_PROVIDER_SECRET_",
					},
				}),
				/Disallowed environment variable in .*CHECKFU_PROVIDER_SECRET_/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { Authorization: "Bearer inline-leak" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { Cookie: "session=secret-cookie" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "CF-Access-Client-Secret": "inline-cf-secret" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "X-Goog-Api-Key": "inline-goog-key" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "x-portkey-api-key": "inline-portkey-key" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "x-custom-secret": "inline-secret-header" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { api_key: "sk-inline-underscore" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { X_API_KEY: "sk-inline-underscore" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { x_auth_token: "tok-inline-underscore" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "X-RapidAPI-Key": "inline-rapidapi-key" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "X-Gateway-Key": "inline-gateway-key" },
					},
				}),
				/cannot be placed in non-secret "headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						default_model: "model\u001b[31m",
					},
				}),
				/default_model/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-completions",
						base_url: "https://api.example.com/v1",
						auth: {
							type: "api_key_header",
							header: "x-custom-id",
							env: "CHECKFU_PROVIDER_SECRET_GW_KEY",
						},
						headers: { "X-Custom-Id": "inline-override" },
					},
				}),
				/cannot appear in both non-secret "headers" and auth header/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-completions",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "X-Custom-Id": "inline-override" },
						secret_headers: { "x-custom-id": "CHECKFU_PROVIDER_SECRET_GW_SECRET" },
					},
				}),
				/cannot appear in both non-secret "headers" and "secret_headers"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-completions",
						base_url: "https://api.example.com/v1",
						auth: {
							type: "api_key_header",
							header: "X-Corp-Key",
							env: "CHECKFU_PROVIDER_SECRET_CORP_KEY",
						},
						secret_headers: { "x-corp-key": "CHECKFU_PROVIDER_SECRET_OTHER_SECRET" },
					},
				}),
				/conflicts with auth header/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-completions",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "X-Tenant": "a", "x-tenant": "b" },
					},
				}),
				/Duplicate header/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-completions",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						secret_headers: {
							"X-Secret": "CHECKFU_PROVIDER_SECRET_SEC_A",
							"x-secret": "CHECKFU_PROVIDER_SECRET_SEC_B",
						},
					},
				}),
				/Duplicate header/i,
			],
			[
				JSON.stringify({
					openrouter: {
						format: "openai-completions",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
					},
				}),
				/collides with a built-in provider/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
					},
				}),
				/must specify "api_key_env" or "auth"/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						context_window: 8192,
					},
				}),
				/context_window/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "x-tenant": "東京" },
					},
				}),
				/Custom provider "bad" header "x-tenant".*printable ASCII/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						headers: { "x-tenant": "escape\u001b[31m" },
					},
				}),
				/Custom provider "bad" header "x-tenant".*printable ASCII/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						max_tokens: 4,
					},
				}),
				/max_tokens.*between 16 and/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						models: { m1: { max_tokens: 15 } },
					},
				}),
				/max_tokens.*between 16 and/i,
			],
			[
				JSON.stringify({
					acme: {
						format: "openai-completions",
						base_url: "https://api.acme.example/v1",
						api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_KEY",
						default_model: "acme/",
					},
				}),
				/default_model.*non-empty model ID/i,
			],
			[
				JSON.stringify({
					bad: {
						format: "openai-responses",
						base_url: "https://api.example.com/v1",
						api_key_env: GOOD_SECRET_ENV,
						unknown_field: true,
					},
				}),
				/Unknown field/i,
			],
		]
		for (const [manifest, pattern] of invalidManifests) {
			expect(() => parseCustomProvidersManifest(manifest)).toThrow(pattern)
		}

		// Valid boundary limits: openai-responses accepts max_tokens >= 16; completions accepts >= 1.
		const boundaryParsed = parseCustomProvidersManifest(
			JSON.stringify({
				resp: {
					format: "openai-responses",
					base_url: "https://resp.example/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_RESP_KEY",
					max_tokens: 16,
				},
				comp: {
					format: "openai-completions",
					base_url: "https://comp.example/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_COMP_KEY",
					max_tokens: 4,
				},
			}),
		)
		expect(boundaryParsed[0]?.modelDefaults?.maxTokens).toBe(16)
		expect(boundaryParsed[1]?.modelDefaults?.maxTokens).toBe(4)

		// Provider-specific Cloudflare Access tokens under the explicit secret namespace remain allowed.
		const accessParsed = parseCustomProvidersManifest(
			JSON.stringify({
				"private-gw": {
					format: "openai-completions",
					base_url: "https://llm.internal.example/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_PRIVATE_GW_KEY",
					secret_headers: {
						"CF-Access-Client-Id": "CHECKFU_PROVIDER_SECRET_PRIVATE_GW_ACCESS_CLIENT_ID",
						"CF-Access-Client-Secret": "CHECKFU_PROVIDER_SECRET_PRIVATE_GW_ACCESS_CLIENT_SECRET",
					},
				},
			}),
		)
		expect(accessParsed[0]?.secretHeaders).toEqual({
			"CF-Access-Client-Id": "CHECKFU_PROVIDER_SECRET_PRIVATE_GW_ACCESS_CLIENT_ID",
			"CF-Access-Client-Secret": "CHECKFU_PROVIDER_SECRET_PRIVATE_GW_ACCESS_CLIENT_SECRET",
		})

		// Gateway key headers (such as X-RapidAPI-Key) remain usable through auth.header or
		// secret_headers while companion non-secret headers (X-RapidAPI-Host) remain allowed in headers.
		const rapidApiParsed = parseCustomProvidersManifest(
			JSON.stringify({
				"rapidapi-auth": {
					format: "openai-completions",
					base_url: "https://rapidapi.example/v1",
					auth: {
						type: "api_key_header",
						header: "X-RapidAPI-Key",
						env: "CHECKFU_PROVIDER_SECRET_RAPIDAPI_KEY",
					},
					headers: { "X-RapidAPI-Host": "llm.p.rapidapi.com" },
				},
				"rapidapi-secret-header": {
					format: "openai-completions",
					base_url: "https://rapidapi.example/v1",
					auth: { type: "none" },
					headers: { "X-RapidAPI-Host": "llm.p.rapidapi.com" },
					secret_headers: { "X-RapidAPI-Key": "CHECKFU_PROVIDER_SECRET_RAPIDAPI_KEY" },
				},
			}),
		)
		expect(rapidApiParsed[0]).toMatchObject({
			auth: {
				kind: "api_key_header",
				header: "X-RapidAPI-Key",
				env: "CHECKFU_PROVIDER_SECRET_RAPIDAPI_KEY",
			},
			headers: { "X-RapidAPI-Host": "llm.p.rapidapi.com" },
		})
		expect(rapidApiParsed[1]).toMatchObject({
			headers: { "X-RapidAPI-Host": "llm.p.rapidapi.com" },
			secretHeaders: { "X-RapidAPI-Key": "CHECKFU_PROVIDER_SECRET_RAPIDAPI_KEY" },
		})

		// Malformed JSON errors never echo raw tokens or unquoted secrets from the manifest.
		const secretSentinel = "sk_unquoted_secret_leak_check_999"
		let parseErr: unknown
		try {
			parseCustomProvidersManifest(`{"x":{"api_key":${secretSentinel}}}`)
		} catch (error) {
			parseErr = error
		}
		expect(parseErr).toBeInstanceOf(CustomProviderConfigError)
		expect(String(parseErr)).toContain("Invalid CHECKFU_PROVIDERS JSON")
		expect(String(parseErr)).not.toContain(secretSentinel)

		let catalogErr: unknown
		try {
			parseCustomProviderCatalog(`[{"id":${secretSentinel}}]`)
		} catch (error) {
			catalogErr = error
		}
		expect(catalogErr).toBeInstanceOf(CustomProviderConfigError)
		expect(String(catalogErr)).toContain("Invalid CHECKFU_PROVIDER_CATALOG JSON")
		expect(String(catalogErr)).not.toContain(secretSentinel)
		expect(() =>
			parseCustomProviderCatalog(
				JSON.stringify([{ id: "acme", format: "openai-completions", default_model: "acme/" }]),
			),
		).toThrow(/Invalid default_model/)
		expect(() =>
			parseCustomProvidersManifest(
				JSON.stringify({
					acme: {
						format: "openai-completions",
						base_url: "https://api.acme.example/v1",
						api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_KEY",
						default_model: "m".repeat(MAX_MODEL_ID_LENGTH),
					},
				}),
			),
		).toThrow(/default_model/)
		expect(() =>
			parseCustomProvidersManifest(
				JSON.stringify({
					acme: {
						format: "openai-completions",
						base_url: "https://api.acme.example/v1",
						api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_KEY",
						models: { ["m".repeat(MAX_MODEL_ID_LENGTH)]: { context_window: 128_000 } },
					},
				}),
			),
		).toThrow(/Invalid model ID/)

		// Invalid auth.type / format / header values never interpolate pasted secrets into errors.
		const pastedAuthSecret = "Bearer sk_pasted_into_auth_type_888"
		let authTypeErr: unknown
		try {
			parseCustomProvidersManifest(
				JSON.stringify({
					bad: {
						format: "openai-completions",
						base_url: "https://api.example.com/v1",
						auth: { type: pastedAuthSecret, env: "CHECKFU_PROVIDER_SECRET_BAD_KEY" },
					},
				}),
			)
		} catch (error) {
			authTypeErr = error
		}
		expect(authTypeErr).toBeInstanceOf(CustomProviderConfigError)
		expect(String(authTypeErr)).toContain('Custom provider "bad"')
		expect(String(authTypeErr)).toContain("auth.type")
		expect(String(authTypeErr)).not.toContain(pastedAuthSecret)

		// Uppercase alphanumeric credentials pasted into api_key_env or secret_headers are never
		// echoed back in the disallowed-prefix error message.
		const pastedUppercaseToken = "AKIASECRETTOKEN99998888"
		for (const badEnvManifest of [
			JSON.stringify({
				bad: {
					format: "openai-responses",
					base_url: "https://api.example.com/v1",
					api_key_env: pastedUppercaseToken,
				},
			}),
			JSON.stringify({
				bad: {
					format: "openai-responses",
					base_url: "https://api.example.com/v1",
					api_key_env: GOOD_SECRET_ENV,
					secret_headers: { "x-auth": pastedUppercaseToken },
				},
			}),
		]) {
			let disallowedErr: unknown
			try {
				parseCustomProvidersManifest(badEnvManifest)
			} catch (error) {
				disallowedErr = error
			}
			expect(disallowedErr).toBeInstanceOf(CustomProviderConfigError)
			expect(String(disallowedErr)).toContain("CHECKFU_PROVIDER_SECRET_")
			expect(String(disallowedErr)).not.toContain(pastedUppercaseToken)
		}

		// Duplicate provider IDs in object-form manifests (including Unicode escapes) are rejected
		// instead of silently collapsing to the last entry.
		expect(() =>
			parseCustomProvidersManifest(
				'{"acme":{"format":"openai-completions","base_url":"https://a.example/v1","api_key_env":"CHECKFU_PROVIDER_SECRET_A_KEY"},"acme":{"format":"openai-completions","base_url":"https://b.example/v1","api_key_env":"CHECKFU_PROVIDER_SECRET_B_KEY"}}',
			),
		).toThrow(/Duplicate custom provider id "acme"/)
		expect(() =>
			parseCustomProvidersManifest(
				String.raw`{"\u0061cme":{"format":"openai-completions","base_url":"https://a.example/v1","api_key_env":"CHECKFU_PROVIDER_SECRET_A_KEY"},"acme":{"format":"openai-completions","base_url":"https://b.example/v1","api_key_env":"CHECKFU_PROVIDER_SECRET_B_KEY"}}`,
			),
		).toThrow(/Duplicate custom provider id "acme"/)
		expect(() =>
			parseCustomProvidersManifest(
				'{"acme":{"format":"openai-completions","base_url":"https://a.example/v1","api_key_env":"CHECKFU_PROVIDER_SECRET_A_KEY","headers":{"x-a":"1","x-a":"2"}}}',
			),
		).toThrow(/Duplicate JSON property "x-a"/)
	})

	it("sends exact auth, static headers, and secret_headers across all 3 wire formats and auth modes", async () => {
		const customProviders = parseCustomProvidersManifest(
			JSON.stringify({
				"custom-anthropic-bearer": {
					format: "anthropic-messages",
					base_url: "https://anth.example",
					auth: { type: "bearer", env: "CHECKFU_PROVIDER_SECRET_ANTH_BEARER" },
					headers: { "x-tenant": "acme" },
					secret_headers: { "x-gw": "CHECKFU_PROVIDER_SECRET_ANTH_GW_SECRET" },
				},
				"custom-anthropic-dual": {
					format: "anthropic-messages",
					base_url: "https://anth-dual.example",
					auth: { type: "bearer", env: "CHECKFU_PROVIDER_SECRET_ANTH_BEARER" },
					secret_headers: { "x-api-key": "CHECKFU_PROVIDER_SECRET_ANTH_SECONDARY_KEY" },
				},
				"custom-auth-header-raw": {
					format: "openai-completions",
					base_url: "https://raw-auth.example/v1",
					auth: {
						type: "api_key_header",
						header: "Authorization",
						env: "CHECKFU_PROVIDER_SECRET_RAW_AUTH_HEADER",
					},
				},
				"custom-header-auth": {
					format: "openai-completions",
					base_url: "https://hdr.example/v1",
					auth: {
						type: "api_key_header",
						header: "api-key",
						env: "CHECKFU_PROVIDER_SECRET_HDR_API_KEY",
					},
				},
				"custom-none": {
					format: "openai-completions",
					base_url: "http://127.0.0.1:11434/v1",
					auth: { type: "none" },
					headers: { "x-local": "1" },
				},
			}),
			{ allowLoopbackHttp: true },
		)
		const models = createProviderModels({
			env: {
				CHECKFU_PROVIDER_SECRET_ANTH_BEARER: "tok-anth-bearer",
				CHECKFU_PROVIDER_SECRET_ANTH_GW_SECRET: "sec-gw",
				CHECKFU_PROVIDER_SECRET_ANTH_SECONDARY_KEY: "sec-anth-x-api-key",
				CHECKFU_PROVIDER_SECRET_RAW_AUTH_HEADER: "Token raw-auth-val",
				CHECKFU_PROVIDER_SECRET_HDR_API_KEY: "key-custom-hdr",
			},
			customProviders,
		})

		const completionsSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_c",
				object: "chat.completion.chunk",
				created: 1,
				model: "m",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_c",
				object: "chat.completion.chunk",
				created: 1,
				model: "m",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const anthropicSse = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-custom",
					content: [],
					stop_reason: null,
					usage: { input_tokens: 5, output_tokens: 0 },
				},
			})}\n\n`,
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			})}\n\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "ok-anth" },
			})}\n\n`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 3 },
			})}\n\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
		].join("")

		// 1. Custom Anthropic Messages with explicit Bearer auth + static + secret header
		let capturedAnthropicHeaders: Headers | undefined
		const anthModel = models.getModel("custom-anthropic-bearer", "claude-custom")!
		const anthResult = await models.complete(
			anthModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (_input, init) => {
					capturedAnthropicHeaders = new Headers(init?.headers)
					return new Response(anthropicSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(anthResult.stopReason).toBe("stop")
		expect(capturedAnthropicHeaders?.get("authorization")).toBe("Bearer tok-anth-bearer")
		expect(capturedAnthropicHeaders?.get("x-api-key")).toBeNull()
		expect(capturedAnthropicHeaders?.get("x-tenant")).toBe("acme")
		expect(capturedAnthropicHeaders?.get("x-gw")).toBe("sec-gw")

		// 1b. Custom Anthropic Messages with Bearer + explicit secondary x-api-key preserves both
		let capturedAnthropicDualHeaders: Headers | undefined
		const anthDualModel = models.getModel("custom-anthropic-dual", "claude-custom")!
		const anthDualResult = await models.complete(
			anthDualModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (_input, init) => {
					capturedAnthropicDualHeaders = new Headers(init?.headers)
					return new Response(anthropicSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(anthDualResult.stopReason).toBe("stop")
		expect(capturedAnthropicDualHeaders?.get("authorization")).toBe("Bearer tok-anth-bearer")
		expect(capturedAnthropicDualHeaders?.get("x-api-key")).toBe("sec-anth-x-api-key")

		// 1c. Custom api_key_header naming Authorization preserves the configured value
		let capturedRawAuthHeaders: Headers | undefined
		const rawAuthModel = models.getModel("custom-auth-header-raw", "my-model")!
		const rawAuthResult = await models.complete(
			rawAuthModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (_input, init) => {
					capturedRawAuthHeaders = new Headers(init?.headers)
					return new Response(completionsSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(rawAuthResult.stopReason).toBe("stop")
		expect(capturedRawAuthHeaders?.get("authorization")).toBe("Token raw-auth-val")
		expect(capturedRawAuthHeaders?.get("x-api-key")).toBeNull()

		// 2. Custom OpenAI Completions with custom api_key_header ("api-key")
		let capturedHdrHeaders: Headers | undefined
		const hdrModel = models.getModel("custom-header-auth", "my-model")!
		const hdrResult = await models.complete(
			hdrModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (_input, init) => {
					capturedHdrHeaders = new Headers(init?.headers)
					return new Response(completionsSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(hdrResult.stopReason).toBe("stop")
		expect(capturedHdrHeaders?.get("api-key")).toBe("key-custom-hdr")
		expect(capturedHdrHeaders?.get("authorization")).toBeNull()

		// 3. Unauthenticated local provider (auth: { type: "none" }) strips Authorization/x-api-key
		let capturedNoneHeaders: Headers | undefined
		const noneModel = models.getModel("custom-none", "llama3")!
		const noneResult = await models.complete(
			noneModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (_input, init) => {
					capturedNoneHeaders = new Headers(init?.headers)
					return new Response(completionsSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(noneResult.stopReason).toBe("stop")
		expect(capturedNoneHeaders?.get("authorization")).toBeNull()
		expect(capturedNoneHeaders?.get("x-api-key")).toBeNull()
		expect(capturedNoneHeaders?.get("x-local")).toBe("1")

		// 4. Manifest-declared openai-responses reasoning provider omits reasoning.effort: "none"
		//    on ordinary turns and applies rotated keys + static headers to retained models.
		const xaiInitial = parseCustomProvidersManifest(
			JSON.stringify({
				xai: {
					format: "openai-responses",
					base_url: "https://api.x.ai/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
					headers: { "x-tenant": "tenant-1" },
					models: { "grok-4.6": { reasoning: true } },
				},
			}),
		)
		const xaiRotated = parseCustomProvidersManifest(
			JSON.stringify({
				xai: {
					format: "openai-responses",
					base_url: "https://api.x.ai/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
					headers: { "x-tenant": "tenant-2" },
					models: { "grok-4.6": { reasoning: true } },
				},
			}),
		)
		const xaiModels = createProviderModels({
			env: { CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "xai-key-1" },
			customProviders: xaiInitial,
		})
		const retainedGrok = xaiModels.getModel("xai", "grok-4.6")!
		expect(retainedGrok.headers).toBeUndefined()
		expect(retainedGrok.thinkingLevelMap).toEqual({ off: null })
		const xaiResponseSse = [
			`event: response.completed\ndata: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_xai_1",
					status: "completed",
					output: [
						{
							type: "message",
							id: "msg_xai_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "ok-grok" }],
						},
					],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			})}\n\n`,
		].join("")
		const xaiCaptured: Array<{
			readonly auth: string | null
			readonly tenant: string | null
			readonly hasReasoning: boolean
		}> = []
		const xaiFetch: typeof fetch = async (_input, init) => {
			const headers = new Headers(init?.headers)
			const body =
				typeof init?.body === "string"
					? (JSON.parse(init.body) as { readonly reasoning?: { readonly effort?: string } })
					: {}
			xaiCaptured.push({
				auth: headers.get("authorization"),
				tenant: headers.get("x-tenant"),
				hasReasoning: body.reasoning !== undefined,
			})
			return new Response(xaiResponseSse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}
		await xaiModels.completeSimple(
			retainedGrok,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ fetch: xaiFetch },
		)
		xaiModels.setProvider(
			buildPiProvider(xaiRotated[0]!, {
				env: { CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "xai-key-2" },
			}),
		)
		await xaiModels.completeSimple(
			retainedGrok,
			{ messages: [{ role: "user", content: "hi again", timestamp: 0 }] },
			{ fetch: xaiFetch },
		)
		expect(xaiCaptured).toEqual([
			{ auth: "Bearer xai-key-1", tenant: "tenant-1", hasReasoning: false },
			{ auth: "Bearer xai-key-2", tenant: "tenant-2", hasReasoning: false },
		])
	})
})
