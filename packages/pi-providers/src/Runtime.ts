import type {
	AnthropicMessagesCompat,
	AnyModel,
	Api,
	Model,
	ModelType,
	ModelTypeMap,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	Provider,
	ProviderAuth,
	ProviderHeaders,
	ProviderStreams,
} from "@earendil-works/pi-ai"
import { CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL } from "@earendil-works/pi-ai/api/cloudflare-ai-binding"
import { createModels, createProvider, hasApi, isModelType } from "@earendil-works/pi-ai/models"
import type { MutableModels } from "@earendil-works/pi-ai/models"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import {
	ZERO_COST,
	getIndexedOpenAICompletionsCompat,
	hydrateIndexedModel,
} from "./CatalogCapabilities.ts"
import {
	getCloudflareAiGatewayCatalogIndex,
	getCloudflareWorkersAiCatalogIndex,
	getOpenRouterCatalogIndex,
} from "./CatalogIndex.ts"
import { parseLoopbackBaseUrl, parsePinnedProviderBaseUrl } from "./Fetch.ts"
import { resolveProviderModelPlan, stripVariantSuffix } from "./ModelResolution.ts"
import type { ModelRoute, ResolvedProviderModelPlan } from "./ModelResolution.ts"
import {
	BUILTIN_PROVIDERS,
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_CLOUDFLARE_AI_GATEWAY_BINDING_ROOT,
	DEFAULT_CLOUDFLARE_AI_GATEWAY_HTTPS_ROOT,
	DEFAULT_CLOUDFLARE_WORKERS_AI_BASE_ROOT,
	DEFAULT_OPENAI_BASE_URL,
	DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL,
	DEFAULT_OPENROUTER_BASE_URL,
	allProviders,
	assertValidProviderSpec,
	resolveCloudflareGatewayAuthMode,
} from "./Providers.ts"
import { DEFAULT_MIN_CONTEXT_WINDOW, DEFAULT_SYNTHESIZED_MAX_TOKENS, ownProperty } from "./Types.ts"
import type { ProviderAuthSpec, ProviderRuntimeConfig, ProviderSpec, WireFormat } from "./Types.ts"
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

const ANTHROPIC_WIRE_MODELS = filterWireModels(ANTHROPIC_MODELS)
const OPENAI_WIRE_MODELS = filterWireModels(OPENAI_MODELS)

const STATIC_PRIMARY_CATALOGS = new Map<string, ReadonlyArray<Model<WireFormat>>>([
	["openai", OPENAI_WIRE_MODELS],
	["anthropic", ANTHROPIC_WIRE_MODELS],
])

const SHARED_BUILTIN_CATALOG_IDS = new Set(["openai", "anthropic", "openrouter"])
const SHARED_BUILTIN_CATALOG_CACHE = new Map<string, ReadonlyArray<Model<WireFormat>>>()

const BUILTIN_CANONICAL_SPECS = new Map<string, ProviderSpec>(
	BUILTIN_PROVIDERS.map((provider) => [provider.id, provider]),
)
const CANONICAL_OPENAI_ORIGIN = new URL(DEFAULT_OPENAI_BASE_URL).origin
const CANONICAL_ANTHROPIC_ORIGIN = new URL(DEFAULT_ANTHROPIC_BASE_URL).origin

const formatsEqual = (left: ReadonlyArray<WireFormat>, right: ReadonlyArray<WireFormat>): boolean =>
	left.length === right.length && left.every((format, index) => format === right[index])

const GATEWAY_COMPAT_DEFAULTS: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsLongCacheRetention: false,
	sendSessionAffinityHeaders: true,
}

/**
 * Applies Cloudflare AI Gateway `/compat` request overrides while preserving
 * downstream model-intrinsic conversation/replay requirements (such as
 * `requiresReasoningContentOnAssistantMessages` on DeepSeek models).
 */
const mergeGatewayCompat = (
	baseCompat: OpenAICompletionsCompat | undefined,
): OpenAICompletionsCompat => {
	if (baseCompat === undefined) {
		return GATEWAY_COMPAT_DEFAULTS
	}
	const {
		cacheControlFormat: _dropCacheControl,
		openRouterRouting: _dropOpenRouterRouting,
		sessionAffinityFormat: _dropSessionAffinity,
		thinkingFormat,
		...preservedModelCompat
	} = baseCompat
	return {
		...preservedModelCompat,
		...(thinkingFormat !== undefined && thinkingFormat !== "openrouter" ? { thinkingFormat } : {}),
		...GATEWAY_COMPAT_DEFAULTS,
	}
}

const WORKERS_AI_COMPAT_DEFAULTS: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsStrictMode: true,
	supportsLongCacheRetention: false,
	sendSessionAffinityHeaders: true,
}

const openRouterCompletionsCompat = (modelId: string): OpenAICompletionsCompat => {
	const baseId = stripVariantSuffix(modelId)
	return {
		thinkingFormat: "openrouter",
		supportsStrictMode: true,
		sendSessionAffinityHeaders: true,
		...(baseId.startsWith("anthropic/") ? { cacheControlFormat: "anthropic" } : {}),
	}
}

const trimmedEnv = (
	env: Readonly<Record<string, string | undefined>> | undefined,
	name: string,
): string | undefined => {
	const value = ownProperty(env, name)?.trim()
	return value !== undefined && value.length > 0 ? value : undefined
}

const resolveBaseUrlOverride = (
	spec: ProviderSpec,
	config: ProviderRuntimeConfig,
): string | undefined => {
	const override = ownProperty(config.baseUrlOverrides, spec.id)
	return override !== undefined && override !== null
		? parseLoopbackBaseUrl(override, `${spec.id} base URL`)
		: undefined
}

interface CloudflareGatewayTransport {
	readonly mode: "override" | "https" | "binding" | "placeholder"
	readonly root: string
}

const resolveCloudflareGatewayTransport = (
	spec: ProviderSpec,
	config: ProviderRuntimeConfig,
): CloudflareGatewayTransport => {
	const override = resolveBaseUrlOverride(spec, config)
	if (override !== undefined) {
		return { mode: "override", root: override }
	}
	if (spec.auth.kind !== "cloudflare_ai_gateway") {
		return {
			mode: "placeholder",
			root: `${DEFAULT_CLOUDFLARE_AI_GATEWAY_HTTPS_ROOT}/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}`,
		}
	}
	const apiKey = trimmedEnv(config.env, spec.auth.apiKeyEnv)
	const accountId = trimmedEnv(config.env, spec.auth.accountIdEnv)
	const gatewayId = trimmedEnv(config.env, spec.auth.gatewayIdEnv)
	const gatewayAuth = resolveCloudflareGatewayAuthMode({
		hasGatewayId: gatewayId !== undefined,
		hasAccountId: accountId !== undefined,
		hasApiKey: apiKey !== undefined,
		hasBinding: typeof config.aiBinding?.fetch === "function",
		gatewayIdEnv: spec.auth.gatewayIdEnv,
		accountIdEnv: spec.auth.accountIdEnv,
		apiKeyEnv: spec.auth.apiKeyEnv,
	})
	if (gatewayAuth.mode === "https" && accountId !== undefined && gatewayId !== undefined) {
		return {
			mode: "https",
			root: `${DEFAULT_CLOUDFLARE_AI_GATEWAY_HTTPS_ROOT}/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}`,
		}
	}
	if (gatewayAuth.mode === "binding" && gatewayId !== undefined) {
		return {
			mode: "binding",
			root: `${DEFAULT_CLOUDFLARE_AI_GATEWAY_BINDING_ROOT}/${encodeURIComponent(gatewayId)}`,
		}
	}
	return {
		mode: "placeholder",
		root: `${DEFAULT_CLOUDFLARE_AI_GATEWAY_HTTPS_ROOT}/${accountId === undefined ? "{CLOUDFLARE_ACCOUNT_ID}" : encodeURIComponent(accountId)}/${gatewayId === undefined ? "{CLOUDFLARE_GATEWAY_ID}" : encodeURIComponent(gatewayId)}`,
	}
}

const resolveCloudflareWorkersAiBaseUrl = (
	spec: ProviderSpec,
	config: ProviderRuntimeConfig,
): string => {
	const override = resolveBaseUrlOverride(spec, config)
	if (override !== undefined) {
		return override
	}
	const accountId =
		spec.auth.kind === "cloudflare_workers_ai"
			? trimmedEnv(config.env, spec.auth.accountIdEnv)
			: undefined
	return `${DEFAULT_CLOUDFLARE_WORKERS_AI_BASE_ROOT}/${accountId === undefined ? "{CLOUDFLARE_ACCOUNT_ID}" : encodeURIComponent(accountId)}/ai/v1`
}

const gatewaySuffixForFormat = (format: WireFormat): "/anthropic" | "/openai" | "/compat" => {
	switch (format) {
		case "anthropic-messages":
			return "/anthropic"
		case "openai-responses":
			return "/openai"
		case "openai-completions":
			return "/compat"
	}
}

const resolveProviderBaseUrl = (spec: ProviderSpec, config: ProviderRuntimeConfig): string => {
	if (spec.auth.kind === "cloudflare_ai_gateway") {
		return `${resolveCloudflareGatewayTransport(spec, config).root}${gatewaySuffixForFormat(spec.defaultFormat)}`
	}
	if (spec.auth.kind === "cloudflare_workers_ai") {
		return resolveCloudflareWorkersAiBaseUrl(spec, config)
	}
	const override = resolveBaseUrlOverride(spec, config)
	if (override !== undefined) {
		return override
	}
	return parsePinnedProviderBaseUrl(spec.baseUrl, `provider "${spec.id}" baseUrl`).baseUrl
}

const resolveRouteBaseUrl = (
	spec: ProviderSpec,
	route: ModelRoute,
	config: ProviderRuntimeConfig,
): string => {
	switch (route) {
		case "openrouter-anthropic": {
			const effective =
				resolveBaseUrlOverride(spec, config) ??
				parsePinnedProviderBaseUrl(
					spec.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
					`provider "${spec.id}" baseUrl`,
				).baseUrl
			return effective === DEFAULT_OPENROUTER_BASE_URL
				? DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL
				: effective.replace(/\/v1$/, "")
		}
		case "openrouter-completions":
			return (
				resolveBaseUrlOverride(spec, config) ??
				parsePinnedProviderBaseUrl(
					spec.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
					`provider "${spec.id}" baseUrl`,
				).baseUrl
			)
		case "gateway-anthropic":
			return `${resolveCloudflareGatewayTransport(spec, config).root}/anthropic`
		case "gateway-openai":
			return `${resolveCloudflareGatewayTransport(spec, config).root}/openai`
		case "gateway-compat":
			return `${resolveCloudflareGatewayTransport(spec, config).root}/compat`
		case "workers-ai":
			return resolveCloudflareWorkersAiBaseUrl(spec, config)
		case "default":
			return resolveProviderBaseUrl(spec, config)
	}
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
	const pushUnique = (model: Model<WireFormat>) => {
		if (!seen.has(model.id)) {
			seen.add(model.id)
			models.push(model)
		}
	}

	if (spec.id === "openrouter") {
		const anthropicBaseUrl = resolveRouteBaseUrl(spec, "openrouter-anthropic", config)
		const completionsBaseUrl = resolveRouteBaseUrl(spec, "openrouter-completions", config)
		for (const entry of getOpenRouterCatalogIndex().values()) {
			if (entry.contextWindow < minContextWindow || !spec.formats.includes(entry.api)) {
				continue
			}
			pushUnique(
				hydrateIndexedModel(entry, {
					provider: spec.id,
					baseUrl: entry.api === "anthropic-messages" ? anthropicBaseUrl : completionsBaseUrl,
				}),
			)
		}
	} else if (spec.id === "cloudflare-ai-gateway") {
		const transportRoot = resolveCloudflareGatewayTransport(spec, config).root
		for (const entry of getCloudflareAiGatewayCatalogIndex().values()) {
			if (entry.contextWindow < minContextWindow || !spec.formats.includes(entry.api)) {
				continue
			}
			const baseUrl =
				entry.api === "anthropic-messages"
					? `${transportRoot}/anthropic`
					: entry.api === "openai-responses"
						? `${transportRoot}/openai`
						: `${transportRoot}/compat`
			pushUnique(hydrateIndexedModel(entry, { provider: spec.id, baseUrl }))
		}
	} else if (spec.id === "cloudflare-workers-ai") {
		for (const entry of getCloudflareWorkersAiCatalogIndex().values()) {
			if (entry.contextWindow < minContextWindow || !spec.formats.includes(entry.api)) {
				continue
			}
			pushUnique(hydrateIndexedModel(entry, { provider: spec.id, baseUrl: resolvedBaseUrl }))
		}
	} else {
		const catalog = STATIC_PRIMARY_CATALOGS.get(spec.id)
		if (catalog !== undefined) {
			for (const model of catalog) {
				if (model.contextWindow < minContextWindow || !spec.formats.includes(model.api)) {
					continue
				}
				pushUnique(
					model.baseUrl === resolvedBaseUrl ? model : { ...model, baseUrl: resolvedBaseUrl },
				)
			}
		}
	}

	for (const declaredId of declaredProviderModelIds(spec)) {
		if (seen.has(declaredId)) {
			continue
		}
		const synthesized = synthesizeProviderModel(spec, declaredId, config)
		if (synthesized !== undefined) {
			pushUnique(synthesized)
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

const getActiveHeader = (
	headers: ProviderHeaders | undefined,
	lowerHeaderName: string,
): string | undefined => {
	if (headers === undefined) {
		return undefined
	}
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === lowerHeaderName) {
			return typeof value === "string" && value.length > 0 ? value : undefined
		}
	}
	return undefined
}

const hasActiveHeader = (headers: ProviderHeaders | undefined, lowerHeaderName: string): boolean =>
	getActiveHeader(headers, lowerHeaderName) !== undefined

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
		case "cloudflare_ai_gateway":
			return {
				apiKey: {
					name: "Cloudflare AI Gateway",
					login: () =>
						Promise.reject(
							new Error("Interactive login is not supported for Cloudflare AI Gateway."),
						),
					resolve: async ({ ctx, credential, signal }) => {
						signal.throwIfAborted()
						const gatewayId = (
							await resolveAuthEnvValue(authSpec.gatewayIdEnv, config, ctx, credential, signal, {
								trim: true,
							})
						)?.value
						if (gatewayId === undefined) {
							return undefined
						}
						const resolvedKey = await resolveAuthEnvValue(
							authSpec.apiKeyEnv,
							config,
							ctx,
							credential,
							signal,
							{ isApiKey: true, trim: true },
						)
						const accountId = (
							await resolveAuthEnvValue(authSpec.accountIdEnv, config, ctx, credential, signal, {
								trim: true,
							})
						)?.value
						const gatewayAuth = resolveCloudflareGatewayAuthMode({
							hasGatewayId: gatewayId !== undefined,
							hasAccountId: accountId !== undefined,
							hasApiKey: resolvedKey !== undefined,
							hasBinding: typeof config.aiBinding?.fetch === "function",
							gatewayIdEnv: authSpec.gatewayIdEnv,
							accountIdEnv: authSpec.accountIdEnv,
							apiKeyEnv: authSpec.apiKeyEnv,
						})
						if (
							gatewayAuth.mode === "https" &&
							resolvedKey !== undefined &&
							accountId !== undefined
						) {
							const extraHeaders = await resolveSecretHeaders(spec, config, ctx, credential, signal)
							if (spec.secretHeaders !== undefined && extraHeaders === undefined) {
								return undefined
							}
							const headers = composeAuthHeaders(["Authorization", "x-api-key"], extraHeaders, [
								["cf-aig-authorization", `Bearer ${resolvedKey.value}`],
							])
							return {
								auth: headers === undefined ? {} : { headers },
								env: {
									[authSpec.accountIdEnv]: accountId,
									[authSpec.gatewayIdEnv]: gatewayId,
								},
								source: resolvedKey.fromExplicitCredential
									? "explicit credential"
									: authSpec.apiKeyEnv,
							}
						}
						if (gatewayAuth.mode === "binding") {
							const extraHeaders = await resolveSecretHeaders(spec, config, ctx, credential, signal)
							if (spec.secretHeaders !== undefined && extraHeaders === undefined) {
								return undefined
							}
							const headers = composeAuthHeaders(["Authorization", "x-api-key"], extraHeaders, [
								["cf-aig-authorization", `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`],
							])
							return {
								auth: headers === undefined ? {} : { headers },
								env: { [authSpec.gatewayIdEnv]: gatewayId },
								source: "cloudflare-ai-binding",
							}
						}
						return undefined
					},
				},
			}
		case "cloudflare_workers_ai":
			return {
				apiKey: {
					name: "Cloudflare Workers AI",
					login: () =>
						Promise.reject(
							new Error("Interactive login is not supported for Cloudflare Workers AI."),
						),
					resolve: async ({ ctx, credential, signal }) => {
						signal.throwIfAborted()
						const resolvedKey = await resolveAuthEnvValue(
							authSpec.apiKeyEnv,
							config,
							ctx,
							credential,
							signal,
							{ isApiKey: true, trim: true },
						)
						const accountId = (
							await resolveAuthEnvValue(authSpec.accountIdEnv, config, ctx, credential, signal, {
								trim: true,
							})
						)?.value
						if (resolvedKey === undefined || accountId === undefined) {
							return undefined
						}
						const extraHeaders = await resolveSecretHeaders(spec, config, ctx, credential, signal)
						if (spec.secretHeaders !== undefined && extraHeaders === undefined) {
							return undefined
						}
						const headers =
							extraHeaders === undefined
								? undefined
								: composeAuthHeaders([], extraHeaders, [
										["Authorization", `Bearer ${resolvedKey.value}`],
									])
						return {
							auth: {
								apiKey: resolvedKey.value,
								...(headers === undefined ? {} : { headers }),
							},
							env: { [authSpec.accountIdEnv]: accountId },
							source: resolvedKey.fromExplicitCredential
								? "explicit credential"
								: authSpec.apiKeyEnv,
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
		readonly cost?: Model<WireFormat>["cost"]
		readonly thinkingLevelMap?: NonNullable<Model<WireFormat>["thinkingLevelMap"]>
		readonly inputLimits?: NonNullable<Model<WireFormat>["inputLimits"]>
	},
	compat?: {
		readonly anthropic?: AnthropicMessagesCompat
		readonly openaiResponses?: OpenAIResponsesCompat
		readonly openaiCompletions?: OpenAICompletionsCompat
	},
): Model<WireFormat> => {
	const base = {
		...common,
		cost: common.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}
	switch (format) {
		case "anthropic-messages":
			return {
				...base,
				api: "anthropic-messages",
				...(compat?.anthropic === undefined ? {} : { compat: compat.anthropic }),
			}
		case "openai-responses":
			return {
				...base,
				api: "openai-responses",
				...(compat?.openaiResponses === undefined ? {} : { compat: compat.openaiResponses }),
			}
		case "openai-completions":
			return {
				...base,
				api: "openai-completions",
				...(compat?.openaiCompletions === undefined ? {} : { compat: compat.openaiCompletions }),
			}
	}
}

const sanitizeProxyAnthropicCompat = (
	compat: AnthropicMessagesCompat | undefined,
	route: "openrouter-anthropic" | "gateway-anthropic",
): AnthropicMessagesCompat | undefined => {
	// Never propagate direct-Anthropic-only endpoint betas (such as mid-convo tool changes,
	// mid-convo system messages, strict tools, or direct fallback models) onto proxy routes.
	const next: AnthropicMessagesCompat = {
		...(route === "gateway-anthropic" ? { sendSessionAffinityHeaders: true } : {}),
		...(compat?.forceAdaptiveThinking === undefined
			? {}
			: { forceAdaptiveThinking: compat.forceAdaptiveThinking }),
		...(compat?.supportsTemperature === undefined
			? {}
			: { supportsTemperature: compat.supportsTemperature }),
		...(route === "openrouter-anthropic" && compat?.supportsMidConvoEffort !== undefined
			? { supportsMidConvoEffort: compat.supportsMidConvoEffort }
			: {}),
	}
	return Object.keys(next).length > 0 ? next : undefined
}

const sanitizeGatewayOpenAIResponsesCompat = (
	compat: OpenAIResponsesCompat | undefined,
): OpenAIResponsesCompat => ({
	supportsStrictMode: true,
	...(compat?.supportsOpenAIGrammarTools === undefined
		? {}
		: { supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools }),
})

const materializeModelPlan = (
	spec: ProviderSpec,
	plan: ResolvedProviderModelPlan,
	baseUrl: string,
): Model<WireFormat> | undefined => {
	if (plan.kind === "indexed") {
		const freeCostOverride = plan.isFreeVariant === true ? { costOverride: ZERO_COST } : {}
		if (plan.route === "openrouter-completions") {
			const needsOpenRouterCompat =
				plan.isVariantFallback === true && plan.entry.api !== "openai-completions"
			return hydrateIndexedModel(plan.entry, {
				provider: spec.id,
				id: plan.wireModelId,
				baseUrl,
				formatOverride: "openai-completions",
				...freeCostOverride,
				...(needsOpenRouterCompat
					? { openAICompletionsCompatOverride: openRouterCompletionsCompat(plan.wireModelId) }
					: {}),
			})
		}
		if (plan.route === "gateway-compat") {
			// Direct Gateway catalog hits (plan.entry.id === plan.wireModelId) already carry
			// exact Gateway compat; delegated Workers AI / OpenRouter entries on Gateway /compat
			// overlay Gateway's request settings while preserving model replay requirements.
			const useGatewayCompatDefaults = plan.entry.id !== plan.wireModelId
			const baseCompat =
				plan.entry.api === "openai-completions"
					? getIndexedOpenAICompletionsCompat(plan.entry.compatIndex)
					: undefined
			return hydrateIndexedModel(plan.entry, {
				provider: spec.id,
				id: plan.wireModelId,
				baseUrl,
				formatOverride: "openai-completions",
				...freeCostOverride,
				...(useGatewayCompatDefaults
					? { openAICompletionsCompatOverride: mergeGatewayCompat(baseCompat) }
					: {}),
			})
		}
		return hydrateIndexedModel(plan.entry, {
			provider: spec.id,
			id: plan.wireModelId,
			baseUrl,
			formatOverride: plan.format,
			...freeCostOverride,
		})
	}

	if (plan.kind === "primary") {
		const primary = plan.model
		if (plan.route === "default") {
			if (!isWireFormatModel(primary)) {
				return undefined
			}
			if (plan.wireModelId === primary.id && baseUrl === primary.baseUrl) {
				return primary
			}
			return {
				...primary,
				id: plan.wireModelId,
				name: plan.wireModelId === primary.id ? primary.name : plan.wireModelId,
				baseUrl,
			}
		}
		const targetFormat: WireFormat =
			plan.route === "openrouter-anthropic" || plan.route === "gateway-anthropic"
				? "anthropic-messages"
				: plan.route === "gateway-openai"
					? "openai-responses"
					: "openai-completions"
		const primaryAnthropicCompat = hasApi(primary, "anthropic-messages")
			? primary.compat
			: undefined
		const anthropicCompat: AnthropicMessagesCompat | undefined =
			plan.route === "openrouter-anthropic" || plan.route === "gateway-anthropic"
				? sanitizeProxyAnthropicCompat(primaryAnthropicCompat, plan.route)
				: undefined
		const primaryOpenAIResponsesCompat = hasApi(primary, "openai-responses")
			? primary.compat
			: undefined
		const openAIResponsesCompat: OpenAIResponsesCompat | undefined =
			plan.route === "gateway-openai"
				? sanitizeGatewayOpenAIResponsesCompat(primaryOpenAIResponsesCompat)
				: undefined
		const openAICompletionsCompat: OpenAICompletionsCompat | undefined =
			plan.route === "openrouter-completions"
				? openRouterCompletionsCompat(plan.wireModelId)
				: plan.route === "gateway-compat"
					? GATEWAY_COMPAT_DEFAULTS
					: undefined
		return buildSynthesizedModel(
			targetFormat,
			{
				id: plan.wireModelId,
				name: plan.wireModelId === primary.id ? primary.name : plan.wireModelId,
				provider: spec.id,
				baseUrl,
				reasoning: primary.reasoning,
				input: [...primary.input],
				contextWindow: primary.contextWindow,
				maxTokens: primary.maxTokens,
				cost: plan.isFreeVariant === true ? ZERO_COST : primary.cost,
				...(primary.thinkingLevelMap === undefined
					? {}
					: { thinkingLevelMap: primary.thinkingLevelMap }),
				...(primary.inputLimits === undefined ? {} : { inputLimits: primary.inputLimits }),
			},
			{
				...(anthropicCompat === undefined ? {} : { anthropic: anthropicCompat }),
				...(openAIResponsesCompat === undefined ? {} : { openaiResponses: openAIResponsesCompat }),
				...(openAICompletionsCompat === undefined
					? {}
					: { openaiCompletions: openAICompletionsCompat }),
			},
		)
	}

	const maxTokens = Math.min(
		plan.defaults.maxTokens ?? DEFAULT_SYNTHESIZED_MAX_TOKENS,
		plan.contextWindow,
	)
	const reasoning = plan.defaults.reasoning ?? false
	const thinkingLevelMap = plan.defaults.thinkingLevelMap ?? (reasoning ? { off: null } : undefined)
	const input: Array<"text" | "image"> =
		plan.defaults.input === undefined ? ["text", "image"] : [...plan.defaults.input]

	const anthropicCompat: AnthropicMessagesCompat | undefined =
		plan.route === "gateway-anthropic"
			? { sendSessionAffinityHeaders: true, ...plan.defaults.anthropicMessagesCompat }
			: plan.defaults.anthropicMessagesCompat
	const openAIResponsesCompat: OpenAIResponsesCompat | undefined =
		plan.route === "gateway-openai"
			? { supportsStrictMode: true, ...plan.defaults.openAIResponsesCompat }
			: plan.defaults.openAIResponsesCompat
	const openAICompletionsCompat: OpenAICompletionsCompat | undefined =
		plan.route === "openrouter-completions"
			? {
					...openRouterCompletionsCompat(plan.wireModelId),
					...plan.defaults.openAICompletionsCompat,
				}
			: plan.route === "gateway-compat"
				? { ...GATEWAY_COMPAT_DEFAULTS, ...plan.defaults.openAICompletionsCompat }
				: plan.route === "workers-ai"
					? { ...WORKERS_AI_COMPAT_DEFAULTS, ...plan.defaults.openAICompletionsCompat }
					: plan.defaults.openAICompletionsCompat

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
		{
			...(anthropicCompat === undefined ? {} : { anthropic: anthropicCompat }),
			...(openAIResponsesCompat === undefined ? {} : { openaiResponses: openAIResponsesCompat }),
			...(openAICompletionsCompat === undefined
				? {}
				: { openaiCompletions: openAICompletionsCompat }),
		},
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

const gatewayRouteSuffix = (model: Model<Api>): "/anthropic" | "/openai" | "/compat" => {
	if (model.baseUrl.endsWith("/anthropic") || model.api === "anthropic-messages") {
		return "/anthropic"
	}
	if (model.baseUrl.endsWith("/openai") || model.api === "openai-responses") {
		return "/openai"
	}
	return "/compat"
}

interface GatewayDispatchPlan {
	readonly model: Model<Api>
	readonly stripApiKey: boolean
	readonly fetchOverride?: typeof fetch
}

const resolveGatewayDispatch = (
	model: Model<Api>,
	spec: ProviderSpec,
	authSpec: Extract<ProviderAuthSpec, { readonly kind: "cloudflare_ai_gateway" }>,
	config: ProviderRuntimeConfig,
	options:
		| {
				readonly apiKey?: string
				readonly env?: Readonly<Record<string, string | undefined>>
				readonly headers?: ProviderHeaders
				readonly fetch?: typeof fetch
		  }
		| undefined,
): GatewayDispatchPlan => {
	const override = resolveBaseUrlOverride(spec, config)
	const suffix = gatewayRouteSuffix(model)
	const cfAuth = getActiveHeader(options?.headers, "cf-aig-authorization")
	const stripApiKey = cfAuth !== undefined && options?.apiKey !== undefined
	if (override !== undefined) {
		const baseUrl = `${override}${suffix}`
		return {
			model: model.baseUrl === baseUrl ? model : { ...model, baseUrl },
			stripApiKey,
		}
	}
	const isBindingAuth = cfAuth === `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`
	const gatewayId =
		trimmedEnv(options?.env, authSpec.gatewayIdEnv) ?? trimmedEnv(config.env, authSpec.gatewayIdEnv)
	const accountId =
		trimmedEnv(options?.env, authSpec.accountIdEnv) ?? trimmedEnv(config.env, authSpec.accountIdEnv)
	if (isBindingAuth && gatewayId !== undefined && typeof config.aiBinding?.fetch === "function") {
		const baseUrl = `${DEFAULT_CLOUDFLARE_AI_GATEWAY_BINDING_ROOT}/${encodeURIComponent(gatewayId)}${suffix}`
		const bindingFetch = config.aiBinding.fetch.bind(config.aiBinding)
		return {
			model: model.baseUrl === baseUrl ? model : { ...model, baseUrl },
			stripApiKey,
			...(options?.fetch === undefined
				? {
						fetchOverride: (
							input: Parameters<typeof fetch>[0],
							init?: Parameters<typeof fetch>[1],
						) => bindingFetch(input, init),
					}
				: {}),
		}
	}
	if (accountId !== undefined && gatewayId !== undefined) {
		const baseUrl = `${DEFAULT_CLOUDFLARE_AI_GATEWAY_HTTPS_ROOT}/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}${suffix}`
		return {
			model: model.baseUrl === baseUrl ? model : { ...model, baseUrl },
			stripApiKey,
		}
	}
	return { model, stripApiKey }
}

const wrapCloudflareStreams = (
	streams: ProviderStreams,
	spec: ProviderSpec,
	config: ProviderRuntimeConfig,
): ProviderStreams => {
	if (spec.auth.kind === "cloudflare_ai_gateway") {
		const authSpec = spec.auth
		return {
			stream: (model, context, options) => {
				const dispatch = resolveGatewayDispatch(model, spec, authSpec, config, options)
				const { apiKey: _dropped, ...rest } = options ?? {}
				const nextOptions = {
					...(dispatch.stripApiKey ? rest : options),
					...(dispatch.fetchOverride === undefined ? {} : { fetch: dispatch.fetchOverride }),
				}
				return streams.stream(dispatch.model, context, nextOptions)
			},
			streamSimple: (model, context, options) => {
				const dispatch = resolveGatewayDispatch(model, spec, authSpec, config, options)
				const { apiKey: _dropped, ...rest } = options ?? {}
				const nextOptions = {
					...(dispatch.stripApiKey ? rest : options),
					...(dispatch.fetchOverride === undefined ? {} : { fetch: dispatch.fetchOverride }),
				}
				return streams.streamSimple(dispatch.model, context, nextOptions)
			},
		}
	}
	if (spec.auth.kind === "cloudflare_workers_ai") {
		const authSpec = spec.auth
		const resolveModel = (
			model: Model<Api>,
			env: Readonly<Record<string, string | undefined>> | undefined,
		): Model<Api> => {
			const override = resolveBaseUrlOverride(spec, config)
			if (override !== undefined) {
				return model.baseUrl === override ? model : { ...model, baseUrl: override }
			}
			const accountId =
				trimmedEnv(env, authSpec.accountIdEnv) ?? trimmedEnv(config.env, authSpec.accountIdEnv)
			if (accountId === undefined) {
				return model
			}
			const baseUrl = `${DEFAULT_CLOUDFLARE_WORKERS_AI_BASE_ROOT}/${encodeURIComponent(accountId)}/ai/v1`
			return model.baseUrl === baseUrl ? model : { ...model, baseUrl }
		}
		return {
			stream: (model, context, options) =>
				streams.stream(resolveModel(model, options?.env), context, options),
			streamSimple: (model, context, options) =>
				streams.streamSimple(resolveModel(model, options?.env), context, options),
		}
	}
	return streams
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
		SHARED_BUILTIN_CATALOG_IDS.has(spec.id) &&
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
	config: ProviderRuntimeConfig,
): WireFormatOptions => {
	if (spec.auth.kind === "cloudflare_ai_gateway") {
		const override = resolveBaseUrlOverride(spec, config)
		const allowedOrigins =
			override !== undefined
				? [new URL(override).origin]
				: [
						new URL(DEFAULT_CLOUDFLARE_AI_GATEWAY_HTTPS_ROOT).origin,
						new URL(DEFAULT_CLOUDFLARE_AI_GATEWAY_BINDING_ROOT).origin,
					]
		return { allowedOrigins, isolateSdkEnvHeaders: true }
	}
	if (spec.auth.kind === "cloudflare_workers_ai") {
		const override = resolveBaseUrlOverride(spec, config)
		const allowedOrigins = [new URL(override ?? DEFAULT_CLOUDFLARE_WORKERS_AI_BASE_ROOT).origin]
		return { allowedOrigins, isolateSdkEnvHeaders: true }
	}
	const expectedBaseUrl =
		spec.id === "openrouter"
			? resolveRouteBaseUrl(
					spec,
					format === "anthropic-messages" ? "openrouter-anthropic" : "openrouter-completions",
					config,
				)
			: resolvedBaseUrl
	const pinned = parsePinnedProviderBaseUrl(expectedBaseUrl, `provider "${spec.id}" baseUrl`)
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

/**
 * Resolves and materializes a valid `Model<WireFormat>` for `spec` and `modelId`
 * using the same `resolveProviderModelPlan` engine as `resolveModelSpecifier`.
 */
export const synthesizeProviderModel = (
	spec: ProviderSpec,
	modelId: string,
	config: ProviderRuntimeConfig,
): Model<WireFormat> | undefined => {
	assertValidProviderSpec(spec)
	const minContextWindow = config.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW
	const plan = resolveProviderModelPlan(spec, modelId, minContextWindow)
	if (plan === undefined) {
		return undefined
	}
	const baseUrl = resolveRouteBaseUrl(spec, plan.route, config)
	return materializeModelPlan(spec, plan, baseUrl)
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

export interface BuildPiProviderOverrides {
	readonly streams?: ProviderStreams
	readonly auth?: ProviderAuth
}

export const buildPiProvider = (
	spec: ProviderSpec,
	config: ProviderRuntimeConfig,
	overrides?: BuildPiProviderOverrides,
): Provider<WireFormat> => {
	assertValidProviderSpec(spec)
	const resolvedBaseUrl = resolveProviderBaseUrl(spec, config)
	const apiMap: Partial<Record<WireFormat, ProviderStreams>> = {}
	for (const format of spec.formats) {
		if (overrides?.streams !== undefined) {
			apiMap[format] = overrides.streams
			continue
		}
		const wireOptions = providerWireOptions(spec, format, resolvedBaseUrl, config)
		apiMap[format] = wrapCloudflareStreams(
			wrapCustomAuthStreams(createWireFormatStreams(format, wireOptions), spec, format),
			spec,
			config,
		)
	}
	const provider = createProvider<WireFormat>({
		id: spec.id,
		name: spec.name,
		baseUrl: resolvedBaseUrl,
		...(spec.headers === undefined ? {} : { headers: { ...spec.headers } }),
		auth: overrides?.auth ?? buildProviderAuth(spec, config),
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
		if (BUILT_PROVIDER_METADATA.has(provider)) {
			const bound = bindProviderToRegistryFloor(provider, minContextWindow)
			if (bound !== provider) {
				base.setProvider(bound)
			}
		}
	}
	const isEligibleChatModel = (model: Model<Api>): boolean =>
		model.contextWindow >= minContextWindow
	const isEligibleAnyModel = (model: AnyModel): boolean =>
		!isModelType(model, "chat") || model.contextWindow >= minContextWindow

	// Dynamic model synthesis runs only for providers built via `buildPiProvider`, whose
	// authoritative `ProviderSpec` and runtime config are tracked in `BUILT_PROVIDER_METADATA`.
	// Externally constructed `Provider` instances (e.g. Pi's `createProvider`) remain strictly
	// static-only so opaque proxy endpoints, wire codecs, limits, allowlists, and non-chat
	// catalogs are never guessed or bypassed.
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
