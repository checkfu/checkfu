/**
 * Regenerates `src/CatalogIndex.ts` and `src/CatalogCapabilities.ts` from the
 * installed `@earendil-works/pi-ai` provider catalogs.
 *
 * Run with: `bun packages/pi-providers/scripts/sync-catalog-index.ts`
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import { hasApi } from "@earendil-works/pi-ai/models"
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
import type { WireFormat } from "../src/Types.ts"

const ROOT_DIR = resolve(import.meta.dirname, "..")

const formatInt = (value: number): string => {
	const raw = String(value)
	return raw.length >= 5 ? raw.replaceAll(/\B(?=(\d{3})+(?!\d))/g, "_") : raw
}

const formatJsonLiteral = (value: unknown): string =>
	JSON.stringify(value).replaceAll(/(?<!\.)\b\d{5,}\b/g, (match) => formatInt(Number(match)))

const isWireModel = (model: Model<Api>): model is Model<WireFormat> =>
	hasApi(model, "openai-completions") ||
	hasApi(model, "anthropic-messages") ||
	hasApi(model, "openai-responses")

const apiCode = (api: WireFormat): number => {
	switch (api) {
		case "openai-completions":
			return 0
		case "anthropic-messages":
			return 1
		case "openai-responses":
			return 2
	}
}

const makePalette = () => {
	const indexByKey = new Map<string, number>()
	const items: Array<unknown> = []
	return {
		intern: (value: unknown): number => {
			if (value === undefined) {
				return -1
			}
			const key = JSON.stringify(value)
			const existing = indexByKey.get(key)
			if (existing !== undefined) {
				return existing
			}
			const idx = items.length
			indexByKey.set(key, idx)
			items.push(value)
			return idx
		},
		items,
	}
}

const costsPalette = makePalette()
const thinkingMaps = makePalette()
const anthropicCompats = makePalette()
const openAIResponsesCompats = makePalette()
const openAICompletionsCompats = makePalette()
const inputLimitsPalette = makePalette()

type EncodedCostTier = readonly [number, number, number, number, number]
type EncodedCostTuple =
	| readonly [number, number, number, number]
	| readonly [number, number, number, number, ReadonlyArray<EncodedCostTier>]

const encodeCostTuple = (cost: Model<WireFormat>["cost"]): EncodedCostTuple => {
	const tiers = cost.tiers
	if (tiers === undefined || tiers.length === 0) {
		return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite]
	}
	return [
		cost.input,
		cost.output,
		cost.cacheRead,
		cost.cacheWrite,
		tiers.map((tier): EncodedCostTier => [
			tier.inputTokensAbove,
			tier.input,
			tier.output,
			tier.cacheRead,
			tier.cacheWrite,
		]),
	]
}

const compatIndexOf = (model: Model<WireFormat>): number => {
	if (hasApi(model, "anthropic-messages")) {
		return anthropicCompats.intern(model.compat)
	}
	if (hasApi(model, "openai-responses")) {
		return openAIResponsesCompats.intern(model.compat)
	}
	return openAICompletionsCompats.intern(model.compat)
}

const encodeRows = (catalog: Readonly<Record<string, Model<Api>>>): ReadonlyArray<string> =>
	Object.values(catalog)
		.filter(isWireModel)
		.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((model) => {
			const hasImage = model.input.includes("image")
			const flags = apiCode(model.api) | (model.reasoning ? 4 : 0) | (hasImage ? 8 : 0)
			const costIdx = costsPalette.intern(encodeCostTuple(model.cost))
			const tlmIdx = thinkingMaps.intern(model.thinkingLevelMap)
			const compatIdx = compatIndexOf(model)
			const limIdx = inputLimitsPalette.intern(model.inputLimits)
			const parts: Array<string> = [
				JSON.stringify(model.id),
				formatInt(model.contextWindow),
				formatInt(model.maxTokens),
				String(flags),
				String(costIdx),
			]
			if (limIdx !== -1) {
				parts.push(String(tlmIdx), String(compatIdx), String(limIdx))
			} else if (compatIdx !== -1) {
				parts.push(String(tlmIdx), String(compatIdx))
			} else if (tlmIdx !== -1) {
				parts.push(String(tlmIdx))
			}
			return `\t[${parts.join(", ")}],`
		})

const stripColonSuffix = (id: string): string => {
	const colonIndex = id.indexOf(":")
	return colonIndex === -1 ? id : id.slice(0, colonIndex)
}

const collectNonChatOnlyIds = (
	chatCatalog: Readonly<Record<string, { readonly id: string }>>,
	otherCatalogs: ReadonlyArray<Readonly<Record<string, { readonly id: string }>>>,
	options?: {
		readonly extraCandidates?: ReadonlyArray<string>
		readonly indexVariantBaseIds?: boolean
	},
): ReadonlyArray<string> => {
	const chatIds = new Set(Object.values(chatCatalog).map((model) => model.id))
	const chatBaseIds = new Set(Object.values(chatCatalog).map((model) => stripColonSuffix(model.id)))
	const nonChatIds = new Set<string>()
	const record = (id: string) => {
		if (!chatIds.has(id)) {
			nonChatIds.add(id)
		}
		if (options?.indexVariantBaseIds) {
			const baseId = stripColonSuffix(id)
			if (baseId !== id && !chatIds.has(baseId) && !chatBaseIds.has(baseId)) {
				nonChatIds.add(baseId)
			}
		}
	}
	for (const catalog of otherCatalogs) {
		for (const model of Object.values(catalog)) {
			record(model.id)
		}
	}
	for (const id of options?.extraCandidates ?? []) {
		record(id)
	}
	return [...nonChatIds].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

const prefixedOpenRouterNonChatIds = (prefix: string): ReadonlyArray<string> => {
	const catalogs: ReadonlyArray<Readonly<Record<string, { readonly id: string }>>> = [
		OPENROUTER_IMAGE_MODELS,
		OPENROUTER_CLASSIFIER_MODELS,
	]
	const ids: Array<string> = []
	for (const catalog of catalogs) {
		for (const model of Object.values(catalog)) {
			if (model.id.startsWith(prefix)) {
				const stripped = model.id.slice(prefix.length)
				ids.push(stripped)
				const base = stripColonSuffix(stripped)
				if (base !== stripped) {
					ids.push(base)
				}
			}
		}
	}
	return ids
}

const openRouterRows = encodeRows(OPENROUTER_MODELS)
const cloudflareAiGatewayRows = encodeRows(CLOUDFLARE_AI_GATEWAY_MODELS)
const cloudflareWorkersAiRows = encodeRows(CLOUDFLARE_WORKERS_AI_MODELS)

const openAINonChatIds = collectNonChatOnlyIds(
	OPENAI_MODELS,
	[OPENAI_IMAGE_MODELS, OPENAI_CLASSIFIER_MODELS],
	{ extraCandidates: prefixedOpenRouterNonChatIds("openai/") },
)
const anthropicNonChatIds = collectNonChatOnlyIds(
	ANTHROPIC_MODELS,
	[ANTHROPIC_IMAGE_MODELS, ANTHROPIC_CLASSIFIER_MODELS],
	{ extraCandidates: prefixedOpenRouterNonChatIds("anthropic/") },
)
// Known embedding-only OpenRouter models that are not represented in pi-ai's
// chat, image, or classifier catalogs.
const OPENROUTER_EXTRA_NON_CHAT_IDS: ReadonlyArray<string> = [
	"baai/bge-base-en-v1.5",
	"baai/bge-large-en-v1.5",
	"baai/bge-m3",
	"google/gemini-embedding-001",
	"google/gemini-embedding-2",
	"google/gemini-embedding-2-preview",
	"intfloat/e5-base-v2",
	"intfloat/e5-large-v2",
	"intfloat/multilingual-e5-large",
	"mistralai/codestral-embed-2505",
	"mistralai/mistral-embed-2312",
	"nvidia/llama-nemotron-embed-vl-1b-v2",
	"openai/text-embedding-3-large",
	"openai/text-embedding-3-small",
	"openai/text-embedding-ada-002",
	"perplexity/pplx-embed-v1-0.6b",
	"qwen/qwen3-embedding-0.6b",
	"qwen/qwen3-embedding-4b",
	"qwen/qwen3-embedding-8b",
	"sentence-transformers/all-minilm-l6-v2",
	"thenlper/gte-base",
	"thenlper/gte-large",
]

const openRouterNonChatIds = collectNonChatOnlyIds(
	OPENROUTER_MODELS,
	[OPENROUTER_IMAGE_MODELS, OPENROUTER_CLASSIFIER_MODELS],
	{ indexVariantBaseIds: true, extraCandidates: OPENROUTER_EXTRA_NON_CHAT_IDS },
)
const cloudflareAiGatewayNonChatIds = collectNonChatOnlyIds(CLOUDFLARE_AI_GATEWAY_MODELS, [
	CLOUDFLARE_AI_GATEWAY_IMAGE_MODELS,
	CLOUDFLARE_AI_GATEWAY_CLASSIFIER_MODELS,
])
// Known non-chat Workers AI models from Cloudflare's official Workers AI catalog
// (embeddings, rerankers, ASR/STT, TTS, image generation/classification, summarization,
// translation, turn-detection, and safety guardrails) that are not represented in pi-ai's
// small image/classifier catalogs.
const CLOUDFLARE_WORKERS_AI_EXTRA_NON_CHAT_IDS: ReadonlyArray<string> = [
	"@cf/ai4bharat/indictrans2-en-indic-1B",
	"@cf/baai/bge-base-en-v1.5",
	"@cf/baai/bge-large-en-v1.5",
	"@cf/baai/bge-m3",
	"@cf/baai/bge-reranker-base",
	"@cf/baai/bge-small-en-v1.5",
	"@cf/black-forest-labs/flux-1-schnell",
	"@cf/black-forest-labs/flux-2-dev",
	"@cf/black-forest-labs/flux-2-klein-4b",
	"@cf/black-forest-labs/flux-2-klein-9b",
	"@cf/bytedance/stable-diffusion-xl-lightning",
	"@cf/deepgram/aura-1",
	"@cf/deepgram/aura-2-en",
	"@cf/deepgram/aura-2-es",
	"@cf/deepgram/flux",
	"@cf/deepgram/nova-3",
	"@cf/facebook/bart-large-cnn",
	"@cf/google/embeddinggemma-300m",
	"@cf/huggingface/distilbert-sst-2-int8",
	"@cf/leonardo/lucid-origin",
	"@cf/leonardo/phoenix-1.0",
	"@cf/llava-hf/llava-1.5-7b-hf",
	"@cf/lykon/dreamshaper-8-lcm",
	"@cf/meta/llama-guard-3-8b",
	"@cf/meta/m2m100-1.2b",
	"@cf/microsoft/resnet-50",
	"@cf/moondream/moondream3.1-9B-A2B",
	"@cf/myshell-ai/melotts",
	"@cf/nvidia/nemotron-speech-streaming-en-0.6b",
	"@cf/openai/whisper",
	"@cf/openai/whisper-large-v3-turbo",
	"@cf/openai/whisper-tiny-en",
	"@cf/pfnet/plamo-embedding-1b",
	"@cf/pipecat-ai/smart-turn-v2",
	"@cf/qwen/qwen3-embedding-0.6b",
	"@cf/runwayml/stable-diffusion-v1-5-inpainting",
	"@cf/stabilityai/stable-diffusion-xl-base-1.0",
	"@cf/unum/uform-gen2-qwen-500m",
]

const cloudflareWorkersAiNonChatIds = collectNonChatOnlyIds(
	CLOUDFLARE_WORKERS_AI_MODELS,
	[CLOUDFLARE_WORKERS_AI_IMAGE_MODELS, CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS],
	{ extraCandidates: CLOUDFLARE_WORKERS_AI_EXTRA_NON_CHAT_IDS },
)

const formatStringArray = (items: ReadonlyArray<string>): string =>
	items.length === 0
		? "[]"
		: `[\n${items.map((item) => `\t${JSON.stringify(item)},`).join("\n")}\n]`

const catalogIndexSource = `/**
 * Compact, lazy-indexed metadata for OpenRouter, Cloudflare AI Gateway, and
 * Cloudflare Workers AI derived from \`@earendil-works/pi-ai\` catalogs.
 *
 * Keeps public API Workers free of the ~365 KB raw provider catalog JSONs while
 * ensuring API validation and runtime dispatch enforce identical limits, routing,
 * capabilities, pricing, and non-chat model exclusions.
 *
 * Regenerate via: \`bun packages/pi-providers/scripts/sync-catalog-index.ts\`
 * Parity is enforced by \`test/Providers.test.ts\`.
 */

import type { WireFormat } from "./Types.ts"

export interface CatalogIndexEntry {
	readonly id: string
	readonly api: WireFormat
	readonly contextWindow: number
	readonly maxTokens: number
	readonly reasoning: boolean
	readonly input: ReadonlyArray<"text" | "image">
	readonly costIndex: number
	readonly thinkingLevelMapIndex: number
	readonly compatIndex: number
	readonly inputLimitsIndex: number
}

// Tuple format:
//   [id, contextWindow, maxTokens, flags, costIndex, thinkingLevelMapIndex?, compatIndex?, inputLimitsIndex?]
// flags bits:
//   bits 0..1: api (0 = openai-completions, 1 = anthropic-messages, 2 = openai-responses)
//   bit 2 (4): reasoning
//   bit 3 (8): image input supported (otherwise ["text"])
type CatalogRow = readonly [
	id: string,
	contextWindow: number,
	maxTokens: number,
	flags: number,
	costIndex: number,
	thinkingLevelMapIndex?: number,
	compatIndex?: number,
	inputLimitsIndex?: number,
]

const decodeApi = (flags: number): WireFormat => {
	const code = flags & 3
	if (code === 1) {
		return "anthropic-messages"
	}
	if (code === 2) {
		return "openai-responses"
	}
	return "openai-completions"
}

const TEXT_ONLY_INPUT: ReadonlyArray<"text" | "image"> = ["text"]
const TEXT_AND_IMAGE_INPUT: ReadonlyArray<"text" | "image"> = ["text", "image"]

const toEntryMap = (rows: ReadonlyArray<CatalogRow>): ReadonlyMap<string, CatalogIndexEntry> =>
	new Map(
		rows.map(([id, contextWindow, maxTokens, flags, costIndex, tlmIdx, compatIdx, limIdx]) => [
			id,
			{
				id,
				api: decodeApi(flags),
				contextWindow,
				maxTokens,
				reasoning: (flags & 4) !== 0,
				input: (flags & 8) !== 0 ? TEXT_AND_IMAGE_INPUT : TEXT_ONLY_INPUT,
				costIndex,
				thinkingLevelMapIndex: tlmIdx ?? -1,
				compatIndex: compatIdx ?? -1,
				inputLimitsIndex: limIdx ?? -1,
			},
		]),
	)

const OPENROUTER_ROWS: ReadonlyArray<CatalogRow> = [
${openRouterRows.join("\n")}
]

const CLOUDFLARE_AI_GATEWAY_ROWS: ReadonlyArray<CatalogRow> = [
${cloudflareAiGatewayRows.join("\n")}
]

const CLOUDFLARE_WORKERS_AI_ROWS: ReadonlyArray<CatalogRow> = [
${cloudflareWorkersAiRows.join("\n")}
]

const OPENAI_NON_CHAT_IDS: ReadonlyArray<string> = ${formatStringArray(openAINonChatIds)}

const ANTHROPIC_NON_CHAT_IDS: ReadonlyArray<string> = ${formatStringArray(anthropicNonChatIds)}

const OPENROUTER_NON_CHAT_IDS: ReadonlyArray<string> = ${formatStringArray(openRouterNonChatIds)}

const CLOUDFLARE_AI_GATEWAY_NON_CHAT_IDS: ReadonlyArray<string> = ${formatStringArray(cloudflareAiGatewayNonChatIds)}

const CLOUDFLARE_WORKERS_AI_NON_CHAT_IDS: ReadonlyArray<string> = ${formatStringArray(cloudflareWorkersAiNonChatIds)}

let openRouterIndexCache: ReadonlyMap<string, CatalogIndexEntry> | undefined
let cloudflareAiGatewayIndexCache: ReadonlyMap<string, CatalogIndexEntry> | undefined
let cloudflareWorkersAiIndexCache: ReadonlyMap<string, CatalogIndexEntry> | undefined
let nonChatIndexCache: ReadonlyMap<string, ReadonlySet<string>> | undefined

export const getOpenRouterCatalogIndex = (): ReadonlyMap<string, CatalogIndexEntry> => {
	openRouterIndexCache ??= toEntryMap(OPENROUTER_ROWS)
	return openRouterIndexCache
}

export const getCloudflareAiGatewayCatalogIndex = (): ReadonlyMap<string, CatalogIndexEntry> => {
	cloudflareAiGatewayIndexCache ??= toEntryMap(CLOUDFLARE_AI_GATEWAY_ROWS)
	return cloudflareAiGatewayIndexCache
}

export const getCloudflareWorkersAiCatalogIndex = (): ReadonlyMap<string, CatalogIndexEntry> => {
	cloudflareWorkersAiIndexCache ??= toEntryMap(CLOUDFLARE_WORKERS_AI_ROWS)
	return cloudflareWorkersAiIndexCache
}

export const getOpenRouterCatalogEntry = (modelId: string): CatalogIndexEntry | undefined =>
	getOpenRouterCatalogIndex().get(modelId)

export const getCloudflareAiGatewayCatalogEntry = (modelId: string): CatalogIndexEntry | undefined =>
	getCloudflareAiGatewayCatalogIndex().get(modelId)

export const getCloudflareWorkersAiCatalogEntry = (modelId: string): CatalogIndexEntry | undefined =>
	getCloudflareWorkersAiCatalogIndex().get(modelId)

const getNonChatIndex = (): ReadonlyMap<string, ReadonlySet<string>> => {
	nonChatIndexCache ??= new Map<string, ReadonlySet<string>>([
		["openai", new Set(OPENAI_NON_CHAT_IDS)],
		["anthropic", new Set(ANTHROPIC_NON_CHAT_IDS)],
		["openrouter", new Set(OPENROUTER_NON_CHAT_IDS)],
		["cloudflare-ai-gateway", new Set(CLOUDFLARE_AI_GATEWAY_NON_CHAT_IDS)],
		["cloudflare-workers-ai", new Set(CLOUDFLARE_WORKERS_AI_NON_CHAT_IDS)],
	])
	return nonChatIndexCache
}

export const getKnownNonChatModelIds = (providerId: string): ReadonlySet<string> | undefined =>
	getNonChatIndex().get(providerId)

export const isKnownNonChatModel = (providerId: string, modelId: string): boolean =>
	getNonChatIndex().get(providerId)?.has(modelId) === true
`

const catalogCapabilitiesSource = `/**
 * Deduplicated runtime capability and pricing palettes (\`cost\`, \`thinkingLevelMap\`,
 * wire \`compat\`, and \`inputLimits\`) referenced by index from \`CatalogIndex.ts\`.
 *
 * Kept separate from \`CatalogIndex.ts\` so public API Workers never bundle runtime
 * codec capability or pricing tables while \`PiHarnessWorker\` reconstructs lossless models.
 *
 * Regenerate via: \`bun packages/pi-providers/scripts/sync-catalog-index.ts\`
 * Parity is enforced by \`test/Providers.test.ts\`.
 */

import type {
	AnthropicMessagesCompat,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "@earendil-works/pi-ai"
import type { CatalogIndexEntry } from "./CatalogIndex.ts"
import type { WireFormat } from "./Types.ts"

export type IndexedThinkingLevelMap = NonNullable<Model<WireFormat>["thinkingLevelMap"]>
export type IndexedInputLimits = NonNullable<Model<WireFormat>["inputLimits"]>

type CostTierTuple = readonly [
	inputTokensAbove: number,
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
]

type CostTuple = readonly [
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	tiers?: ReadonlyArray<CostTierTuple>,
]

export const ZERO_COST: Model<WireFormat>["cost"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
}

const MODEL_COSTS: ReadonlyArray<CostTuple> = [
${costsPalette.items.map((item) => `\t${formatJsonLiteral(item)},`).join("\n")}
]

const THINKING_LEVEL_MAPS: ReadonlyArray<IndexedThinkingLevelMap> = [
${thinkingMaps.items.map((item) => `\t${formatJsonLiteral(item)},`).join("\n")}
]

const ANTHROPIC_COMPATS: ReadonlyArray<AnthropicMessagesCompat> = [
${anthropicCompats.items.map((item) => `\t${formatJsonLiteral(item)},`).join("\n")}
]

const OPENAI_RESPONSES_COMPATS: ReadonlyArray<OpenAIResponsesCompat> = [
${openAIResponsesCompats.items.map((item) => `\t${formatJsonLiteral(item)},`).join("\n")}
]

const OPENAI_COMPLETIONS_COMPATS: ReadonlyArray<OpenAICompletionsCompat> = [
${openAICompletionsCompats.items.map((item) => `\t${formatJsonLiteral(item)},`).join("\n")}
]

const MODEL_INPUT_LIMITS: ReadonlyArray<IndexedInputLimits> = [
${inputLimitsPalette.items.map((item) => `\t${formatJsonLiteral(item)},`).join("\n")}
]

export const getIndexedCost = (index: number): Model<WireFormat>["cost"] => {
	const tuple = index >= 0 ? MODEL_COSTS[index] : undefined
	if (tuple === undefined) {
		return ZERO_COST
	}
	const [input, output, cacheRead, cacheWrite, tiers] = tuple
	return tiers === undefined
		? { input, output, cacheRead, cacheWrite }
		: {
				input,
				output,
				cacheRead,
				cacheWrite,
				tiers: tiers.map(([inputTokensAbove, tierIn, tierOut, tierRead, tierWrite]) => ({
					inputTokensAbove,
					input: tierIn,
					output: tierOut,
					cacheRead: tierRead,
					cacheWrite: tierWrite,
				})),
			}
}

export const getIndexedThinkingLevelMap = (index: number): IndexedThinkingLevelMap | undefined =>
	index >= 0 ? THINKING_LEVEL_MAPS[index] : undefined

export const getIndexedInputLimits = (index: number): IndexedInputLimits | undefined =>
	index >= 0 ? MODEL_INPUT_LIMITS[index] : undefined

export const getIndexedAnthropicCompat = (index: number): AnthropicMessagesCompat | undefined =>
	index >= 0 ? ANTHROPIC_COMPATS[index] : undefined

export const getIndexedOpenAIResponsesCompat = (index: number): OpenAIResponsesCompat | undefined =>
	index >= 0 ? OPENAI_RESPONSES_COMPATS[index] : undefined

export const getIndexedOpenAICompletionsCompat = (
	index: number,
): OpenAICompletionsCompat | undefined => (index >= 0 ? OPENAI_COMPLETIONS_COMPATS[index] : undefined)

export interface HydrateIndexedModelOptions {
	readonly provider: string
	readonly id?: string
	readonly baseUrl: string
	readonly formatOverride?: WireFormat
	readonly costOverride?: Model<WireFormat>["cost"]
	readonly anthropicCompatOverride?: AnthropicMessagesCompat
	readonly openAIResponsesCompatOverride?: OpenAIResponsesCompat
	readonly openAICompletionsCompatOverride?: OpenAICompletionsCompat
	readonly headers?: Record<string, string>
}

export const hydrateIndexedModel = (
	entry: CatalogIndexEntry,
	options: HydrateIndexedModelOptions,
): Model<WireFormat> => {
	const format = options.formatOverride ?? entry.api
	const thinkingLevelMap = getIndexedThinkingLevelMap(entry.thinkingLevelMapIndex)
	const inputLimits = getIndexedInputLimits(entry.inputLimitsIndex)
	const id = options.id ?? entry.id
	const base = {
		id,
		name: id,
		provider: options.provider,
		baseUrl: options.baseUrl,
		reasoning: entry.reasoning,
		input: [...entry.input],
		cost: options.costOverride ?? getIndexedCost(entry.costIndex),
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
		...(inputLimits === undefined ? {} : { inputLimits }),
		...(options.headers === undefined ? {} : { headers: options.headers }),
	}
	switch (format) {
		case "anthropic-messages": {
			const compat =
				options.anthropicCompatOverride ??
				(entry.api === "anthropic-messages"
					? getIndexedAnthropicCompat(entry.compatIndex)
					: undefined)
			return {
				...base,
				api: "anthropic-messages",
				...(compat === undefined ? {} : { compat }),
			}
		}
		case "openai-responses": {
			const compat =
				options.openAIResponsesCompatOverride ??
				(entry.api === "openai-responses"
					? getIndexedOpenAIResponsesCompat(entry.compatIndex)
					: undefined)
			return {
				...base,
				api: "openai-responses",
				...(compat === undefined ? {} : { compat }),
			}
		}
		case "openai-completions": {
			const compat =
				options.openAICompletionsCompatOverride ??
				(entry.api === "openai-completions"
					? getIndexedOpenAICompletionsCompat(entry.compatIndex)
					: undefined)
			return {
				...base,
				api: "openai-completions",
				...(compat === undefined ? {} : { compat }),
			}
		}
	}
}
`

writeFileSync(resolve(ROOT_DIR, "src/CatalogIndex.ts"), catalogIndexSource, "utf8")
writeFileSync(resolve(ROOT_DIR, "src/CatalogCapabilities.ts"), catalogCapabilitiesSource, "utf8")
