import type { Api, Model } from "@earendil-works/pi-ai"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"

export const SUPPORTED_PROVIDERS = ["openai", "anthropic"] as const
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

export const PROVIDER_API_KEY_ENV: Readonly<Record<SupportedProvider, string>> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
}

export const isSupportedProvider = (value: string): value is SupportedProvider =>
	value === "openai" || value === "anthropic"

const MODELS: Readonly<Record<SupportedProvider, ReadonlyArray<Model<Api>>>> = {
	openai: Object.values(OPENAI_MODELS),
	anthropic: Object.values(ANTHROPIC_MODELS),
}

const findModel = (provider: SupportedProvider, modelId: string) =>
	MODELS[provider].find((model) => model.id === modelId)

export const resolveCatalogModel = (
	requestedModelId: string,
): { readonly provider: SupportedProvider; readonly model: Model<Api> } | null => {
	const slashIndex = requestedModelId.indexOf("/")
	if (slashIndex > 0) {
		const provider = requestedModelId.slice(0, slashIndex)
		const modelId = requestedModelId.slice(slashIndex + 1)
		if (isSupportedProvider(provider) && modelId.length > 0) {
			const model = findModel(provider, modelId)
			if (model !== undefined) {
				return { provider, model }
			}
		}
		return null
	}
	for (const provider of SUPPORTED_PROVIDERS) {
		const model = findModel(provider, requestedModelId)
		if (model !== undefined) {
			return { provider, model }
		}
	}
	return null
}
