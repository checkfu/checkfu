import { isValidModelId, resolveProviderModelPlan } from "./ModelResolution.ts"
import { BUILTIN_PROVIDERS, allProviders, findProvider } from "./Providers.ts"
import { DEFAULT_MIN_CONTEXT_WINDOW, MAX_MODEL_ID_LENGTH } from "./Types.ts"
import type { ProviderSpec, ResolvedModelSpecifier } from "./Types.ts"

export {
	getCloudflareAiGatewayCatalogEntry,
	getCloudflareAiGatewayCatalogIndex,
	getCloudflareWorkersAiCatalogEntry,
	getCloudflareWorkersAiCatalogIndex,
	getKnownNonChatModelIds,
	getOpenRouterCatalogEntry,
	getOpenRouterCatalogIndex,
	isKnownNonChatModel,
} from "./CatalogIndex.ts"
export type { CatalogIndexEntry } from "./CatalogIndex.ts"
export {
	CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES,
	CUSTOM_PROVIDERS_ENV,
	CUSTOM_PROVIDER_CATALOG_ENV,
	CUSTOM_PROVIDER_SECRET_ENV_PREFIX,
	CustomProviderConfigError,
	assertCloudflareWorkerEnvByteLimit,
	assertValidCustomProviderCredentials,
	isCustomProviderSecretEnv,
	isSendableBearerToken,
	isValidHeaderValue,
	packAlchemyConfigEnvValue,
	parseCustomProviderCatalog,
	parseCustomProvidersManifest,
	serializeCustomProviderCatalog,
	usesLoopbackHttpBaseUrl,
	utf8ByteLength,
	validateCustomProviderCredentials,
} from "./CustomProviders.ts"
export type {
	AssertWorkerEnvByteLimitOptions,
	CustomProviderCredentialsValidationResult,
	ParseCustomProvidersOptions,
} from "./CustomProviders.ts"
export { parseLoopbackBaseUrl, parseProviderBaseUrl } from "./Fetch.ts"
export {
	BUILTIN_PROVIDERS,
	BUILTIN_PROVIDER_IDS,
	CLOUDFLARE_ACCOUNT_ID_ENV,
	CLOUDFLARE_AI_API_KEY_ENV,
	CLOUDFLARE_GATEWAY_ID_ENV,
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_CLOUDFLARE_AI_GATEWAY_BINDING_ROOT,
	DEFAULT_CLOUDFLARE_AI_GATEWAY_HTTPS_ROOT,
	DEFAULT_CLOUDFLARE_WORKERS_AI_BASE_ROOT,
	DEFAULT_OPENAI_BASE_URL,
	DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL,
	DEFAULT_OPENROUTER_BASE_URL,
	allProviders,
	checkProviderCredentials,
	defineProvider,
	findProvider,
	inferProviderForApiKey,
	isBuiltinProviderId,
	providerRequiredConfigEnvs,
	providerRequiredSecretEnvs,
	resolveCloudflareGatewayAuthMode,
	shouldBindCloudflareAiGateway,
} from "./Providers.ts"
export type {
	BuiltinProvider,
	BuiltinProviderId,
	CloudflareGatewayAuthInputs,
	CloudflareGatewayAuthMode,
} from "./Providers.ts"
export {
	DEFAULT_MIN_CONTEXT_WINDOW,
	DEFAULT_SYNTHESIZED_CONTEXT_WINDOW,
	DEFAULT_SYNTHESIZED_MAX_TOKENS,
	MAX_MODEL_ID_LENGTH,
	WIRE_FORMATS,
	isWireFormat,
} from "./Types.ts"
export type {
	CloudflareAiBindingLike,
	ProviderAuthSpec,
	ProviderCredentialCheck,
	ProviderModelDefaults,
	ProviderRuntimeConfig,
	ProviderSpec,
	ResolvedModelSpecifier,
	WireFormat,
} from "./Types.ts"

export interface ResolveModelSpecifierOptions {
	readonly customProviders?: ReadonlyArray<ProviderSpec>
	readonly minContextWindow?: number
}

export const resolveModelSpecifier = (
	requestedModelId: string,
	options?: ResolveModelSpecifierOptions,
): ResolvedModelSpecifier | null => {
	if (requestedModelId.length === 0 || requestedModelId.length > MAX_MODEL_ID_LENGTH) {
		return null
	}
	const minContextWindow = options?.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW
	const slashIndex = requestedModelId.indexOf("/")
	if (slashIndex > 0) {
		const providerId = requestedModelId.slice(0, slashIndex)
		const modelId = requestedModelId.slice(slashIndex + 1)
		const provider = findProvider(providerId, options?.customProviders)
		if (provider === undefined) {
			return null
		}
		const plan = resolveProviderModelPlan(provider, modelId, minContextWindow)
		return plan === undefined ? null : { provider: provider.id, modelId, cataloged: plan.cataloged }
	}
	if (!isValidModelId(requestedModelId)) {
		return null
	}
	for (const provider of allProviders(options?.customProviders)) {
		if (!provider.resolveBareModelIds) {
			continue
		}
		const plan = resolveProviderModelPlan(provider, requestedModelId, minContextWindow)
		if (plan !== undefined && plan.cataloged) {
			return { provider: provider.id, modelId: requestedModelId, cataloged: true }
		}
	}
	return null
}

export const formatSupportedProviders = (customProviders?: ReadonlyArray<ProviderSpec>): string =>
	allProviders(customProviders)
		.map((provider) => provider.id)
		.join(", ")

export { BUILTIN_PROVIDERS as DEFAULT_PROVIDERS }
