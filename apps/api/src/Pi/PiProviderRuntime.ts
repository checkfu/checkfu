import * as Cloudflare from "@alchemy.run/cloudflare"
import type { ProviderCredentialCheck, ProviderRuntimeConfig } from "@checkfu/pi-providers/catalog"
import { createProviderModels } from "@checkfu/pi-providers/runtime"
import { ModelsError, getModelType, lazyStream } from "@earendil-works/pi-ai"
import type { AnyModel, Api, Model, ModelType, ModelTypeMap, Provider } from "@earendil-works/pi-ai"
import { hasApi } from "@earendil-works/pi-ai/models"
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

const unavailableModelMessage = (provider: string, id: string): string =>
	`Model "${provider}/${id}" is not available in the current provider configuration.`

const requireCurrentChatModel = (models: MutableModels, model: Model<Api>): Model<Api> => {
	const resolved = models.getModel(model.provider, model.id)
	if (resolved === undefined) {
		throw new ModelsError("model_validation", unavailableModelMessage(model.provider, model.id))
	}
	return resolved
}

const requireCurrentTypedChatModel = <TApi extends Api>(
	models: MutableModels,
	model: Model<TApi>,
): Model<TApi> => {
	const resolved = requireCurrentChatModel(models, model)
	if (!hasApi(resolved, model.api)) {
		throw new ModelsError(
			"model_validation",
			`Model "${model.provider}/${model.id}" uses API "${resolved.api}", not "${model.api}".`,
		)
	}
	return resolved
}

interface DynamicModelsController {
	readonly models: MutableModels
	readonly syncConfig: (config: ProviderRuntimeConfig, provider?: string) => void
}

const createDynamicProviderModels = (
	initialConfig: ProviderRuntimeConfig,
	resolveConfig: (
		provider?: string,
		caller?: DynamicModelsController,
	) => Promise<ProviderRuntimeConfig>,
): DynamicModelsController => {
	let baselineModels = createProviderModels(initialConfig)
	let lastFullConfig: ProviderRuntimeConfig | undefined = initialConfig
	let cleared = false
	const overrides = new Map<string, Provider<Api>>()
	const deletions = new Set<string>()

	const applyMutations = (target: MutableModels): MutableModels => {
		if (cleared) {
			target.clearProviders()
		}
		for (const id of deletions) {
			target.deleteProvider(id)
		}
		for (const provider of overrides.values()) {
			target.setProvider(provider)
		}
		return target
	}

	const buildAndSync = (config: ProviderRuntimeConfig, provider?: string): MutableModels => {
		if (provider === undefined && config === lastFullConfig) {
			return baselineModels
		}
		const fresh = applyMutations(createProviderModels(config))
		if (provider === undefined) {
			baselineModels = fresh
			lastFullConfig = config
			return fresh
		}
		const updated = fresh.getProvider(provider)
		if (updated !== undefined) {
			baselineModels.setProvider(updated)
		} else {
			baselineModels.deleteProvider(provider)
		}
		lastFullConfig = undefined
		return fresh
	}

	const resolveModels = async (provider?: string): Promise<MutableModels> => {
		const nextConfig = await resolveConfig(provider, controller)
		return buildAndSync(nextConfig, provider)
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
		overridesParam?: Parameters<MutableModels["getAuth"]>[1],
	): ReturnType<MutableModels["getAuth"]>
	function getAuth(
		model: AnyModel,
		overridesParam?: Parameters<MutableModels["getAuth"]>[1],
	): ReturnType<MutableModels["getAuth"]>
	async function getAuth(
		target: string | AnyModel,
		overridesParam?: Parameters<MutableModels["getAuth"]>[1],
	) {
		const providerId = typeof target === "string" ? target : target.provider
		const models = await resolveModels(providerId)
		if (typeof target === "string") {
			return models.getAuth(target, overridesParam)
		}
		const resolved = models.getModelOfType(getModelType(target), target.provider, target.id)
		if (resolved === undefined) {
			return undefined
		}
		return models.getAuth(resolved, overridesParam)
	}

	const stream: MutableModels["stream"] = (model, context, options) =>
		lazyStream(
			model,
			async () => {
				const models = await resolveModels(model.provider)
				const target = requireCurrentTypedChatModel(models, model)
				return models.stream(target, context, options)
			},
			undefined,
			options?.signal,
		)

	const streamSimple: MutableModels["streamSimple"] = (model, context, options) =>
		lazyStream(
			model,
			async () => {
				const models = await resolveModels(model.provider)
				const target = requireCurrentChatModel(models, model)
				return models.streamSimple(target, context, options)
			},
			undefined,
			options?.signal,
		)

	const streamDeferred: MutableModels["streamDeferred"] = (model, handle, options) =>
		lazyStream(
			model,
			async () => {
				const models = await resolveModels(model.provider)
				const target = requireCurrentChatModel(models, model)
				return models.streamDeferred(target, handle, options)
			},
			undefined,
			options?.signal,
		)

	const models: MutableModels = {
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
		stream,
		complete: (model, context, options) => stream(model, context, options).result(),
		streamSimple,
		completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
		streamDeferred,
		fetchDeferred: (model, handle, options) => streamDeferred(model, handle, options).result(),
		cancelDeferred: async (model, handle, options) => {
			const resolvedModels = await resolveModels(model.provider)
			const target = requireCurrentChatModel(resolvedModels, model)
			return resolvedModels.cancelDeferred(target, handle, options)
		},
		generateImages: async (model, context, options) => {
			const resolvedModels = await resolveModels(model.provider)
			const target = resolvedModels.getModelOfType("image", model.provider, model.id)
			if (target === undefined) {
				return {
					api: model.api,
					provider: model.provider,
					model: model.id,
					output: [],
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: unavailableModelMessage(model.provider, model.id),
					timestamp: Date.now(),
				}
			}
			return resolvedModels.generateImages(target, context, options)
		},
		classify: async (model, context, options) => {
			const resolvedModels = await resolveModels(model.provider)
			const target = resolvedModels.getModelOfType("classifier", model.provider, model.id)
			if (target === undefined) {
				return {
					api: model.api,
					provider: model.provider,
					model: model.id,
					answers: {},
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: unavailableModelMessage(model.provider, model.id),
					timestamp: Date.now(),
				}
			}
			return resolvedModels.classify(target, context, options)
		},
		setProvider: (provider) => {
			deletions.delete(provider.id)
			overrides.set(provider.id, provider)
			lastFullConfig = undefined
			baselineModels.setProvider(provider)
		},
		deleteProvider: (id) => {
			overrides.delete(id)
			deletions.add(id)
			lastFullConfig = undefined
			baselineModels.deleteProvider(id)
		},
		clearProviders: () => {
			cleared = true
			overrides.clear()
			deletions.clear()
			lastFullConfig = undefined
			baselineModels.clearProviders()
		},
	}

	const controller: DynamicModelsController = {
		models,
		syncConfig: (config, provider) => {
			buildAndSync(config, provider)
		},
	}

	return controller
}

export const dynamicPiProviderRuntime = (
	resolve: (context: PiProviderResolveContext) => Effect.Effect<ProviderRuntimeConfig>,
): PiProviderRuntimeService => ({
	forSession: ({ sessionId }) =>
		Effect.map(resolve({ sessionId }), (initialConfig) => {
			let latestConfig = initialConfig
			const syncedByProvider = new Map<string, ProviderRuntimeConfig>()
			const instances = new Set<DynamicModelsController>()

			const resolveAndSync = async (
				provider?: string,
				caller?: DynamicModelsController,
			): Promise<ProviderRuntimeConfig> => {
				const config = await Effect.runPromise(
					resolve(provider === undefined ? { sessionId } : { sessionId, provider }),
				)
				if (provider === undefined) {
					latestConfig = config
					syncedByProvider.clear()
				} else {
					syncedByProvider.set(provider, config)
				}
				for (const instance of instances) {
					if (instance !== caller) {
						instance.syncConfig(config, provider)
					}
				}
				return config
			}

			return {
				createModels: () => {
					const controller = createDynamicProviderModels(latestConfig, resolveAndSync)
					for (const [provider, config] of syncedByProvider) {
						controller.syncConfig(config, provider)
					}
					instances.add(controller)
					return controller.models
				},
				checkCredentials: async (provider) => {
					const config = await resolveAndSync(provider)
					return checkCatalogProviderCredentials(provider, config, config.customProviders)
				},
			}
		}),
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
