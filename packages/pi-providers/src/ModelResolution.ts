import type { Api, Model } from "@earendil-works/pi-ai"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
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

export const anthropicBaseModelCandidates = (modelId: string): ReadonlyArray<string> => {
	const undated = modelId.replace(/-\d{8}$/, "")
	return undated !== modelId && undated.length > 0 ? [undated] : []
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

export type ResolvedProviderModelPlan =
	| {
			readonly kind: "primary"
			readonly cataloged: boolean
			readonly wireModelId: string
			readonly model: Model<Api>
	  }
	| {
			readonly kind: "synthesized"
			readonly cataloged: boolean
			readonly wireModelId: string
			readonly format: WireFormat
			readonly contextWindow: number
			readonly defaults: ProviderModelDefaults
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
	const primaryModel = findPrimaryModel(spec.id, modelId)
	if (primaryModel !== undefined) {
		if (!isWireFormat(primaryModel.api) || !spec.formats.includes(primaryModel.api)) {
			return undefined
		}
		return primaryModel.contextWindow >= minContextWindow
			? { kind: "primary", cataloged: true, wireModelId: primaryModel.id, model: primaryModel }
			: undefined
	}
	if (spec.id === "openai" || spec.id === "anthropic") {
		if (
			spec.id === "openai" &&
			(isKnownNonChatOpenAIModel(modelId) || isKnownOpenAIResponsesUnsupportedModel(modelId))
		) {
			return undefined
		}
		const baseCandidates =
			spec.id === "openai"
				? openAIBaseModelCandidates(modelId)
				: anthropicBaseModelCandidates(modelId)
		for (const baseCandidate of baseCandidates) {
			const baseModel = findPrimaryModel(spec.id, baseCandidate)
			if (baseModel !== undefined) {
				if (
					!isWireFormat(baseModel.api) ||
					!spec.formats.includes(baseModel.api) ||
					(spec.allowUnlistedModels === false && ownProperty(spec.models, modelId) === undefined)
				) {
					return undefined
				}
				return baseModel.contextWindow >= minContextWindow
					? { kind: "primary", cataloged: false, wireModelId: modelId, model: baseModel }
					: undefined
			}
		}
		if (spec.id === "openai") {
			const legacyLimits = findLegacyOpenAIModelLimits(modelId)
			if (legacyLimits !== undefined) {
				if (spec.allowUnlistedModels === false && ownProperty(spec.models, modelId) === undefined) {
					return undefined
				}
				return legacyLimits.contextWindow >= minContextWindow
					? {
							kind: "synthesized",
							cataloged: false,
							wireModelId: modelId,
							format: spec.defaultFormat,
							contextWindow: legacyLimits.contextWindow,
							defaults: {
								contextWindow: legacyLimits.contextWindow,
								maxTokens: legacyLimits.maxTokens,
								reasoning: false,
							},
						}
					: undefined
			}
		}
	}
	const declared = ownProperty(spec.models, modelId)
	if (declared === undefined && spec.allowUnlistedModels === false) {
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
		wireModelId: modelId,
		format: spec.defaultFormat,
		contextWindow,
		defaults,
	}
}
