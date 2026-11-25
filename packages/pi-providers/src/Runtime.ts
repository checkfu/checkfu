import type {
	AnyModel,
	Api,
	Model,
	ModelType,
	ModelTypeMap,
	Provider,
	ProviderAuth,
	ProviderHeaders,
	ProviderStreams,
} from "@earendil-works/pi-ai"
import { createModels, createProvider, hasApi, isModelType } from "@earendil-works/pi-ai/models"
import type { MutableModels } from "@earendil-works/pi-ai/models"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import { parseLoopbackBaseUrl, parsePinnedProviderBaseUrl } from "./Fetch.ts"
import { resolveProviderModelPlan } from "./ModelResolution.ts"
import {
	BUILTIN_PROVIDERS,
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_OPENAI_BASE_URL,
	allProviders,
	assertValidProviderSpec,
} from "./Providers.ts"
import { DEFAULT_MIN_CONTEXT_WINDOW, DEFAULT_SYNTHESIZED_MAX_TOKENS, ownProperty } from "./Types.ts"
import type {
	ProviderModelDefaults,
	ProviderRuntimeConfig,
	ProviderSpec,
	WireFormat,
} from "./Types.ts"
import { createWireFormatStreams } from "./WireFormats.ts"
import type { WireFormatOptions } from "./WireFormats.ts"

export {
	createNoRedirectProviderFetch,
	parseLoopbackBaseUrl,
	parseProviderBaseUrl,
} from "./Fetch.ts"
export {
	ANTHROPIC_DEFAULT_REFUSAL_ERROR,
	ANTHROPIC_SENSITIVE_ERROR,
	DEFAULT_REFUSAL_TEXT,
	OPENAI_COMPLETIONS_CONTENT_FILTER_ERROR,
	OPENAI_INCOMPLETE_CONTENT_FILTER_ERROR,
	OPENAI_REFUSAL_ERROR,
	isRefusalAssistantMessage,
	isWireFormatRefusalStopReason,
	normalizeRefusalAssistantMessage,
	preservesExplicitRefusalContent,
} from "./Refusals.ts"
export {
	createAnthropicMessagesWire,
	createOpenAICompletionsWire,
	createOpenAIResponsesWire,
	createWireFormatStreams,
} from "./WireFormats.ts"
export type { WireFormatOptions } from "./WireFormats.ts"

const isWireFormatModel = (model: Model<Api>): model is Model<WireFormat> =>
	hasApi(model, "anthropic-messages") ||
	hasApi(model, "openai-responses") ||
	hasApi(model, "openai-completions")

const filterWireModels = (
	catalog: Readonly<Record<string, Model<Api>>>,
): ReadonlyArray<Model<WireFormat>> => Object.values(catalog).filter(isWireFormatModel)

const STATIC_MODEL_CATALOGS = new Map<string, ReadonlyArray<Model<WireFormat>>>([
	["openai", filterWireModels(OPENAI_MODELS)],
	["anthropic", filterWireModels(ANTHROPIC_MODELS)],
])

const SHARED_BUILTIN_CATALOG_CACHE = new Map<string, ReadonlyArray<Model<WireFormat>>>()

const BUILTIN_CANONICAL_SPECS = new Map<string, ProviderSpec>(
	BUILTIN_PROVIDERS.map((provider) => [provider.id, provider]),
)
const CANONICAL_OPENAI_ORIGIN = new URL(DEFAULT_OPENAI_BASE_URL).origin
const CANONICAL_ANTHROPIC_ORIGIN = new URL(DEFAULT_ANTHROPIC_BASE_URL).origin

const formatsEqual = (left: ReadonlyArray<WireFormat>, right: ReadonlyArray<WireFormat>): boolean =>
	left.length === right.length && left.every((format, index) => format === right[index])

const resolveProviderBaseUrl = (spec: ProviderSpec, config: ProviderRuntimeConfig): string => {
	const override = ownProperty(config.baseUrlOverrides, spec.id)
	if (override !== undefined && override !== null) {
		return parseLoopbackBaseUrl(override, `${spec.id} base URL`)
	}
	return parsePinnedProviderBaseUrl(spec.baseUrl, `provider "${spec.id}" baseUrl`).baseUrl
}

const declaredProviderModelIds = (spec: ProviderSpec): ReadonlyArray<string> => {
	const ids: Array<string> = []
	const seen = new Set<string>()
	const add = (id: string) => {
		if (!seen.has(id)) {
			seen.add(id)
			ids.push(id)
		}
	}
	if (spec.models !== undefined) {
		for (const id of Object.keys(spec.models)) {
			add(id)
		}
	}
	if (spec.source === "custom" && spec.defaultModel !== undefined) {
		const prefix = `${spec.id}/`
		const stripped = spec.defaultModel.startsWith(prefix)
			? spec.defaultModel.slice(prefix.length)
			: spec.defaultModel
		if (stripped.length > 0) {
			add(stripped)
		}
	}
	return ids
}

const staticModelsForProvider = (
	spec: ProviderSpec,
	resolvedBaseUrl: string,
	config: ProviderRuntimeConfig,
): ReadonlyArray<Model<WireFormat>> => {
	const minContextWindow = config.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW
	const models: Array<Model<WireFormat>> = []
	const seen = new Set<string>()
	const catalog = STATIC_MODEL_CATALOGS.get(spec.id)
	if (catalog !== undefined) {
		for (const model of catalog) {
			if (model.contextWindow < minContextWindow || !spec.formats.includes(model.api)) {
				continue
			}
			seen.add(model.id)
			models.push(
				model.baseUrl === resolvedBaseUrl ? model : { ...model, baseUrl: resolvedBaseUrl },
			)
		}
	}
	for (const declaredId of declaredProviderModelIds(spec)) {
		if (seen.has(declaredId)) {
			continue
		}
		const synthesized = synthesizeProviderModel(spec, declaredId, config)
		if (synthesized !== undefined) {
			seen.add(synthesized.id)
			models.push(synthesized)
		}
	}
	return models
}

const composeAuthHeaders = (
	suppressedDefaults: ReadonlyArray<string>,
	extraHeaders: ProviderHeaders | undefined,
	primaryHeaders?: ReadonlyArray<readonly [string, string]>,
): ProviderHeaders | undefined => {
	const byLower = new Map<string, readonly [string, string | null]>()
	for (const headerName of suppressedDefaults) {
		byLower.set(headerName.toLowerCase(), [headerName, null])
	}
	if (extraHeaders !== undefined) {
		for (const [headerName, headerValue] of Object.entries(extraHeaders)) {
			byLower.set(headerName.toLowerCase(), [headerName, headerValue])
		}
	}
	if (primaryHeaders !== undefined) {
		for (const [headerName, headerValue] of primaryHeaders) {
			byLower.set(headerName.toLowerCase(), [headerName, headerValue])
		}
	}
	return byLower.size === 0 ? undefined : Object.fromEntries(byLower.values())
}

interface AuthEnvLookupContext {
	readonly env: (key: string) => Promise<string | undefined>
}

interface AuthCredentialLookup {
	readonly key?: string
	readonly env?: Readonly<Record<string, string>>
}

interface ResolvedAuthEnvValue {
	readonly value: string
	readonly fromExplicitCredential: boolean
}

const EMPTY_AUTH_CONTEXT = {
	env: () => Promise.resolve(undefined),
	fileExists: () => Promise.resolve(false),
} as const

const resolveAuthEnvValue = async (
	envName: string,
	config: ProviderRuntimeConfig,
	ctx: AuthEnvLookupContext,
	credential: AuthCredentialLookup | undefined,
	signal: AbortSignal,
	options?: { readonly isApiKey?: boolean; readonly trim?: boolean },
): Promise<ResolvedAuthEnvValue | undefined> => {
	const normalize = (raw: string | undefined): string | undefined => {
		if (raw === undefined) {
			return undefined
		}
		const trimmed = raw.trim()
		if (trimmed.length === 0) {
			return undefined
		}
		return options?.trim ? trimmed : raw
	}
	if (options?.isApiKey) {
		const explicitKey = normalize(credential?.key)
		if (explicitKey !== undefined) {
			return { value: explicitKey, fromExplicitCredential: true }
		}
	}
	const credEnv = normalize(ownProperty(credential?.env, envName))
	if (credEnv !== undefined) {
		return { value: credEnv, fromExplicitCredential: false }
	}
	signal.throwIfAborted()
	const ctxEnv = normalize(await ctx.env(envName))
	signal.throwIfAborted()
	if (ctxEnv !== undefined) {
		return { value: ctxEnv, fromExplicitCredential: false }
	}
	const configEnv = normalize(ownProperty(config.env, envName))
	if (configEnv !== undefined) {
		return { value: configEnv, fromExplicitCredential: false }
	}
	return undefined
}

const resolveSecretHeaders = async (
	spec: ProviderSpec,
	config: ProviderRuntimeConfig,
	ctx: AuthEnvLookupContext,
	credential: AuthCredentialLookup | undefined,
	signal: AbortSignal,
): Promise<ProviderHeaders | undefined> => {
	const staticHeaders = spec.headers
	const secretHeaders = spec.secretHeaders
	if (staticHeaders === undefined && secretHeaders === undefined) {
		return undefined
	}
	const byLower = new Map<string, readonly [string, string | null]>()
	if (staticHeaders !== undefined) {
		for (const [headerName, headerValue] of Object.entries(staticHeaders)) {
			byLower.set(headerName.toLowerCase(), [headerName, headerValue])
		}
	}
	if (secretHeaders !== undefined) {
		for (const [headerName, envName] of Object.entries(secretHeaders)) {
			const resolved = await resolveAuthEnvValue(envName, config, ctx, credential, signal)
			if (resolved === undefined) {
				return undefined
			}
			byLower.set(headerName.toLowerCase(), [headerName, resolved.value])
		}
	}
	return Object.fromEntries(byLower.values())
}

const PLACEHOLDER_SDK_API_KEY = "sk-unused"

const codecAcceptsHeaderOnlyAuth = (format: WireFormat, headerName: string): boolean => {
	const lower = headerName.toLowerCase()
	if (lower === "authorization" || lower === "cf-aig-authorization") {
		return true
	}
	return format === "anthropic-messages" && lower === "x-api-key"
}

const hasActiveHeader = (
	headers: ProviderHeaders | undefined,
	lowerHeaderName: string,
): boolean => {
	if (headers === undefined) {
		return false
	}
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === lowerHeaderName) {
			return typeof value === "string" && value.length > 0
		}
	}
	return false
}

const buildProviderAuth = (spec: ProviderSpec, config: ProviderRuntimeConfig): ProviderAuth => {
	const authSpec = spec.auth
	switch (authSpec.kind) {
		case "none":
			return {
				apiKey: {
					name: spec.name,
					login: () =>
						Promise.reject(new Error(`Interactive login is not supported for ${spec.name}.`)),
					resolve: async ({ ctx, credential, signal }) => {
						signal.throwIfAborted()
						const extraHeaders = await resolveSecretHeaders(spec, config, ctx, credential, signal)
						if (spec.secretHeaders !== undefined && extraHeaders === undefined) {
							return undefined
						}
						const headers = composeAuthHeaders(["Authorization", "x-api-key"], extraHeaders)
						return {
							auth: {
								apiKey: PLACEHOLDER_SDK_API_KEY,
								...(headers === undefined ? {} : { headers }),
							},
							source: spec.id,
						}
					},
				},
			}
		case "bearer":
			return {
				apiKey: {
					name: authSpec.label,
					login: () =>
						Promise.reject(new Error(`Interactive login is not supported for ${authSpec.label}.`)),
					resolve: async ({ ctx, credential, signal }) => {
						signal.throwIfAborted()
						const resolvedKey = await resolveAuthEnvValue(
							authSpec.env,
							config,
							ctx,
							credential,
							signal,
							{ isApiKey: true },
						)
						if (resolvedKey === undefined) {
							return undefined
						}
						const extraHeaders = await resolveSecretHeaders(spec, config, ctx, credential, signal)
						if (spec.secretHeaders !== undefined && extraHeaders === undefined) {
							return undefined
						}
						const apiKey = resolvedKey.value
						const source = resolvedKey.fromExplicitCredential ? "explicit credential" : authSpec.env
						if (spec.source === "custom") {
							const headers = composeAuthHeaders(["x-api-key"], extraHeaders, [
								["Authorization", `Bearer ${apiKey}`],
							])
							return {
								auth: headers === undefined ? {} : { headers },
								source,
							}
						}
						const headers = composeAuthHeaders([], extraHeaders)
						return {
							auth: {
								apiKey,
								...(headers === undefined ? {} : { headers }),
							},
							source,
						}
					},
				},
			}
		case "api_key_header":
			return {
				apiKey: {
					name: authSpec.label,
					login: () =>
						Promise.reject(new Error(`Interactive login is not supported for ${authSpec.label}.`)),
					resolve: async ({ ctx, credential, signal }) => {
						signal.throwIfAborted()
						const resolvedKey = await resolveAuthEnvValue(
							authSpec.env,
							config,
							ctx,
							credential,
							signal,
							{ isApiKey: true },
						)
						if (resolvedKey === undefined) {
							return undefined
						}
						const extraHeaders = await resolveSecretHeaders(spec, config, ctx, credential, signal)
						if (spec.secretHeaders !== undefined && extraHeaders === undefined) {
							return undefined
						}
						const apiKey = resolvedKey.value
						const source = resolvedKey.fromExplicitCredential ? "explicit credential" : authSpec.env
						const isBuiltinAnthropicDefault =
							spec.source === "builtin" &&
							spec.defaultFormat === "anthropic-messages" &&
							authSpec.header.toLowerCase() === "x-api-key"
						if (isBuiltinAnthropicDefault) {
							const headers = composeAuthHeaders([], extraHeaders)
							return {
								auth: {
									apiKey,
									...(headers === undefined ? {} : { headers }),
								},
								source,
							}
						}
						const headers = composeAuthHeaders(["Authorization", "x-api-key"], extraHeaders, [
							[authSpec.header, apiKey],
						])
						const needsPlaceholderKey = !codecAcceptsHeaderOnlyAuth(
							spec.defaultFormat,
							authSpec.header,
						)
						return {
							auth: {
								...(needsPlaceholderKey ? { apiKey: PLACEHOLDER_SDK_API_KEY } : {}),
								...(headers === undefined ? {} : { headers }),
							},
							source,
						}
					},
				},
			}
	}
}

const buildSynthesizedModel = (
	format: WireFormat,
	common: {
		readonly id: string
		readonly name: string
		readonly provider: string
		readonly baseUrl: string
		readonly reasoning: boolean
		readonly input: Array<"text" | "image">
		readonly contextWindow: number
		readonly maxTokens: number
		readonly thinkingLevelMap?: NonNullable<Model<WireFormat>["thinkingLevelMap"]>
	},
	defaults: ProviderModelDefaults,
): Model<WireFormat> => {
	const base = {
		...common,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}
	switch (format) {
		case "anthropic-messages":
			return {
				...base,
				api: "anthropic-messages",
				...(defaults.anthropicMessagesCompat === undefined
					? {}
					: { compat: defaults.anthropicMessagesCompat }),
			}
		case "openai-responses":
			return {
				...base,
				api: "openai-responses",
				...(defaults.openAIResponsesCompat === undefined
					? {}
					: { compat: defaults.openAIResponsesCompat }),
			}
		case "openai-completions":
			return {
				...base,
				api: "openai-completions",
				...(defaults.openAICompletionsCompat === undefined
					? {}
					: { compat: defaults.openAICompletionsCompat }),
			}
	}
}

export const synthesizeProviderModel = (
	spec: ProviderSpec,
	modelId: string,
	config: ProviderRuntimeConfig,
): Model<WireFormat> | undefined => {
	assertValidProviderSpec(spec)
	const baseUrl = resolveProviderBaseUrl(spec, config)
	const minContextWindow = config.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW
	const plan = resolveProviderModelPlan(spec, modelId, minContextWindow)
	if (plan === undefined) {
		return undefined
	}
	if (plan.kind === "primary") {
		if (!isWireFormatModel(plan.model)) {
			return undefined
		}
		if (plan.wireModelId === plan.model.id && baseUrl === plan.model.baseUrl) {
			return plan.model
		}
		return {
			...plan.model,
			id: plan.wireModelId,
			name: plan.wireModelId === plan.model.id ? plan.model.name : plan.wireModelId,
			baseUrl,
		}
	}
	const maxTokens = Math.min(
		plan.defaults.maxTokens ?? DEFAULT_SYNTHESIZED_MAX_TOKENS,
		plan.contextWindow,
	)
	const reasoning = plan.defaults.reasoning ?? false
	const thinkingLevelMap = plan.defaults.thinkingLevelMap ?? (reasoning ? { off: null } : undefined)
	const input: Array<"text" | "image"> =
		plan.defaults.input === undefined ? ["text", "image"] : [...plan.defaults.input]
	return buildSynthesizedModel(
		plan.format,
		{
			id: plan.wireModelId,
			name: plan.wireModelId,
			provider: spec.id,
			baseUrl,
			reasoning,
			input,
			contextWindow: plan.contextWindow,
			maxTokens,
			...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
		},
		plan.defaults,
	)
}

const wrapCustomAuthStreams = (
	streams: ProviderStreams,
	spec: ProviderSpec,
	format: WireFormat,
): ProviderStreams => {
	if (
		spec.source !== "custom" ||
		(spec.auth.kind !== "bearer" && spec.auth.kind !== "api_key_header")
	) {
		return streams
	}
	const configuredHeader =
		spec.auth.kind === "bearer" ? "authorization" : spec.auth.header.toLowerCase()
	const needsPlaceholderKey = !codecAcceptsHeaderOnlyAuth(format, configuredHeader)
	const sanitizeOptions = <
		TOptions extends { readonly apiKey?: string; readonly headers?: ProviderHeaders },
	>(
		options: TOptions | undefined,
	): (Omit<TOptions, "apiKey"> & { readonly apiKey?: string }) | undefined => {
		if (options === undefined || !hasActiveHeader(options.headers, configuredHeader)) {
			return options
		}
		if (needsPlaceholderKey) {
			return { ...options, apiKey: PLACEHOLDER_SDK_API_KEY }
		}
		const { apiKey: _stripped, ...rest } = options
		return rest
	}
	return {
		stream: (model, context, options) => streams.stream(model, context, sanitizeOptions(options)),
		streamSimple: (model, context, options) =>
			streams.streamSimple(model, context, sanitizeOptions(options)),
	}
}

const createLazyModelsLoader = (
	spec: ProviderSpec,
	resolvedBaseUrl: string,
	config: ProviderRuntimeConfig,
): (() => ReadonlyArray<Model<WireFormat>>) => {
	const minContextWindow = config.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW
	const canonicalBuiltin = BUILTIN_CANONICAL_SPECS.get(spec.id)
	const canonicalBaseUrl =
		canonicalBuiltin?.baseUrl === undefined
			? undefined
			: parsePinnedProviderBaseUrl(canonicalBuiltin.baseUrl, `provider "${spec.id}" baseUrl`)
					.baseUrl
	const canShareCatalog =
		spec.source === "builtin" &&
		STATIC_MODEL_CATALOGS.has(spec.id) &&
		spec.models === undefined &&
		canonicalBuiltin !== undefined &&
		canonicalBaseUrl !== undefined &&
		resolvedBaseUrl === canonicalBaseUrl &&
		formatsEqual(spec.formats, canonicalBuiltin.formats)
	let localCache: ReadonlyArray<Model<WireFormat>> | undefined
	return () => {
		if (canShareCatalog) {
			const cacheKey = `${spec.id}:${minContextWindow}`
			let cached = SHARED_BUILTIN_CATALOG_CACHE.get(cacheKey)
			if (cached === undefined) {
				cached = staticModelsForProvider(spec, resolvedBaseUrl, config)
				SHARED_BUILTIN_CATALOG_CACHE.set(cacheKey, cached)
			}
			return cached
		}
		localCache ??= staticModelsForProvider(spec, resolvedBaseUrl, config)
		return localCache
	}
}

const providerWireOptions = (
	spec: ProviderSpec,
	format: WireFormat,
	resolvedBaseUrl: string,
): WireFormatOptions => {
	const pinned = parsePinnedProviderBaseUrl(resolvedBaseUrl, `provider "${spec.id}" baseUrl`)
	const isCanonicalVendorEndpoint =
		format === "anthropic-messages"
			? spec.id === "anthropic" && pinned.origin === CANONICAL_ANTHROPIC_ORIGIN
			: spec.id === "openai" && pinned.origin === CANONICAL_OPENAI_ORIGIN
	return {
		allowedOrigins: [pinned.origin],
		expectedBaseUrl: pinned.baseUrl,
		isolateSdkEnvHeaders: !isCanonicalVendorEndpoint,
	}
}

interface BuiltProviderMetadata {
	readonly spec: ProviderSpec
	readonly config: ProviderRuntimeConfig
	readonly resolvedBaseUrl: string
}

const BUILT_PROVIDER_METADATA = new WeakMap<Provider<Api>, BuiltProviderMetadata>()

const resolveEffectiveContextFloor = (
	registryFloor: number,
	providerConfig: ProviderRuntimeConfig,
): number =>
	providerConfig.minContextWindow === undefined
		? registryFloor
		: Math.max(registryFloor, providerConfig.minContextWindow)

const bindProviderToRegistryFloor = (
	provider: Provider<Api>,
	registryFloor: number,
): Provider<Api> => {
	const meta = BUILT_PROVIDER_METADATA.get(provider)
	if (meta === undefined) {
		return provider
	}
	const effectiveFloor = resolveEffectiveContextFloor(registryFloor, meta.config)
	const standaloneFloor = meta.config.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW
	if (effectiveFloor === standaloneFloor) {
		return provider
	}
	const effectiveConfig: ProviderRuntimeConfig = {
		...meta.config,
		minContextWindow: effectiveFloor,
	}
	const getModels = createLazyModelsLoader(meta.spec, meta.resolvedBaseUrl, effectiveConfig)
	const bound: Provider<Api> = {
		...provider,
		getModels,
		getAllModels: getModels,
	}
	BUILT_PROVIDER_METADATA.set(bound, {
		spec: meta.spec,
		config: effectiveConfig,
		resolvedBaseUrl: meta.resolvedBaseUrl,
	})
	return bound
}

export const buildPiProvider = (
	spec: ProviderSpec,
	config: ProviderRuntimeConfig,
): Provider<WireFormat> => {
	assertValidProviderSpec(spec)
	const resolvedBaseUrl = resolveProviderBaseUrl(spec, config)
	const apiMap: Partial<Record<WireFormat, ProviderStreams>> = {}
	for (const format of spec.formats) {
		const wireOptions = providerWireOptions(spec, format, resolvedBaseUrl)
		apiMap[format] = wrapCustomAuthStreams(
			createWireFormatStreams(format, wireOptions),
			spec,
			format,
		)
	}
	const provider = createProvider<WireFormat>({
		id: spec.id,
		name: spec.name,
		baseUrl: resolvedBaseUrl,
		...(spec.headers === undefined ? {} : { headers: { ...spec.headers } }),
		auth: buildProviderAuth(spec, config),
		models: [],
		api: apiMap,
	})
	const getModels = createLazyModelsLoader(spec, resolvedBaseUrl, config)
	const compiled: Provider<WireFormat> = {
		...provider,
		getModels,
		getAllModels: getModels,
	}
	BUILT_PROVIDER_METADATA.set(compiled, { spec, config, resolvedBaseUrl })
	return compiled
}

export const withDynamicModelLookup = (
	base: MutableModels,
	config: ProviderRuntimeConfig,
): MutableModels => {
	const minContextWindow = config.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW
	for (const provider of base.getProviders()) {
		const bound = bindProviderToRegistryFloor(provider, minContextWindow)
		if (bound !== provider) {
			base.setProvider(bound)
		}
	}
	const isEligibleChatModel = (model: Model<Api>): boolean =>
		model.contextWindow >= minContextWindow
	const isEligibleAnyModel = (model: AnyModel): boolean =>
		!isModelType(model, "chat") || model.contextWindow >= minContextWindow

	const resolveChatModel = (providerId: string, id: string): Model<Api> | undefined => {
		const registered = base.getProvider(providerId)
		if (registered === undefined) {
			return undefined
		}
		const meta = BUILT_PROVIDER_METADATA.get(registered)
		if (meta !== undefined) {
			const effectiveFloor = resolveEffectiveContextFloor(minContextWindow, meta.config)
			return synthesizeProviderModel(meta.spec, id, {
				...meta.config,
				minContextWindow: effectiveFloor,
			})
		}
		const cataloged = base.getModel(providerId, id)
		return cataloged !== undefined && isEligibleChatModel(cataloged) ? cataloged : undefined
	}
	function getModelsOfType<TType extends ModelType>(
		type: TType,
		provider?: string,
	): ReadonlyArray<ModelTypeMap[TType]>
	function getModelsOfType(
		type: ModelType,
		provider?: string,
	): ReadonlyArray<ModelTypeMap[ModelType]> {
		if (type === "chat") {
			return base.getModelsOfType("chat", provider).filter(isEligibleChatModel)
		}
		return base.getModelsOfType(type, provider)
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
		if (type === "chat") {
			return resolveChatModel(providerId, id)
		}
		return base.getModelOfType(type, providerId, id)
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
		if (type === "chat") {
			return (await base.getAvailableOfType("chat", providerId, options)).filter(
				isEligibleChatModel,
			)
		}
		return base.getAvailableOfType(type, providerId, options)
	}
	return {
		getProviders: () => base.getProviders(),
		getProvider: (id) => base.getProvider(id),
		getModels: (provider) => base.getModels(provider).filter(isEligibleChatModel),
		getAllModels: (provider) => base.getAllModels(provider).filter(isEligibleAnyModel),
		getModelsOfType,
		getModel: (providerId, id) => resolveChatModel(providerId, id),
		getModelOfType,
		refresh: (options) => base.refresh(options),
		checkAuth: (providerId, options) => base.checkAuth(providerId, options),
		getAvailable: async (providerId, options) =>
			(await base.getAvailable(providerId, options)).filter(isEligibleChatModel),
		getAvailableOfType,
		getAllAvailable: async (providerId, options) =>
			(await base.getAllAvailable(providerId, options)).filter(isEligibleAnyModel),
		getAuth: base.getAuth.bind(base),
		login: (providerId, type, interaction, options) =>
			base.login(providerId, type, interaction, options),
		logout: (providerId, options) => base.logout(providerId, options),
		stream: (model, context, options) => base.stream(model, context, options),
		complete: (model, context, options) => base.complete(model, context, options),
		streamSimple: (model, context, options) => base.streamSimple(model, context, options),
		completeSimple: (model, context, options) => base.completeSimple(model, context, options),
		streamDeferred: (model, handle, options) => base.streamDeferred(model, handle, options),
		fetchDeferred: (model, handle, options) => base.fetchDeferred(model, handle, options),
		cancelDeferred: (model, handle, options) => base.cancelDeferred(model, handle, options),
		generateImages: (model, context, options) => base.generateImages(model, context, options),
		classify: (model, context, options) => base.classify(model, context, options),
		setProvider: (provider) => {
			base.setProvider(bindProviderToRegistryFloor(provider, minContextWindow))
		},
		deleteProvider: (id) => base.deleteProvider(id),
		clearProviders: () => {
			base.clearProviders()
		},
	}
}

export const createProviderModels = (config: ProviderRuntimeConfig): MutableModels => {
	const providers = allProviders(config.customProviders)
	const models = createModels({ authContext: EMPTY_AUTH_CONTEXT })
	for (const spec of providers) {
		models.setProvider(buildPiProvider(spec, config))
	}
	return withDynamicModelLookup(models, config)
}
