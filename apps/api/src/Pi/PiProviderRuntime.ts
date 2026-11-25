import * as Cloudflare from "@alchemy.run/cloudflare"
import type { ProviderCredentialCheck, ProviderRuntimeConfig } from "@checkfu/pi-providers/catalog"
import { createProviderModels } from "@checkfu/pi-providers/runtime"
import { lazyStream } from "@earendil-works/pi-ai"
import type { AnyModel, Api, Model, ModelType, ModelTypeMap } from "@earendil-works/pi-ai"
import type { MutableModels } from "@earendil-works/pi-ai/models"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { checkCatalogProviderCredentials, configuredCustomProviders } from "./PiCatalog.ts"
import {
	extractAiBinding,
	loadProviderApiKeys,
	providerBaseUrls,
	toProviderRuntimeConfig,
} from "./PiModels.ts"

export interface PiProviderSessionContext {
	readonly sessionId: string
}

export interface PiProviderResolveContext {
	readonly sessionId: string
	readonly provider?: string
}

export interface PiSessionProviders {
	readonly createModels: () => MutableModels
	readonly checkCredentials: (
		provider: string,
	) => ProviderCredentialCheck | Promise<ProviderCredentialCheck>
}

export interface PiProviderRuntimeService {
	readonly forSession: (context: PiProviderSessionContext) => Effect.Effect<PiSessionProviders>
}

export class PiProviderRuntime extends Context.Service<
	PiProviderRuntime,
	PiProviderRuntimeService
>()("@checkfu/api/PiProviderRuntime") {}

export const staticPiProviderRuntime = (
	config: ProviderRuntimeConfig,
): PiProviderRuntimeService => ({
	forSession: () =>
		Effect.succeed({
			createModels: () => createProviderModels(config),
			checkCredentials: (provider) =>
				checkCatalogProviderCredentials(provider, config, config.customProviders),
		}),
})

const refreshChatModel = <TApi extends Api>(
	models: MutableModels,
	model: Model<TApi>,
): Model<TApi> => {
	const resolved = models.getModel(model.provider, model.id)
	if (resolved === undefined || resolved.api !== model.api) {
		return model
	}
	return {
		...model,
		baseUrl: resolved.baseUrl,
		...(resolved.headers === undefined ? {} : { headers: resolved.headers }),
	}
}

const createDynamicProviderModels = (
	initialConfig: ProviderRuntimeConfig,
	resolveConfig: (provider?: string) => Promise<ProviderRuntimeConfig>,
): MutableModels => {
	let baselineConfig = initialConfig
	let baselineModels = createProviderModels(initialConfig)

	const resolveModels = async (provider?: string): Promise<MutableModels> => {
		const nextConfig = await resolveConfig(provider)
		if (nextConfig === baselineConfig) {
			return baselineModels
		}
		const fresh = createProviderModels(nextConfig)
		if (provider === undefined) {
			baselineConfig = nextConfig
			baselineModels = fresh
		}
		return fresh
	}

	function getModelsOfType<TType extends ModelType>(
		type: TType,
		provider?: string,
	): ReadonlyArray<ModelTypeMap[TType]>
	function getModelsOfType(
		type: ModelType,
		provider?: string,
	): ReadonlyArray<ModelTypeMap[ModelType]> {
		return baselineModels.getModelsOfType(type, provider)
	}

	function getModelOfType<TType extends ModelType>(
		type: TType,
		providerId: string,
		id: string,
	): ModelTypeMap[TType] | undefined
	function getModelOfType(
		type: ModelType,
		providerId: string,
		id: string,
	): ModelTypeMap[ModelType] | undefined {
		return baselineModels.getModelOfType(type, providerId, id)
	}

	function getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: Parameters<MutableModels["getAvailableOfType"]>[2],
	): Promise<ReadonlyArray<ModelTypeMap[TType]>>
	async function getAvailableOfType(
		type: ModelType,
		providerId?: string,
		options?: Parameters<MutableModels["getAvailableOfType"]>[2],
	): Promise<ReadonlyArray<ModelTypeMap[ModelType]>> {
		const models = await resolveModels(providerId)
		return models.getAvailableOfType(type, providerId, options)
	}

	function getAuth(
		providerId: string,
		overrides?: Parameters<MutableModels["getAuth"]>[1],
	): ReturnType<MutableModels["getAuth"]>
	function getAuth(
		model: AnyModel,
		overrides?: Parameters<MutableModels["getAuth"]>[1],
	): ReturnType<MutableModels["getAuth"]>
	async function getAuth(
		target: string | AnyModel,
		overrides?: Parameters<MutableModels["getAuth"]>[1],
	) {
		const providerId = typeof target === "string" ? target : target.provider
		const models = await resolveModels(providerId)
		return typeof target === "string"
			? models.getAuth(target, overrides)
			: models.getAuth(target, overrides)
	}

	return {
		getProviders: () => baselineModels.getProviders(),
		getProvider: (id) => baselineModels.getProvider(id),
		getModels: (provider) => baselineModels.getModels(provider),
		getAllModels: (provider) => baselineModels.getAllModels(provider),
		getModelsOfType,
		getModel: (providerId, id) => baselineModels.getModel(providerId, id),
		getModelOfType,
		refresh: async (options) => (await resolveModels()).refresh(options),
		checkAuth: async (providerId, options) =>
			(await resolveModels(providerId)).checkAuth(providerId, options),
		getAvailable: async (providerId, options) =>
			(await resolveModels(providerId)).getAvailable(providerId, options),
		getAvailableOfType,
		getAllAvailable: async (providerId, options) =>
			(await resolveModels(providerId)).getAllAvailable(providerId, options),
		getAuth,
		login: async (providerId, type, interaction, options) =>
			(await resolveModels(providerId)).login(providerId, type, interaction, options),
		logout: async (providerId, options) =>
			(await resolveModels(providerId)).logout(providerId, options),
		stream: (model, context, options) =>
			lazyStream(
				model,
				async () => {
					const models = await resolveModels(model.provider)
					return models.stream(refreshChatModel(models, model), context, options)
				},
				undefined,
				options?.signal,
			),
		complete: async (model, context, options) => {
			const models = await resolveModels(model.provider)
			return models.complete(refreshChatModel(models, model), context, options)
		},
		streamSimple: (model, context, options) =>
			lazyStream(
				model,
				async () => {
					const models = await resolveModels(model.provider)
					const target = models.getModel(model.provider, model.id) ?? model
					return models.streamSimple(target, context, options)
				},
				undefined,
				options?.signal,
			),
		completeSimple: async (model, context, options) => {
			const models = await resolveModels(model.provider)
			const target = models.getModel(model.provider, model.id) ?? model
			return models.completeSimple(target, context, options)
		},
		streamDeferred: (model, handle, options) =>
			lazyStream(
				model,
				async () => {
					const models = await resolveModels(model.provider)
					const target = models.getModel(model.provider, model.id) ?? model
					return models.streamDeferred(target, handle, options)
				},
				undefined,
				options?.signal,
			),
		fetchDeferred: async (model, handle, options) => {
			const models = await resolveModels(model.provider)
			const target = models.getModel(model.provider, model.id) ?? model
			return models.fetchDeferred(target, handle, options)
		},
		cancelDeferred: async (model, handle, options) => {
			const models = await resolveModels(model.provider)
			const target = models.getModel(model.provider, model.id) ?? model
			return models.cancelDeferred(target, handle, options)
		},
		generateImages: async (model, context, options) =>
			(await resolveModels(model.provider)).generateImages(model, context, options),
		classify: async (model, context, options) =>
			(await resolveModels(model.provider)).classify(model, context, options),
		setProvider: (provider) => {
			baselineModels.setProvider(provider)
		},
		deleteProvider: (id) => {
			baselineModels.deleteProvider(id)
		},
		clearProviders: () => {
			baselineModels.clearProviders()
		},
	}
}

export const dynamicPiProviderRuntime = (
	resolve: (context: PiProviderResolveContext) => Effect.Effect<ProviderRuntimeConfig>,
): PiProviderRuntimeService => ({
	forSession: ({ sessionId }) =>
		Effect.map(resolve({ sessionId }), (initialConfig) => ({
			createModels: () =>
				createDynamicProviderModels(initialConfig, (provider) =>
					Effect.runPromise(
						resolve(provider === undefined ? { sessionId } : { sessionId, provider }),
					),
				),
			checkCredentials: async (provider) => {
				const config = await Effect.runPromise(resolve({ sessionId, provider }))
				return checkCatalogProviderCredentials(provider, config, config.customProviders)
			},
		})),
})

/**
 * Loads provider credentials, custom provider definitions, and local-dev loopback
 * base URL overrides from the Worker environment, capturing the corresponding
 * Alchemy secret and config bindings during plan time.
 */
export const loadEnvPiProviderRuntime = Effect.gen(function* () {
	const workerEnv = yield* Effect.serviceOption(Cloudflare.Workers.WorkerEnvironment)
	const customProviders = yield* configuredCustomProviders
	const apiKeys = yield* loadProviderApiKeys(customProviders)
	const baseUrls = yield* providerBaseUrls
	return PiProviderRuntime.of({
		forSession: () => {
			const aiBinding = extractAiBinding(Option.getOrUndefined(workerEnv))
			const config = toProviderRuntimeConfig(apiKeys, baseUrls, { aiBinding, customProviders })
			return Effect.succeed({
				createModels: () => createProviderModels(config),
				checkCredentials: (provider: string) =>
					checkCatalogProviderCredentials(provider, config, customProviders),
			})
		},
	})
})

export const EnvPiProviderRuntimeLive = Layer.effect(PiProviderRuntime, loadEnvPiProviderRuntime)
