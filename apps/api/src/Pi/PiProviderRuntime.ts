import * as Cloudflare from "@alchemy.run/cloudflare"
import { allProviders } from "@checkfu/pi-providers/catalog"
import type { ProviderCredentialCheck, ProviderRuntimeConfig } from "@checkfu/pi-providers/catalog"
import {
	buildPiProvider,
	createProviderModels,
	withDynamicModelLookup,
} from "@checkfu/pi-providers/runtime"
import {
	InMemoryCredentialStore,
	InMemoryModelsStore,
	ModelsError,
	createModels,
	getModelType,
	lazyStream,
} from "@earendil-works/pi-ai"
import type { AnyModel, Api, Model, ModelType, ModelTypeMap, Provider } from "@earendil-works/pi-ai"
import { hasApi } from "@earendil-works/pi-ai/models"
import type { ModelsRefreshResult, MutableModels } from "@earendil-works/pi-ai/models"
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
	readonly releaseModels?: (models: MutableModels) => void
	readonly checkCredentials: (
		provider: string,
		signal?: AbortSignal,
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

const EMPTY_AUTH_CONTEXT = {
	env: () => Promise.resolve(undefined),
	fileExists: () => Promise.resolve(false),
} as const

const MODEL_LOOKUP_IDS = new WeakMap<AnyModel, string>()

const rememberLookupId = <T extends AnyModel | undefined>(model: T, lookupId: string): T => {
	if (model !== undefined) {
		MODEL_LOOKUP_IDS.set(model, lookupId)
	}
	return model
}

const lookupIdOf = (model: AnyModel): string => MODEL_LOOKUP_IDS.get(model) ?? model.id

const hasConfiguredProvider = (config: ProviderRuntimeConfig, providerId: string): boolean =>
	allProviders(config.customProviders).some((spec) => spec.id === providerId)

const unavailableModelMessage = (provider: string, id: string): string =>
	`Model "${provider}/${id}" is not available in the current provider configuration.`

const errorMessageOf = (error: unknown): string =>
	typeof error === "object" &&
	error !== null &&
	"message" in error &&
	typeof error.message === "string"
		? error.message
		: String(error)

const requireCurrentChatModel = (models: MutableModels, model: Model<Api>): Model<Api> => {
	const lookupId = lookupIdOf(model)
	const resolved = models.getModel(model.provider, lookupId)
	if (resolved === undefined) {
		throw new ModelsError("model_validation", unavailableModelMessage(model.provider, lookupId))
	}
	return rememberLookupId(resolved, lookupId)
}

const requireCurrentTypedChatModel = <TApi extends Api>(
	models: MutableModels,
	model: Model<TApi>,
): Model<TApi> => {
	const resolved = requireCurrentChatModel(models, model)
	if (!hasApi(resolved, model.api)) {
		throw new ModelsError(
			"model_validation",
			`Model "${model.provider}/${lookupIdOf(model)}" uses API "${resolved.api}", not "${model.api}".`,
		)
	}
	return resolved
}

interface ResolvedSnapshot {
	readonly config: ProviderRuntimeConfig
	readonly seq: number
}

interface DynamicModelsController {
	readonly models: MutableModels
	readonly syncConfig: (
		config: ProviderRuntimeConfig,
		provider: string | undefined,
		seq: number,
	) => void
	readonly syncTombstone: (provider: string, seq: number) => void
}

interface ActiveRefreshPhase {
	readonly providers: ReadonlySet<string> | undefined
	readonly controller: AbortController
}

const refreshScopesOverlap = (
	left: ReadonlySet<string> | undefined,
	right: ReadonlySet<string> | undefined,
): boolean => {
	if (left === undefined || right === undefined) {
		return true
	}
	for (const id of left) {
		if (right.has(id)) {
			return true
		}
	}
	return false
}

const createDynamicProviderModels = (
	initialConfig: ProviderRuntimeConfig,
	initialSeq: number,
	resolveConfig: (
		provider: string | undefined,
		signal: AbortSignal | undefined,
		caller?: DynamicModelsController,
	) => Promise<ResolvedSnapshot>,
): DynamicModelsController => {
	const credentials = new InMemoryCredentialStore()
	const modelsStore = new InMemoryModelsStore()
	const emptyRegistry = createModels({
		credentials,
		modelsStore,
		authContext: EMPTY_AUTH_CONTEXT,
	})
	const refreshHost = createModels({
		credentials,
		modelsStore,
		authContext: EMPTY_AUTH_CONTEXT,
	})

	const buildRegistry = (config: ProviderRuntimeConfig): MutableModels => {
		const base = createModels({
			credentials,
			modelsStore,
			authContext: EMPTY_AUTH_CONTEXT,
		})
		for (const spec of allProviders(config.customProviders)) {
			base.setProvider(buildPiProvider(spec, config))
		}
		return withDynamicModelLookup(base, config)
	}

	let fullRegistry = buildRegistry(initialConfig)
	let fullSeq = initialSeq
	let lastFullConfig: ProviderRuntimeConfig | undefined = initialConfig
	const providerRegistries = new Map<string, MutableModels>()
	const providerSeqs = new Map<string, number>()
	const tombstonedProviders = new Map<string, number>()

	let cleared = false
	const overrides = new Map<string, Provider<Api>>()
	const deletions = new Set<string>()
	const activeRefreshPhases = new Set<ActiveRefreshPhase>()

	const abortRefreshPhases = (targets?: ReadonlySet<string>): void => {
		for (const phase of activeRefreshPhases) {
			if (refreshScopesOverlap(phase.providers, targets)) {
				phase.controller.abort()
			}
		}
	}

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

	const registryForProvider = (providerId: string): MutableModels => {
		if (deletions.has(providerId)) {
			return emptyRegistry
		}
		if (overrides.has(providerId)) {
			return fullRegistry
		}
		if (tombstonedProviders.has(providerId)) {
			return emptyRegistry
		}
		return providerRegistries.get(providerId) ?? fullRegistry
	}

	const liveProviderIds = (): ReadonlyArray<string> => {
		const seen = new Set<string>()
		for (const provider of fullRegistry.getProviders()) {
			seen.add(provider.id)
		}
		for (const providerId of providerRegistries.keys()) {
			seen.add(providerId)
		}
		for (const providerId of overrides.keys()) {
			seen.add(providerId)
		}
		const live: Array<string> = []
		for (const providerId of seen) {
			if (registryForProvider(providerId).getProvider(providerId) !== undefined) {
				live.push(providerId)
			}
		}
		return live
	}

	const applyTombstone = (provider: string, seq: number): void => {
		const watermark = Math.max(
			fullSeq,
			providerSeqs.get(provider) ?? 0,
			tombstonedProviders.get(provider) ?? 0,
		)
		if (seq <= watermark) {
			return
		}
		providerRegistries.delete(provider)
		providerSeqs.delete(provider)
		if (fullRegistry.getProvider(provider) !== undefined) {
			tombstonedProviders.set(provider, seq)
		} else {
			tombstonedProviders.delete(provider)
		}
	}

	const applySnapshot = (
		config: ProviderRuntimeConfig,
		provider: string | undefined,
		seq: number,
	): MutableModels => {
		if (provider === undefined) {
			if (seq < fullSeq || (seq === fullSeq && config === lastFullConfig)) {
				return fullRegistry
			}
			const fresh = applyMutations(buildRegistry(config))
			fullRegistry = fresh
			fullSeq = seq
			lastFullConfig = config
			for (const [providerId, providerSeq] of providerSeqs) {
				if (providerSeq <= seq) {
					providerSeqs.delete(providerId)
					providerRegistries.delete(providerId)
				}
			}
			for (const [providerId, tombstoneSeq] of tombstonedProviders) {
				if (tombstoneSeq <= seq) {
					tombstonedProviders.delete(providerId)
				}
			}
			return fresh
		}

		if (deletions.has(provider)) {
			return emptyRegistry
		}
		if (overrides.has(provider)) {
			return fullRegistry
		}

		const watermark = Math.max(
			fullSeq,
			providerSeqs.get(provider) ?? 0,
			tombstonedProviders.get(provider) ?? 0,
		)
		if (seq <= watermark) {
			return registryForProvider(provider)
		}

		if (!hasConfiguredProvider(config, provider)) {
			applyTombstone(provider, seq)
			return emptyRegistry
		}

		tombstonedProviders.delete(provider)
		const fresh = applyMutations(buildRegistry(config))
		providerRegistries.set(provider, fresh)
		providerSeqs.set(provider, seq)
		return fresh
	}

	const resolveModels = async (provider?: string, signal?: AbortSignal): Promise<MutableModels> => {
		const snapshot = await resolveConfig(provider, signal, controller)
		return applySnapshot(snapshot.config, provider, snapshot.seq)
	}

	const readAvailableAcrossProviders = async <T>(
		providerId: string | undefined,
		signal: AbortSignal | undefined,
		read: (registry: MutableModels, id: string) => Promise<ReadonlyArray<T>>,
	): Promise<ReadonlyArray<T>> => {
		const resolvedModels = await resolveModels(providerId, signal)
		if (providerId !== undefined) {
			return read(resolvedModels, providerId)
		}
		const chunks = await Promise.all(
			liveProviderIds().map((id) => read(registryForProvider(id), id)),
		)
		return chunks.flat()
	}

	const syncRefreshHost = (selected: ReadonlySet<string> | undefined): void => {
		const targets = new Set<string>()
		if (selected !== undefined) {
			for (const id of selected) {
				targets.add(id)
			}
		} else {
			for (const id of liveProviderIds()) {
				targets.add(id)
			}
			for (const existing of refreshHost.getProviders()) {
				targets.add(existing.id)
			}
		}
		for (const id of targets) {
			const next = registryForProvider(id).getProvider(id)
			if (next === undefined) {
				refreshHost.deleteProvider(id)
			} else {
				refreshHost.setProvider(next)
			}
		}
	}

	function getModelsOfType<TType extends ModelType>(
		type: TType,
		provider?: string,
	): ReadonlyArray<ModelTypeMap[TType]>
	function getModelsOfType(
		type: ModelType,
		provider?: string,
	): ReadonlyArray<ModelTypeMap[ModelType]> {
		if (provider !== undefined) {
			return registryForProvider(provider).getModelsOfType(type, provider)
		}
		return liveProviderIds().flatMap((providerId) =>
			registryForProvider(providerId).getModelsOfType(type, providerId),
		)
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
		return rememberLookupId(
			registryForProvider(providerId).getModelOfType(type, providerId, id),
			id,
		)
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
		return readAvailableAcrossProviders(providerId, options?.signal, (registry, id) =>
			registry.getAvailableOfType(type, id, options),
		)
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
		const resolvedModels = await resolveModels(providerId, overridesParam?.signal)
		if (typeof target === "string") {
			return resolvedModels.getAuth(target, overridesParam)
		}
		const lookupId = lookupIdOf(target)
		const resolved = resolvedModels.getModelOfType(getModelType(target), target.provider, lookupId)
		if (resolved === undefined) {
			return undefined
		}
		return resolvedModels.getAuth(rememberLookupId(resolved, lookupId), overridesParam)
	}

	const stream: MutableModels["stream"] = (model, context, options) =>
		lazyStream(
			model,
			async () => {
				const resolvedModels = await resolveModels(model.provider, options?.signal)
				const target = requireCurrentTypedChatModel(resolvedModels, model)
				return resolvedModels.stream(target, context, options)
			},
			undefined,
			options?.signal,
		)

	const streamSimple: MutableModels["streamSimple"] = (model, context, options) =>
		lazyStream(
			model,
			async () => {
				const resolvedModels = await resolveModels(model.provider, options?.signal)
				const target = requireCurrentChatModel(resolvedModels, model)
				return resolvedModels.streamSimple(target, context, options)
			},
			undefined,
			options?.signal,
		)

	const streamDeferred: MutableModels["streamDeferred"] = (model, handle, options) =>
		lazyStream(
			model,
			async () => {
				const resolvedModels = await resolveModels(model.provider, options?.signal)
				const target = requireCurrentChatModel(resolvedModels, model)
				return resolvedModels.streamDeferred(target, handle, options)
			},
			undefined,
			options?.signal,
		)

	const models: MutableModels = {
		getProviders: () =>
			liveProviderIds().flatMap((providerId) => {
				const provider = registryForProvider(providerId).getProvider(providerId)
				return provider === undefined ? [] : [provider]
			}),
		getProvider: (id) => registryForProvider(id).getProvider(id),
		getModels: (provider) =>
			provider !== undefined
				? registryForProvider(provider).getModels(provider)
				: liveProviderIds().flatMap((providerId) =>
						registryForProvider(providerId).getModels(providerId),
					),
		getAllModels: (provider) =>
			provider !== undefined
				? registryForProvider(provider).getAllModels(provider)
				: liveProviderIds().flatMap((providerId) =>
						registryForProvider(providerId).getAllModels(providerId),
					),
		getModelsOfType,
		getModel: (providerId, id) =>
			rememberLookupId(registryForProvider(providerId).getModel(providerId, id), id),
		getModelOfType,
		refresh: async (options): Promise<ModelsRefreshResult> => {
			if (options?.signal?.aborted) {
				return { aborted: true, errors: new Map() }
			}
			const selected = options?.providers === undefined ? undefined : new Set(options.providers)
			abortRefreshPhases(selected)
			const phase: ActiveRefreshPhase = {
				providers: selected,
				controller: new AbortController(),
			}
			activeRefreshPhases.add(phase)
			const combinedSignal =
				options?.signal === undefined
					? phase.controller.signal
					: AbortSignal.any([options.signal, phase.controller.signal])
			try {
				await resolveModels(undefined, combinedSignal)
			} catch (error) {
				if (options?.signal?.aborted) {
					return { aborted: true, errors: new Map() }
				}
				if (phase.controller.signal.aborted) {
					return { aborted: false, errors: new Map() }
				}
				throw error
			} finally {
				activeRefreshPhases.delete(phase)
			}
			if (options?.signal?.aborted) {
				return { aborted: true, errors: new Map() }
			}
			if (phase.controller.signal.aborted) {
				return { aborted: false, errors: new Map() }
			}
			syncRefreshHost(selected)
			return refreshHost.refresh(options)
		},
		checkAuth: async (providerId, options) =>
			(await resolveModels(providerId, options?.signal)).checkAuth(providerId, options),
		getAvailable: (providerId, options) =>
			readAvailableAcrossProviders(providerId, options?.signal, (registry, id) =>
				registry.getAvailable(id, options),
			),
		getAvailableOfType,
		getAllAvailable: (providerId, options) =>
			readAvailableAcrossProviders(providerId, options?.signal, (registry, id) =>
				registry.getAllAvailable(id, options),
			),
		getAuth,
		login: async (providerId, type, interaction, options) =>
			(await resolveModels(providerId, interaction.signal)).login(
				providerId,
				type,
				interaction,
				options,
			),
		logout: async (providerId, options) =>
			(await resolveModels(providerId, options?.signal)).logout(providerId, options),
		stream,
		complete: (model, context, options) => stream(model, context, options).result(),
		streamSimple,
		completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
		streamDeferred,
		fetchDeferred: (model, handle, options) => streamDeferred(model, handle, options).result(),
		cancelDeferred: async (model, handle, options) => {
			const resolvedModels = await resolveModels(model.provider, options?.signal)
			const target = requireCurrentChatModel(resolvedModels, model)
			return resolvedModels.cancelDeferred(target, handle, options)
		},
		generateImages: async (model, context, options) => {
			try {
				const resolvedModels = await resolveModels(model.provider, options?.signal)
				const lookupId = lookupIdOf(model)
				const target = resolvedModels.getModelOfType("image", model.provider, lookupId)
				if (target === undefined) {
					return {
						api: model.api,
						provider: model.provider,
						model: model.id,
						output: [],
						stopReason: options?.signal?.aborted ? "aborted" : "error",
						errorMessage: unavailableModelMessage(model.provider, lookupId),
						timestamp: Date.now(),
					}
				}
				return await resolvedModels.generateImages(
					rememberLookupId(target, lookupId),
					context,
					options,
				)
			} catch (error) {
				return {
					api: model.api,
					provider: model.provider,
					model: model.id,
					output: [],
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: errorMessageOf(error),
					timestamp: Date.now(),
				}
			}
		},
		classify: async (model, context, options) => {
			try {
				const resolvedModels = await resolveModels(model.provider, options?.signal)
				const lookupId = lookupIdOf(model)
				const target = resolvedModels.getModelOfType("classifier", model.provider, lookupId)
				if (target === undefined) {
					return {
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: {},
						stopReason: options?.signal?.aborted ? "aborted" : "error",
						errorMessage: unavailableModelMessage(model.provider, lookupId),
						timestamp: Date.now(),
					}
				}
				return await resolvedModels.classify(rememberLookupId(target, lookupId), context, options)
			} catch (error) {
				return {
					api: model.api,
					provider: model.provider,
					model: model.id,
					answers: {},
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: errorMessageOf(error),
					timestamp: Date.now(),
				}
			}
		},
		setProvider: (provider) => {
			abortRefreshPhases(new Set([provider.id]))
			deletions.delete(provider.id)
			tombstonedProviders.delete(provider.id)
			overrides.set(provider.id, provider)
			providerRegistries.delete(provider.id)
			providerSeqs.delete(provider.id)
			lastFullConfig = undefined
			fullRegistry.setProvider(provider)
			refreshHost.setProvider(provider)
		},
		deleteProvider: (id) => {
			abortRefreshPhases(new Set([id]))
			overrides.delete(id)
			tombstonedProviders.delete(id)
			deletions.add(id)
			providerRegistries.delete(id)
			providerSeqs.delete(id)
			lastFullConfig = undefined
			fullRegistry.deleteProvider(id)
			refreshHost.deleteProvider(id)
		},
		clearProviders: () => {
			abortRefreshPhases(undefined)
			cleared = true
			overrides.clear()
			deletions.clear()
			tombstonedProviders.clear()
			providerRegistries.clear()
			providerSeqs.clear()
			lastFullConfig = undefined
			fullRegistry.clearProviders()
			refreshHost.clearProviders()
		},
	}

	const controller: DynamicModelsController = {
		models,
		syncConfig: (config, provider, seq) => {
			applySnapshot(config, provider, seq)
		},
		syncTombstone: (provider, seq) => {
			applyTombstone(provider, seq)
		},
	}

	return controller
}

interface InFlightProviderOrdering {
	count: number
	winnerSeq: number
	winnerSnapshot?: ResolvedSnapshot
}

export const dynamicPiProviderRuntime = (
	resolve: (context: PiProviderResolveContext) => Effect.Effect<ProviderRuntimeConfig>,
): PiProviderRuntimeService => ({
	forSession: ({ sessionId }) =>
		Effect.map(resolve({ sessionId }), (initialConfig) => {
			let nextSeq = 0
			let latestFullSeq = 0
			let latestFullConfig = initialConfig
			const syncedByProvider = new Map<string, ResolvedSnapshot>()
			const tombstonedByProvider = new Map<string, number>()
			const inFlightByProvider = new Map<string, InFlightProviderOrdering>()
			const instances = new Set<WeakRef<DynamicModelsController>>()
			const refsByModels = new WeakMap<MutableModels, WeakRef<DynamicModelsController>>()

			const notifyConfig = (
				config: ProviderRuntimeConfig,
				provider: string | undefined,
				seq: number,
				caller?: DynamicModelsController,
			): void => {
				for (const ref of instances) {
					const instance = ref.deref()
					if (instance === undefined) {
						instances.delete(ref)
						continue
					}
					if (instance !== caller) {
						instance.syncConfig(config, provider, seq)
					}
				}
			}

			const notifyTombstone = (
				provider: string,
				seq: number,
				caller?: DynamicModelsController,
			): void => {
				for (const ref of instances) {
					const instance = ref.deref()
					if (instance === undefined) {
						instances.delete(ref)
						continue
					}
					if (instance !== caller) {
						instance.syncTombstone(provider, seq)
					}
				}
			}

			const resolveAndSync = async (
				provider: string | undefined,
				signal: AbortSignal | undefined,
				caller?: DynamicModelsController,
			): Promise<ResolvedSnapshot> => {
				const seq = ++nextSeq
				if (provider === undefined) {
					const config = await Effect.runPromise(
						resolve({ sessionId }),
						signal === undefined ? undefined : { signal },
					)
					if (seq > latestFullSeq) {
						latestFullSeq = seq
						latestFullConfig = config
						for (const [providerId, entry] of syncedByProvider) {
							if (entry.seq <= seq) {
								syncedByProvider.delete(providerId)
							}
						}
						for (const [providerId, tombstoneSeq] of tombstonedByProvider) {
							if (tombstoneSeq <= seq) {
								tombstonedByProvider.delete(providerId)
							}
						}
						notifyConfig(config, undefined, seq, caller)
						return { config, seq }
					}
					return { config: latestFullConfig, seq: latestFullSeq }
				}

				const inFlight = inFlightByProvider.get(provider) ?? { count: 0, winnerSeq: 0 }
				inFlight.count += 1
				inFlightByProvider.set(provider, inFlight)
				try {
					const config = await Effect.runPromise(
						resolve({ sessionId, provider }),
						signal === undefined ? undefined : { signal },
					)
					const existing = syncedByProvider.get(provider)
					const existingTombstone = tombstonedByProvider.get(provider) ?? 0
					const watermark = Math.max(
						latestFullSeq,
						existing?.seq ?? 0,
						existingTombstone,
						inFlight.winnerSeq,
					)
					if (seq > watermark) {
						const snapshot: ResolvedSnapshot = { config, seq }
						inFlight.winnerSeq = seq
						inFlight.winnerSnapshot = snapshot
						if (hasConfiguredProvider(config, provider)) {
							tombstonedByProvider.delete(provider)
							syncedByProvider.set(provider, snapshot)
							notifyConfig(config, provider, seq, caller)
						} else {
							const hadSnapshot = syncedByProvider.delete(provider)
							const inFull = hasConfiguredProvider(latestFullConfig, provider)
							if (inFull) {
								tombstonedByProvider.set(provider, seq)
							} else {
								tombstonedByProvider.delete(provider)
							}
							if (hadSnapshot || inFull) {
								notifyTombstone(provider, seq, caller)
							}
						}
						return snapshot
					}
					if (existing !== undefined && existing.seq >= latestFullSeq) {
						return existing
					}
					if (inFlight.winnerSnapshot !== undefined && inFlight.winnerSeq >= latestFullSeq) {
						return inFlight.winnerSnapshot
					}
					return { config: latestFullConfig, seq: latestFullSeq }
				} finally {
					inFlight.count -= 1
					if (inFlight.count === 0) {
						inFlightByProvider.delete(provider)
					}
				}
			}

			return {
				createModels: () => {
					const controller = createDynamicProviderModels(
						latestFullConfig,
						latestFullSeq,
						resolveAndSync,
					)
					for (const [provider, entry] of syncedByProvider) {
						controller.syncConfig(entry.config, provider, entry.seq)
					}
					for (const [provider, tombstoneSeq] of tombstonedByProvider) {
						controller.syncTombstone(provider, tombstoneSeq)
					}
					const ref = new WeakRef(controller)
					instances.add(ref)
					refsByModels.set(controller.models, ref)
					return controller.models
				},
				releaseModels: (models) => {
					const ref = refsByModels.get(models)
					if (ref !== undefined) {
						instances.delete(ref)
						refsByModels.delete(models)
					}
				},
				checkCredentials: async (provider, signal) => {
					const snapshot = await resolveAndSync(provider, signal)
					return checkCatalogProviderCredentials(
						provider,
						snapshot.config,
						snapshot.config.customProviders,
					)
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
