import type { Api, Model } from "@earendil-works/pi-ai"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import {
	getCloudflareAiGatewayCatalogEntry,
	getCloudflareWorkersAiCatalogEntry,
	getOpenRouterCatalogEntry,
	isKnownNonChatModel,
} from "./CatalogIndex.ts"
import type { CatalogIndexEntry } from "./CatalogIndex.ts"
import {
	DEFAULT_MIN_CONTEXT_WINDOW,
	DEFAULT_SYNTHESIZED_CONTEXT_WINDOW,
	MAX_MODEL_ID_LENGTH,
	isWireFormat,
	ownProperty,
} from "./Types.ts"
import type { ProviderModelDefaults, ProviderSpec, WireFormat } from "./Types.ts"

const PRIMARY_STATIC_CATALOGS = new Map<string, Readonly<Record<string, Model<Api>>>>([
	["openai", OPENAI_MODELS],
	["anthropic", ANTHROPIC_MODELS],
])

export const findPrimaryModel = (providerId: string, modelId: string): Model<Api> | undefined => {
	const table = PRIMARY_STATIC_CATALOGS.get(providerId)
	if (table === undefined) {
		return undefined
	}
	return Object.values(table).find((model) => model.id === modelId)
}

const hasControlOrWhitespace = (value: string): boolean => {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i)
		if (code <= 0x20 || code === 0x7f) {
			return true
		}
	}
	return /\s/.test(value)
}

export const isValidModelId = (modelId: string): boolean =>
	modelId.length > 0 && modelId.length <= MAX_MODEL_ID_LENGTH && !hasControlOrWhitespace(modelId)

const LEGACY_OPENAI_BASE_ALIASES = new Map<string, string>([
	["gpt-4-turbo-preview", "gpt-4-turbo"],
	["gpt-4-0125-preview", "gpt-4-turbo"],
	["gpt-4-1106-preview", "gpt-4-turbo"],
	["gpt-4-vision-preview", "gpt-4-turbo"],
	["gpt-4-1106-vision-preview", "gpt-4-turbo"],
])

export const stripOpenAISnapshotSuffix = (modelId: string): string | undefined => {
	const withoutIsoDate = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "")
	if (withoutIsoDate !== modelId && withoutIsoDate.length > 0) {
		return withoutIsoDate
	}
	const withoutLegacyDate = modelId.replace(/-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/, "")
	return withoutLegacyDate !== modelId && withoutLegacyDate.length > 0
		? withoutLegacyDate
		: undefined
}

const appendUniqueCandidate = (list: Array<string>, value: string | undefined): void => {
	if (value !== undefined && value.length > 0 && !list.includes(value)) {
		list.push(value)
	}
}

export const openAIFineTuneBaseCandidates = (modelId: string): ReadonlyArray<string> => {
	if (!modelId.startsWith("ft:")) {
		return []
	}
	const rest = modelId.slice(3)
	const nextColon = rest.indexOf(":")
	if (nextColon <= 0 || nextColon >= rest.length - 1) {
		return []
	}
	const rawBase = rest.slice(0, nextColon)
	const candidates: Array<string> = [rawBase]
	appendUniqueCandidate(candidates, LEGACY_OPENAI_BASE_ALIASES.get(rawBase))
	appendUniqueCandidate(candidates, stripOpenAISnapshotSuffix(rawBase))
	return candidates
}

export const openAIBaseModelCandidates = (modelId: string): ReadonlyArray<string> => {
	const fineTuneCandidates = openAIFineTuneBaseCandidates(modelId)
	if (fineTuneCandidates.length > 0) {
		return fineTuneCandidates
	}
	const candidates: Array<string> = []
	appendUniqueCandidate(candidates, LEGACY_OPENAI_BASE_ALIASES.get(modelId))
	appendUniqueCandidate(candidates, stripOpenAISnapshotSuffix(modelId))
	return candidates
}

const openAIModelFamilyCandidates = (modelId: string): ReadonlyArray<string> => {
	const fineTuneCandidates = openAIFineTuneBaseCandidates(modelId)
	if (fineTuneCandidates.length > 0) {
		return fineTuneCandidates
	}
	return [modelId, ...openAIBaseModelCandidates(modelId)]
}

export const findLegacyOpenAIModelLimits = (
	modelId: string,
): { readonly contextWindow: number; readonly maxTokens: number } | undefined => {
	for (const candidate of openAIModelFamilyCandidates(modelId)) {
		const normalized = stripOpenAISnapshotSuffix(candidate) ?? candidate
		if (normalized === "computer-use-preview") {
			return { contextWindow: 8192, maxTokens: 1024 }
		}
		if (normalized === "gpt-4-32k") {
			return { contextWindow: 32_768, maxTokens: 4096 }
		}
		if (candidate === "gpt-3.5-turbo-0301" || candidate === "gpt-3.5-turbo-0613") {
			return { contextWindow: 4096, maxTokens: 4096 }
		}
		if (normalized === "gpt-3.5-turbo" || normalized === "gpt-3.5-turbo-16k") {
			return { contextWindow: 16_385, maxTokens: 4096 }
		}
	}
	return undefined
}

// Exact catalog entries are resolved before this check. Retired OpenAI families
// have no reliable Day-1 defaults, including snapshots and fine-tuned copies.
const isHistoricalOpenAIModel = (id: string): boolean => {
	const base = id.startsWith("ft:") ? (id.split(":")[1] ?? "") : (id.split(":")[0] ?? "")
	return /^(?:gpt-3\.5-turbo|gpt-4|computer-use-preview|o1)(?:-|$)/u.test(base)
}

// These IDs lost their catalog descriptors in Pi 1.7. Exact, derived and explicitly
// declared models are resolved before the generic unlisted fallback.
const OPENAI_MODELS_WITHOUT_CATALOG_LIMITS = new Set([
	"gpt-4.1-nano",
	"gpt-4o-2024-05-13",
	"gpt-5-chat-latest",
	"gpt-5.3-codex-spark",
	"o3-mini",
	"o4-mini",
])
const OPENROUTER_MODELS_WITHOUT_CATALOG_LIMITS = new Set([
	"dots-studio/dots-3-note-preview:free",
	"inclusionai/ling-3.2-flash:free",
	"meituan/longcat-2.0",
	"mistralai/mistral-medium-3",
	"mistralai/mistral-medium-3.1",
	"moonshotai/kimi-k2-thinking",
	"tencent/hy3-preview",
	"unbiased/pareto-26.10",
	"unbiased/pareto-26.10-preview",
	"unbiased/pareto-26.9",
	"xiaomi/mimo-v2.5",
	"xiaomi/mimo-v2.5-pro",
	"~unbiased/pareto-latest",
])
const WORKERS_AI_MODELS_WITHOUT_CATALOG_LIMITS = new Set([
	"@cf/deepseek-ai/deepseek-v4-flash-0731",
	"@cf/deepseek-ai/deepseek-v4-pro-0813",
	"@cf/moonshotai/kimi-k2.6",
	"@cf/moonshotai/kimi-k2.7-code",
	"@cf/nvidia/nemotron-3-120b-a12b",
	"@cf/qwen/qwen3-30b-a3b-fp8",
	"@cf/zai-org/glm-5.2",
	"@cf/zai-org/glm-5.3-flash",
])

const OPENAI_NON_CHAT_PREFIXES = [
	"text-embedding-",
	"text-davinci-",
	"code-davinci-",
	"text-curie-",
	"text-babbage-",
	"text-ada-",
	"gpt-3.5-turbo-instruct-",
	"whisper-",
	"tts-",
	"dall-e-",
	"gpt-image-",
	"chatgpt-image-",
	"sora-",
	"omni-moderation-",
	"text-moderation-",
] as const

const OPENAI_NON_CHAT_EXACT = new Set([
	"ada",
	"babbage",
	"babbage-002",
	"curie",
	"curie-instruct-beta",
	"davinci",
	"davinci-002",
	"davinci-instruct-beta",
	"gpt-3.5-turbo-instruct",
])

const OPENAI_NON_CHAT_SEGMENT = /(?:^|-)(?:transcribe|tts|realtime)(?:-|$)/

export const isKnownNonChatOpenAIModel = (modelId: string): boolean => {
	for (const candidate of openAIModelFamilyCandidates(modelId)) {
		const normalized = stripOpenAISnapshotSuffix(candidate) ?? candidate
		if (
			OPENAI_NON_CHAT_EXACT.has(normalized) ||
			OPENAI_NON_CHAT_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
			OPENAI_NON_CHAT_SEGMENT.test(normalized)
		) {
			return true
		}
	}
	return false
}

const OPENAI_RESPONSES_UNSUPPORTED_PREFIXES = ["gpt-audio-", "gpt-5-search-api-"] as const
const OPENAI_RESPONSES_UNSUPPORTED_EXACT = new Set(["gpt-audio", "gpt-5-search-api"])
const OPENAI_RESPONSES_UNSUPPORTED_SEGMENT = /(?:^|-)(?:audio|search)-preview(?:-|$)/

export const isKnownOpenAIResponsesUnsupportedModel = (modelId: string): boolean => {
	for (const candidate of openAIModelFamilyCandidates(modelId)) {
		const normalized = stripOpenAISnapshotSuffix(candidate) ?? candidate
		if (
			OPENAI_RESPONSES_UNSUPPORTED_EXACT.has(normalized) ||
			OPENAI_RESPONSES_UNSUPPORTED_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
			OPENAI_RESPONSES_UNSUPPORTED_SEGMENT.test(normalized)
		) {
			return true
		}
	}
	return false
}

const WORKERS_AI_NON_CHAT_PREFIXES = [
	"@cf/baai/bge-",
	"@cf/openai/whisper",
	"@cf/deepgram/",
	"@cf/myshell-ai/melotts",
	"@cf/stabilityai/",
	"@cf/black-forest-labs/",
	"@cf/leonardo/",
	"@cf/runwayml/",
	"@cf/lykon/",
	"@cf/bytedance/stable-diffusion",
	"@cf/microsoft/resnet-",
	"@cf/meta/llama-guard-",
] as const

const WORKERS_AI_NON_CHAT_SEGMENT =
	/(?:^|[-/])(?:embedding|embeddings|embeddinggemma|reranker|llama-guard|speech-streaming|stable-diffusion|inpainting)(?:[-/.]|$)/i

export const isKnownNonChatWorkersAiModel = (modelId: string): boolean =>
	WORKERS_AI_NON_CHAT_PREFIXES.some((prefix) => modelId.startsWith(prefix)) ||
	WORKERS_AI_NON_CHAT_SEGMENT.test(modelId)

const OPENROUTER_NON_CHAT_PREFIXES = [
	"baai/bge-",
	"intfloat/",
	"sentence-transformers/",
	"thenlper/gte-",
	"voyageai/",
] as const

const OPENROUTER_NON_CHAT_SEGMENT =
	/(?:^|[-/])(?:embed|embedding|embeddings|embeddinggemma|rerank|reranker)(?:[-/.]|$)/i

export const isKnownNonChatOpenRouterModel = (modelId: string): boolean => {
	const baseId = stripVariantSuffix(modelId)
	return (
		OPENROUTER_NON_CHAT_PREFIXES.some((prefix) => baseId.startsWith(prefix)) ||
		OPENROUTER_NON_CHAT_SEGMENT.test(baseId)
	)
}

const TEXT_ONLY_INPUT = ["text"] as const
const TEXT_AND_IMAGE_INPUT = ["text", "image"] as const

interface KnownWorkersAiModelSpec {
	readonly contextWindow: number
	readonly reasoning: boolean
	readonly input: ReadonlyArray<"text" | "image">
}

// Documented context windows and capabilities for Cloudflare Workers AI chat models
// that are not listed in pi-ai's curated `CLOUDFLARE_WORKERS_AI_MODELS` catalog.
// Keeping their true limits and modalities prevents Day-1 synthesis from admitting
// undersized legacy models, overstating context limits, or advertising unsupported
// image/reasoning capabilities.
const KNOWN_WORKERS_AI_GROUPS: ReadonlyArray<
	readonly [
		contextWindow: number,
		reasoning: boolean,
		input: ReadonlyArray<"text" | "image">,
		ids: string,
	]
> = [
	[
		2048,
		false,
		TEXT_ONLY_INPUT,
		"@cf/tinyllama/tinyllama-1.1b-chat-v1.0 @cf/microsoft/phi-2 @cf/tiiuae/falcon-7b-instruct",
	],
	[
		4096,
		false,
		TEXT_ONLY_INPUT,
		"@cf/meta/llama-2-7b-chat-int8 @cf/meta/llama-2-7b-chat-fp16 @cf/meta-llama/llama-2-7b-chat-hf-lora @hf/thebloke/llama-2-13b-chat-awq @cf/deepseek-ai/deepseek-math-7b-instruct @cf/defog/sqlcoder-7b-2 @hf/thebloke/zephyr-7b-beta-awq @cf/thebloke/discolm-german-7b-v1-awq @hf/thebloke/neural-chat-7b-v3-1-awq @cf/fblgit/una-cybertron-7b-v2-bf16",
	],
	[7968, false, TEXT_ONLY_INPUT, "@cf/meta/llama-3.1-8b-instruct"],
	[
		8192,
		false,
		TEXT_ONLY_INPUT,
		"@cf/mistral/mistral-7b-instruct-v0.1 @hf/thebloke/mistral-7b-instruct-v0.1-awq @hf/thebloke/openhermes-2.5-mistral-7b-awq @cf/openchat/openchat-3.5-0106 @hf/nexusflow/starling-lm-7b-beta @hf/google/gemma-7b-it @cf/google/gemma-2b-it-lora @cf/google/gemma-7b-it-lora @cf/meta/llama-3-8b-instruct @cf/meta/llama-3-8b-instruct-awq @cf/meta/llama-3.1-8b-instruct-awq",
	],
	[15_000, false, TEXT_ONLY_INPUT, "@cf/mistral/mistral-7b-instruct-v0.2-lora"],
	[
		16_384,
		false,
		TEXT_ONLY_INPUT,
		"@hf/thebloke/deepseek-coder-6.7b-base-awq @hf/thebloke/deepseek-coder-6.7b-instruct-awq",
	],
	[
		24_000,
		false,
		TEXT_ONLY_INPUT,
		"@hf/nousresearch/hermes-2-pro-mistral-7b @cf/meta/llama-3.1-70b-instruct",
	],
	[24_000, true, TEXT_ONLY_INPUT, "@cf/qwen/qwq-32b"],
	[32_000, false, TEXT_ONLY_INPUT, "@cf/meta/llama-3.1-8b-instruct-fp8"],
	[
		32_768,
		false,
		TEXT_ONLY_INPUT,
		"@hf/mistral/mistral-7b-instruct-v0.2 @cf/qwen/qwen1.5-0.5b-chat @cf/qwen/qwen1.5-1.8b-chat @cf/qwen/qwen1.5-7b-chat-awq @cf/qwen/qwen1.5-14b-chat-awq @cf/qwen/qwen2.5-coder-32b-instruct",
	],
	[60_000, false, TEXT_ONLY_INPUT, "@cf/meta/llama-3.2-1b-instruct"],
	[80_000, false, TEXT_ONLY_INPUT, "@cf/meta/llama-3.2-3b-instruct"],
	[80_000, true, TEXT_ONLY_INPUT, "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"],
	[80_000, false, TEXT_AND_IMAGE_INPUT, "@cf/google/gemma-3-12b-it"],
	[128_000, false, TEXT_AND_IMAGE_INPUT, "@cf/meta/llama-3.2-11b-vision-instruct"],
]

let knownWorkersAiSpecCache: ReadonlyMap<string, KnownWorkersAiModelSpec> | undefined

const findKnownWorkersAiModelSpec = (modelId: string): KnownWorkersAiModelSpec | undefined => {
	if (knownWorkersAiSpecCache === undefined) {
		const map = new Map<string, KnownWorkersAiModelSpec>()
		for (const [contextWindow, reasoning, input, ids] of KNOWN_WORKERS_AI_GROUPS) {
			const info: KnownWorkersAiModelSpec = { contextWindow, reasoning, input }
			for (const id of ids.split(" ")) {
				map.set(id, info)
			}
		}
		knownWorkersAiSpecCache = map
	}
	return knownWorkersAiSpecCache.get(modelId)
}

const resolveKnownWorkersAiPlan = (
	spec: ProviderSpec,
	modelId: string,
	wireModelId: string,
	route: ModelRoute,
	minContextWindow: number,
	known: KnownWorkersAiModelSpec,
): ResolvedProviderModelPlan | undefined => {
	const declared = ownProperty(spec.models, modelId)
	if (declared === undefined && spec.allowUnlistedModels === false) {
		return undefined
	}
	const defaults = mergeModelDefaults(
		{
			contextWindow: known.contextWindow,
			maxTokens: Math.min(4096, known.contextWindow),
			reasoning: known.reasoning,
			input: known.input,
		},
		declared,
	)
	const contextWindow = defaults.contextWindow ?? known.contextWindow
	if (contextWindow < minContextWindow) {
		return undefined
	}
	return {
		kind: "synthesized",
		cataloged: declared !== undefined,
		wireModelId,
		format: "openai-completions",
		route,
		contextWindow,
		defaults,
	}
}

export const anthropicBaseModelCandidates = (modelId: string): ReadonlyArray<string> => {
	const undated = modelId.replace(/-\d{8}$/, "")
	return undated !== modelId && undated.length > 0 ? [undated] : []
}

export const stripVariantSuffix = (modelId: string): string => {
	const colonIndex = modelId.indexOf(":")
	return colonIndex === -1 ? modelId : modelId.slice(0, colonIndex)
}

export const isFreeVariantId = (modelId: string): boolean => {
	const colonIndex = modelId.indexOf(":")
	return colonIndex !== -1 && modelId.slice(colonIndex) === ":free"
}

export const mergeModelDefaults = (
	base: ProviderModelDefaults | undefined,
	override: ProviderModelDefaults | undefined,
): ProviderModelDefaults => ({
	...(base?.contextWindow === undefined ? {} : { contextWindow: base.contextWindow }),
	...(override?.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
	...(base?.maxTokens === undefined ? {} : { maxTokens: base.maxTokens }),
	...(override?.maxTokens === undefined ? {} : { maxTokens: override.maxTokens }),
	...(base?.reasoning === undefined ? {} : { reasoning: base.reasoning }),
	...(override?.reasoning === undefined ? {} : { reasoning: override.reasoning }),
	...(base?.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: base.thinkingLevelMap }),
	...(override?.thinkingLevelMap === undefined
		? {}
		: { thinkingLevelMap: override.thinkingLevelMap }),
	...(base?.input === undefined ? {} : { input: base.input }),
	...(override?.input === undefined ? {} : { input: override.input }),
	...(base?.openAICompletionsCompat === undefined
		? {}
		: { openAICompletionsCompat: base.openAICompletionsCompat }),
	...(override?.openAICompletionsCompat === undefined
		? {}
		: { openAICompletionsCompat: override.openAICompletionsCompat }),
	...(base?.openAIResponsesCompat === undefined
		? {}
		: { openAIResponsesCompat: base.openAIResponsesCompat }),
	...(override?.openAIResponsesCompat === undefined
		? {}
		: { openAIResponsesCompat: override.openAIResponsesCompat }),
	...(base?.anthropicMessagesCompat === undefined
		? {}
		: { anthropicMessagesCompat: base.anthropicMessagesCompat }),
	...(override?.anthropicMessagesCompat === undefined
		? {}
		: { anthropicMessagesCompat: override.anthropicMessagesCompat }),
})

export type ModelRoute =
	| "default"
	| "openrouter-anthropic"
	| "openrouter-completions"
	| "gateway-anthropic"
	| "gateway-openai"
	| "gateway-compat"
	| "workers-ai"

export type ResolvedProviderModelPlan =
	| {
			readonly kind: "primary"
			readonly cataloged: boolean
			readonly wireModelId: string
			readonly route: ModelRoute
			readonly model: Model<Api>
			readonly isFreeVariant?: boolean
	  }
	| {
			readonly kind: "indexed"
			readonly cataloged: boolean
			readonly wireModelId: string
			readonly format: WireFormat
			readonly route: ModelRoute
			readonly entry: CatalogIndexEntry
			readonly isVariantFallback?: boolean
			readonly isFreeVariant?: boolean
	  }
	| {
			readonly kind: "synthesized"
			readonly cataloged: boolean
			readonly wireModelId: string
			readonly format: WireFormat
			readonly route: ModelRoute
			readonly contextWindow: number
			readonly defaults: ProviderModelDefaults
	  }

const isGatewayAnthropicModelId = (modelId: string): boolean =>
	!modelId.includes("/") && modelId.startsWith("claude-")

const isGatewayOpenAIModelId = (modelId: string): boolean =>
	!modelId.includes("/") &&
	(modelId.startsWith("gpt-") ||
		modelId.startsWith("chatgpt-") ||
		modelId.startsWith("o1") ||
		modelId.startsWith("o3") ||
		modelId.startsWith("o4"))

const isValidNativeGatewayTarget = (target: string): boolean =>
	target.length > 0 && !target.includes("/")

const isProviderQualifiedGatewayCompatTarget = (modelId: string): boolean => {
	const slashIndex = modelId.indexOf("/")
	return slashIndex > 0 && slashIndex < modelId.length - 1 && modelId[slashIndex + 1] !== "/"
}

const lacksCatalogLimits = (provider: string, modelId: string): boolean => {
	const openRouterId =
		provider === "openrouter"
			? modelId
			: provider === "cloudflare-ai-gateway" && modelId.startsWith("openrouter/")
				? modelId.slice("openrouter/".length)
				: undefined
	if (
		openRouterId !== undefined &&
		(OPENROUTER_MODELS_WITHOUT_CATALOG_LIMITS.has(openRouterId) ||
			OPENROUTER_MODELS_WITHOUT_CATALOG_LIMITS.has(stripVariantSuffix(openRouterId)))
	) {
		return true
	}
	if (
		(provider === "cloudflare-workers-ai" || provider === "cloudflare-ai-gateway") &&
		WORKERS_AI_MODELS_WITHOUT_CATALOG_LIMITS.has(modelId.replace(/^workers-ai\//u, ""))
	) {
		return true
	}
	const routedId = openRouterId === undefined ? modelId : stripVariantSuffix(openRouterId)
	const openAIId =
		provider === "openai" || (provider === "cloudflare-ai-gateway" && !routedId.includes("/"))
			? routedId
			: routedId.startsWith("openai/") &&
				  (openRouterId !== undefined || provider === "cloudflare-ai-gateway")
				? routedId.slice("openai/".length)
				: undefined
	return (
		openAIId !== undefined &&
		(isHistoricalOpenAIModel(openAIId) ||
			openAIModelFamilyCandidates(openAIId).some((id) =>
				OPENAI_MODELS_WITHOUT_CATALOG_LIMITS.has(id),
			))
	)
}

const resolveDeclaredOrUnlisted = (
	spec: ProviderSpec,
	modelId: string,
	wireModelId: string,
	format: WireFormat,
	route: ModelRoute,
	minContextWindow: number,
): ResolvedProviderModelPlan | undefined => {
	const declared = ownProperty(spec.models, modelId)
	if (
		declared === undefined &&
		(spec.allowUnlistedModels === false || lacksCatalogLimits(spec.id, modelId))
	) {
		return undefined
	}
	const defaults = mergeModelDefaults(spec.modelDefaults, declared)
	const contextWindow = defaults.contextWindow ?? DEFAULT_SYNTHESIZED_CONTEXT_WINDOW
	if (contextWindow < minContextWindow) {
		return undefined
	}
	return {
		kind: "synthesized",
		cataloged: declared !== undefined,
		wireModelId,
		format,
		route,
		contextWindow,
		defaults,
	}
}

type UpstreamPrimaryMatch =
	| { readonly matched: false }
	| {
			readonly matched: true
			readonly kind: "rejected"
	  }
	| {
			readonly matched: true
			readonly kind: "primary"
			readonly cataloged: boolean
			readonly model: Model<Api>
	  }
	| {
			readonly matched: true
			readonly kind: "legacy"
			readonly contextWindow: number
			readonly maxTokens: number
	  }

const findUpstreamPrimaryOrDerived = (
	upstream: "openai" | "anthropic",
	wireId: string,
): UpstreamPrimaryMatch => {
	if (isKnownNonChatModel(upstream, wireId)) {
		return { matched: true, kind: "rejected" }
	}
	const exact = findPrimaryModel(upstream, wireId)
	if (exact !== undefined) {
		return { matched: true, kind: "primary", cataloged: true, model: exact }
	}
	if (upstream === "openai" && isKnownNonChatOpenAIModel(wireId)) {
		return { matched: true, kind: "rejected" }
	}
	const candidates =
		upstream === "openai" ? openAIBaseModelCandidates(wireId) : anthropicBaseModelCandidates(wireId)
	for (const candidate of candidates) {
		if (isKnownNonChatModel(upstream, candidate)) {
			return { matched: true, kind: "rejected" }
		}
		const baseModel = findPrimaryModel(upstream, candidate)
		if (baseModel !== undefined) {
			return { matched: true, kind: "primary", cataloged: false, model: baseModel }
		}
	}
	if (upstream === "openai") {
		const legacyLimits = findLegacyOpenAIModelLimits(wireId)
		if (legacyLimits !== undefined) {
			return {
				matched: true,
				kind: "legacy",
				contextWindow: legacyLimits.contextWindow,
				maxTokens: legacyLimits.maxTokens,
			}
		}
	}
	return { matched: false }
}

const materializeUpstreamMatch = (
	spec: ProviderSpec,
	modelId: string,
	wireModelId: string,
	format: WireFormat,
	route: ModelRoute,
	minContextWindow: number,
	matched: Exclude<UpstreamPrimaryMatch, { readonly matched: false }>,
	options?: { readonly forceUnlisted?: boolean; readonly isFreeVariant?: boolean },
): ResolvedProviderModelPlan | undefined => {
	if (matched.kind === "rejected") {
		return undefined
	}
	if (matched.kind === "legacy") {
		if (spec.allowUnlistedModels === false && ownProperty(spec.models, modelId) === undefined) {
			return undefined
		}
		return matched.contextWindow >= minContextWindow
			? {
					kind: "synthesized",
					cataloged: false,
					wireModelId,
					format,
					route,
					contextWindow: matched.contextWindow,
					defaults: {
						contextWindow: matched.contextWindow,
						maxTokens: matched.maxTokens,
						reasoning: false,
					},
				}
			: undefined
	}
	const cataloged = matched.cataloged && options?.forceUnlisted !== true
	if (
		!cataloged &&
		spec.allowUnlistedModels === false &&
		ownProperty(spec.models, modelId) === undefined
	) {
		return undefined
	}
	return matched.model.contextWindow >= minContextWindow
		? {
				kind: "primary",
				cataloged,
				wireModelId: route === "default" && cataloged ? matched.model.id : wireModelId,
				route,
				model: matched.model,
				...(options?.isFreeVariant === true ? { isFreeVariant: true } : {}),
			}
		: undefined
}

const openRouterAnthropicBaseCandidates = (modelId: string): ReadonlyArray<string> => {
	const candidates: Array<string> = []
	const add = (value: string | undefined) => {
		if (
			value !== undefined &&
			value !== modelId &&
			value.length > 0 &&
			!candidates.includes(value)
		) {
			candidates.push(value)
		}
	}
	const undated = anthropicBaseModelCandidates(modelId)[0]
	add(undated)
	add(modelId.replace(/-(\d+)-(\d+)$/, "-$1.$2"))
	if (undated !== undefined) {
		add(undated.replace(/-(\d+)-(\d+)$/, "-$1.$2"))
	}
	return candidates
}

const findOpenRouterCatalogBaseEntry = (
	openRouterId: string,
	baseId: string,
	requireAnthropicMessages = false,
): CatalogIndexEntry | undefined => {
	const matches = (entry: CatalogIndexEntry | undefined): CatalogIndexEntry | undefined =>
		entry !== undefined && (!requireAnthropicMessages || entry.api === "anthropic-messages")
			? entry
			: undefined
	if (baseId !== openRouterId) {
		const exactBase = matches(getOpenRouterCatalogEntry(baseId))
		if (exactBase !== undefined) {
			return exactBase
		}
	}
	if (baseId.startsWith("anthropic/") || baseId.startsWith("~anthropic/")) {
		for (const candidate of openRouterAnthropicBaseCandidates(baseId)) {
			const entry = matches(getOpenRouterCatalogEntry(candidate))
			if (entry !== undefined) {
				return entry
			}
		}
	}
	if (baseId.startsWith("openai/")) {
		for (const candidate of openAIBaseModelCandidates(baseId.slice("openai/".length))) {
			const entry = matches(getOpenRouterCatalogEntry(`openai/${candidate}`))
			if (entry !== undefined) {
				return entry
			}
		}
	}
	return undefined
}

const findOpenRouterUpstreamPrimary = (baseId: string): UpstreamPrimaryMatch => {
	if (baseId.startsWith("anthropic/") || baseId.startsWith("~anthropic/")) {
		return findUpstreamPrimaryOrDerived(
			"anthropic",
			baseId.replace(/^~?anthropic\//, "").replaceAll(".", "-"),
		)
	}
	if (baseId.startsWith("openai/")) {
		return findUpstreamPrimaryOrDerived("openai", baseId.slice("openai/".length))
	}
	return { matched: false }
}

const resolveOpenRouterTargetPlan = (
	spec: ProviderSpec,
	lookupModelId: string,
	openRouterId: string,
	minContextWindow: number,
	mode: "direct" | "gateway",
): ResolvedProviderModelPlan | undefined => {
	if (openRouterId.length === 0 || isKnownNonChatModel("openrouter", openRouterId)) {
		return undefined
	}

	const exact = getOpenRouterCatalogEntry(openRouterId)
	if (exact !== undefined) {
		if (exact.contextWindow < minContextWindow) {
			return undefined
		}
		if (mode === "gateway") {
			return {
				kind: "indexed",
				cataloged: true,
				wireModelId: lookupModelId,
				format: "openai-completions",
				route: "gateway-compat",
				entry: exact,
			}
		}
		return {
			kind: "indexed",
			cataloged: true,
			wireModelId: openRouterId,
			format: exact.api,
			route: exact.api === "anthropic-messages" ? "openrouter-anthropic" : "openrouter-completions",
			entry: exact,
		}
	}

	const baseId = stripVariantSuffix(openRouterId)
	if (baseId !== openRouterId && isKnownNonChatModel("openrouter", baseId)) {
		return undefined
	}
	if (isKnownNonChatOpenRouterModel(baseId)) {
		return undefined
	}

	// Variant suffixes (e.g. :free, :nitro, :batch) always travel on OpenRouter's
	// OpenAI-compatible route because OpenRouter's Anthropic Messages route rejects variants.
	const isDirectAnthropicRoute =
		mode === "direct" &&
		baseId === openRouterId &&
		(openRouterId.startsWith("anthropic/claude-") || openRouterId.startsWith("~anthropic/claude-"))
	const format: WireFormat = isDirectAnthropicRoute ? "anthropic-messages" : "openai-completions"
	const route: ModelRoute =
		mode === "gateway"
			? "gateway-compat"
			: isDirectAnthropicRoute
				? "openrouter-anthropic"
				: "openrouter-completions"

	// Prefer OpenRouter's own indexed base entry across native, variant, and Gateway routes
	// before falling back to upstream vendor catalogs so context limits and capabilities stay
	// consistent regardless of how the OpenRouter request is routed.
	const baseEntry = findOpenRouterCatalogBaseEntry(openRouterId, baseId, isDirectAnthropicRoute)
	if (baseEntry !== undefined) {
		if (
			spec.allowUnlistedModels === false &&
			ownProperty(spec.models, lookupModelId) === undefined
		) {
			return undefined
		}
		if (baseEntry.contextWindow < minContextWindow) {
			return undefined
		}
		return {
			kind: "indexed",
			cataloged: false,
			wireModelId: lookupModelId,
			format,
			route,
			entry: baseEntry,
			...(mode === "direct" && baseId !== openRouterId ? { isVariantFallback: true } : {}),
			...(isFreeVariantId(openRouterId) ? { isFreeVariant: true } : {}),
		}
	}

	const upstream = findOpenRouterUpstreamPrimary(baseId)
	if (upstream.matched) {
		return materializeUpstreamMatch(
			spec,
			lookupModelId,
			lookupModelId,
			format,
			route,
			minContextWindow,
			upstream,
			{
				forceUnlisted: true,
				...(isFreeVariantId(openRouterId) ? { isFreeVariant: true } : {}),
			},
		)
	}

	return resolveDeclaredOrUnlisted(
		spec,
		lookupModelId,
		lookupModelId,
		format,
		route,
		minContextWindow,
	)
}

const resolveOpenRouterModelPlan = (
	spec: ProviderSpec,
	modelId: string,
	minContextWindow: number,
): ResolvedProviderModelPlan | undefined =>
	resolveOpenRouterTargetPlan(spec, modelId, modelId, minContextWindow, "direct")

type GatewayDerivedBaseLookup =
	| { readonly matched: false }
	| { readonly matched: true; readonly plan: ResolvedProviderModelPlan | undefined }

const resolveGatewayDerivedBase = (
	spec: ProviderSpec,
	modelId: string,
	wireId: string,
	upstream: "openai" | "anthropic",
	minContextWindow: number,
): GatewayDerivedBaseLookup => {
	const candidates =
		upstream === "openai" ? openAIBaseModelCandidates(wireId) : anthropicBaseModelCandidates(wireId)
	const expectedApi: WireFormat = upstream === "openai" ? "openai-responses" : "anthropic-messages"
	const route: ModelRoute = upstream === "openai" ? "gateway-openai" : "gateway-anthropic"

	for (const baseCandidate of candidates) {
		if (
			isKnownNonChatModel(upstream, baseCandidate) ||
			isKnownNonChatModel("cloudflare-ai-gateway", baseCandidate)
		) {
			return { matched: true, plan: undefined }
		}
		const gatewayBase = getCloudflareAiGatewayCatalogEntry(baseCandidate)
		if (gatewayBase !== undefined && gatewayBase.api === expectedApi) {
			if (spec.allowUnlistedModels === false && ownProperty(spec.models, modelId) === undefined) {
				return { matched: true, plan: undefined }
			}
			return {
				matched: true,
				plan:
					gatewayBase.contextWindow >= minContextWindow
						? {
								kind: "indexed",
								cataloged: false,
								wireModelId: wireId,
								format: expectedApi,
								route,
								entry: gatewayBase,
							}
						: undefined,
			}
		}
		const primaryBase = findPrimaryModel(upstream, baseCandidate)
		if (primaryBase !== undefined) {
			if (spec.allowUnlistedModels === false && ownProperty(spec.models, modelId) === undefined) {
				return { matched: true, plan: undefined }
			}
			return {
				matched: true,
				plan:
					primaryBase.contextWindow >= minContextWindow
						? {
								kind: "primary",
								cataloged: false,
								wireModelId: wireId,
								route,
								model: primaryBase,
							}
						: undefined,
			}
		}
	}
	if (upstream === "openai") {
		const legacyLimits = findLegacyOpenAIModelLimits(wireId)
		if (legacyLimits !== undefined) {
			if (spec.allowUnlistedModels === false && ownProperty(spec.models, modelId) === undefined) {
				return { matched: true, plan: undefined }
			}
			return {
				matched: true,
				plan:
					legacyLimits.contextWindow >= minContextWindow
						? {
								kind: "synthesized",
								cataloged: false,
								wireModelId: wireId,
								format: expectedApi,
								route,
								contextWindow: legacyLimits.contextWindow,
								defaults: {
									contextWindow: legacyLimits.contextWindow,
									maxTokens: legacyLimits.maxTokens,
									reasoning: false,
								},
							}
						: undefined,
			}
		}
	}
	return { matched: false }
}

const resolveCloudflareGatewayModelPlan = (
	spec: ProviderSpec,
	modelId: string,
	minContextWindow: number,
): ResolvedProviderModelPlan | undefined => {
	if (modelId.endsWith("/")) {
		return undefined
	}

	// 1. Explicit native Anthropic Messages route (`anthropic/<wireId>`)
	if (modelId.startsWith("anthropic/")) {
		const wireId = modelId.slice("anthropic/".length)
		if (
			!isValidNativeGatewayTarget(wireId) ||
			isKnownNonChatModel("anthropic", wireId) ||
			isKnownNonChatModel("cloudflare-ai-gateway", wireId)
		) {
			return undefined
		}
		const gatewayEntry = getCloudflareAiGatewayCatalogEntry(wireId)
		if (gatewayEntry !== undefined && gatewayEntry.api === "anthropic-messages") {
			return gatewayEntry.contextWindow >= minContextWindow
				? {
						kind: "indexed",
						cataloged: true,
						wireModelId: wireId,
						format: "anthropic-messages",
						route: "gateway-anthropic",
						entry: gatewayEntry,
					}
				: undefined
		}
		const primary = findPrimaryModel("anthropic", wireId)
		if (primary !== undefined) {
			return primary.contextWindow >= minContextWindow
				? {
						kind: "primary",
						cataloged: true,
						wireModelId: wireId,
						route: "gateway-anthropic",
						model: primary,
					}
				: undefined
		}
		const derivedAnthropic = resolveGatewayDerivedBase(
			spec,
			modelId,
			wireId,
			"anthropic",
			minContextWindow,
		)
		if (derivedAnthropic.matched) {
			return derivedAnthropic.plan
		}
		return resolveDeclaredOrUnlisted(
			spec,
			modelId,
			wireId,
			"anthropic-messages",
			"gateway-anthropic",
			minContextWindow,
		)
	}

	// 2. Explicit native OpenAI Responses route (`openai/<wireId>`, including fine-tunes & dated snapshots)
	if (modelId.startsWith("openai/")) {
		const wireId = modelId.slice("openai/".length)
		if (
			!isValidNativeGatewayTarget(wireId) ||
			isKnownNonChatModel("openai", wireId) ||
			isKnownNonChatModel("cloudflare-ai-gateway", wireId)
		) {
			return undefined
		}
		const gatewayEntry = getCloudflareAiGatewayCatalogEntry(wireId)
		if (gatewayEntry !== undefined && gatewayEntry.api === "openai-responses") {
			return gatewayEntry.contextWindow >= minContextWindow
				? {
						kind: "indexed",
						cataloged: true,
						wireModelId: wireId,
						format: "openai-responses",
						route: "gateway-openai",
						entry: gatewayEntry,
					}
				: undefined
		}
		const primary = findPrimaryModel("openai", wireId)
		if (primary !== undefined) {
			return primary.contextWindow >= minContextWindow
				? {
						kind: "primary",
						cataloged: true,
						wireModelId: wireId,
						route: "gateway-openai",
						model: primary,
					}
				: undefined
		}
		if (isKnownNonChatOpenAIModel(wireId) || isKnownOpenAIResponsesUnsupportedModel(wireId)) {
			return undefined
		}
		const derivedOpenAI = resolveGatewayDerivedBase(
			spec,
			modelId,
			wireId,
			"openai",
			minContextWindow,
		)
		if (derivedOpenAI.matched) {
			return derivedOpenAI.plan
		}
		return resolveDeclaredOrUnlisted(
			spec,
			modelId,
			wireId,
			"openai-responses",
			"gateway-openai",
			minContextWindow,
		)
	}

	if (isKnownNonChatModel("cloudflare-ai-gateway", modelId)) {
		return undefined
	}

	// 3. Direct Cloudflare AI Gateway catalog match (covers bare native models and `workers-ai/@cf/...`)
	const gatewayEntry = getCloudflareAiGatewayCatalogEntry(modelId)
	if (gatewayEntry !== undefined) {
		if (gatewayEntry.contextWindow < minContextWindow) {
			return undefined
		}
		const route: ModelRoute =
			gatewayEntry.api === "anthropic-messages"
				? "gateway-anthropic"
				: gatewayEntry.api === "openai-responses"
					? "gateway-openai"
					: "gateway-compat"
		return {
			kind: "indexed",
			cataloged: true,
			wireModelId: modelId,
			format: gatewayEntry.api,
			route,
			entry: gatewayEntry,
		}
	}

	// 4. Bare native Anthropic / OpenAI fallback when not in Gateway's own catalog
	if (!modelId.includes("/")) {
		if (
			isKnownNonChatModel("openai", modelId) ||
			isKnownNonChatModel("anthropic", modelId) ||
			isKnownNonChatOpenAIModel(modelId) ||
			isKnownOpenAIResponsesUnsupportedModel(modelId)
		) {
			return undefined
		}
		const anthropicPrimary = findPrimaryModel("anthropic", modelId)
		if (anthropicPrimary !== undefined) {
			return anthropicPrimary.contextWindow >= minContextWindow
				? {
						kind: "primary",
						cataloged: true,
						wireModelId: modelId,
						route: "gateway-anthropic",
						model: anthropicPrimary,
					}
				: undefined
		}
		const derivedBareAnthropic = resolveGatewayDerivedBase(
			spec,
			modelId,
			modelId,
			"anthropic",
			minContextWindow,
		)
		if (derivedBareAnthropic.matched) {
			return derivedBareAnthropic.plan
		}
		if (isGatewayAnthropicModelId(modelId)) {
			return resolveDeclaredOrUnlisted(
				spec,
				modelId,
				modelId,
				"anthropic-messages",
				"gateway-anthropic",
				minContextWindow,
			)
		}

		const openAIPrimary = findPrimaryModel("openai", modelId)
		if (openAIPrimary !== undefined) {
			return openAIPrimary.contextWindow >= minContextWindow
				? {
						kind: "primary",
						cataloged: true,
						wireModelId: modelId,
						route: "gateway-openai",
						model: openAIPrimary,
					}
				: undefined
		}
		const derivedBareOpenAI = resolveGatewayDerivedBase(
			spec,
			modelId,
			modelId,
			"openai",
			minContextWindow,
		)
		if (derivedBareOpenAI.matched) {
			return derivedBareOpenAI.plan
		}
		if (isGatewayOpenAIModelId(modelId)) {
			return resolveDeclaredOrUnlisted(
				spec,
				modelId,
				modelId,
				"openai-responses",
				"gateway-openai",
				minContextWindow,
			)
		}
	}

	// 5. Unified OpenAI-compatible route (`.../compat`) — requires a provider-qualified
	// target (`<upstream>/<model>`, with optional nested slashes) because Cloudflare AI
	// Gateway's `/compat` endpoint cannot route bare model IDs without an upstream provider.
	if (!isProviderQualifiedGatewayCompatTarget(modelId)) {
		return undefined
	}
	if (modelId.startsWith("workers-ai/")) {
		const subId = modelId.slice("workers-ai/".length)
		if (subId.length === 0 || isKnownNonChatModel("cloudflare-workers-ai", subId)) {
			return undefined
		}
		const workersEntry = getCloudflareWorkersAiCatalogEntry(subId)
		if (workersEntry !== undefined) {
			return workersEntry.contextWindow >= minContextWindow
				? {
						kind: "indexed",
						cataloged: true,
						wireModelId: modelId,
						format: "openai-completions",
						route: "gateway-compat",
						entry: workersEntry,
					}
				: undefined
		}
		if (isKnownNonChatWorkersAiModel(subId)) {
			return undefined
		}
		const knownWorkersSpec = findKnownWorkersAiModelSpec(subId)
		if (knownWorkersSpec !== undefined) {
			return resolveKnownWorkersAiPlan(
				spec,
				modelId,
				modelId,
				"gateway-compat",
				minContextWindow,
				knownWorkersSpec,
			)
		}
	}

	if (modelId.startsWith("openrouter/")) {
		return resolveOpenRouterTargetPlan(
			spec,
			modelId,
			modelId.slice("openrouter/".length),
			minContextWindow,
			"gateway",
		)
	}

	return resolveDeclaredOrUnlisted(
		spec,
		modelId,
		modelId,
		"openai-completions",
		"gateway-compat",
		minContextWindow,
	)
}

const resolveCloudflareWorkersAiModelPlan = (
	spec: ProviderSpec,
	modelId: string,
	minContextWindow: number,
): ResolvedProviderModelPlan | undefined => {
	if (isKnownNonChatModel("cloudflare-workers-ai", modelId)) {
		return undefined
	}
	const entry = getCloudflareWorkersAiCatalogEntry(modelId)
	if (entry !== undefined) {
		return entry.contextWindow >= minContextWindow
			? {
					kind: "indexed",
					cataloged: true,
					wireModelId: entry.id,
					format: "openai-completions",
					route: "workers-ai",
					entry,
				}
			: undefined
	}
	if (isKnownNonChatWorkersAiModel(modelId)) {
		return undefined
	}
	const knownWorkersSpec = findKnownWorkersAiModelSpec(modelId)
	if (knownWorkersSpec !== undefined) {
		return resolveKnownWorkersAiPlan(
			spec,
			modelId,
			modelId,
			"workers-ai",
			minContextWindow,
			knownWorkersSpec,
		)
	}
	return resolveDeclaredOrUnlisted(
		spec,
		modelId,
		modelId,
		"openai-completions",
		"workers-ai",
		minContextWindow,
	)
}

export const resolvedPlanWireFormat = (plan: ResolvedProviderModelPlan): WireFormat | undefined => {
	if (plan.kind === "indexed" || plan.kind === "synthesized") {
		return plan.format
	}
	if (plan.route === "default") {
		return isWireFormat(plan.model.api) ? plan.model.api : undefined
	}
	if (plan.route === "openrouter-anthropic" || plan.route === "gateway-anthropic") {
		return "anthropic-messages"
	}
	if (plan.route === "gateway-openai") {
		return "openai-responses"
	}
	return "openai-completions"
}

const resolveUncheckedProviderModelPlan = (
	spec: ProviderSpec,
	modelId: string,
	minContextWindow: number,
): ResolvedProviderModelPlan | undefined => {
	if (spec.id === "openrouter") {
		return resolveOpenRouterModelPlan(spec, modelId, minContextWindow)
	}
	if (spec.id === "cloudflare-ai-gateway") {
		return resolveCloudflareGatewayModelPlan(spec, modelId, minContextWindow)
	}
	if (spec.id === "cloudflare-workers-ai") {
		return resolveCloudflareWorkersAiModelPlan(spec, modelId, minContextWindow)
	}
	if (spec.id === "openai" || spec.id === "anthropic") {
		if (
			spec.id === "openai" &&
			spec.defaultFormat === "openai-responses" &&
			isKnownOpenAIResponsesUnsupportedModel(modelId)
		) {
			return undefined
		}
		const matched = findUpstreamPrimaryOrDerived(spec.id, modelId)
		if (matched.matched) {
			return materializeUpstreamMatch(
				spec,
				modelId,
				modelId,
				spec.defaultFormat,
				"default",
				minContextWindow,
				matched,
			)
		}
	} else if (isKnownNonChatModel(spec.id, modelId)) {
		return undefined
	}
	const defaultRoute: ModelRoute =
		spec.auth.kind === "cloudflare_ai_gateway"
			? spec.defaultFormat === "anthropic-messages"
				? "gateway-anthropic"
				: spec.defaultFormat === "openai-responses"
					? "gateway-openai"
					: "gateway-compat"
			: spec.auth.kind === "cloudflare_workers_ai"
				? "workers-ai"
				: "default"
	return resolveDeclaredOrUnlisted(
		spec,
		modelId,
		modelId,
		spec.defaultFormat,
		defaultRoute,
		minContextWindow,
	)
}

export const resolveProviderModelPlan = (
	spec: ProviderSpec,
	modelId: string,
	minContextWindow = DEFAULT_MIN_CONTEXT_WINDOW,
): ResolvedProviderModelPlan | undefined => {
	if (
		!isValidModelId(modelId) ||
		!isWireFormat(spec.defaultFormat) ||
		!spec.formats.includes(spec.defaultFormat)
	) {
		return undefined
	}
	const plan = resolveUncheckedProviderModelPlan(spec, modelId, minContextWindow)
	if (plan === undefined) {
		return undefined
	}
	const planFormat = resolvedPlanWireFormat(plan)
	if (planFormat === undefined || !spec.formats.includes(planFormat)) {
		return undefined
	}
	if (
		spec.id === "openai" &&
		planFormat === "openai-responses" &&
		isKnownOpenAIResponsesUnsupportedModel(modelId)
	) {
		return undefined
	}
	return plan
}
