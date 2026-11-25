import {
	BUILTIN_PROVIDER_IDS,
	BUILTIN_PROVIDERS,
	checkProviderCredentials,
	findProvider,
	formatSupportedProviders,
	isBuiltinProviderId,
	resolveModelSpecifier,
} from "@checkfu/pi-providers/catalog"
import type {
	BuiltinProviderId,
	ProviderRuntimeConfig,
	ProviderSpec,
	ResolvedModelSpecifier,
} from "@checkfu/pi-providers/catalog"
import { PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW } from "./PiContextBudget.ts"

export const SUPPORTED_PROVIDERS = BUILTIN_PROVIDER_IDS
export type SupportedProvider = BuiltinProviderId

export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = Object.fromEntries(
	BUILTIN_PROVIDERS.flatMap((provider) =>
		provider.auth.kind === "bearer" || provider.auth.kind === "api_key_header"
			? [[provider.id, provider.auth.env] as const]
			: [],
	),
)

export const isSupportedProvider = (
	value: string,
	customProviders?: ReadonlyArray<ProviderSpec>,
): boolean =>
	isBuiltinProviderId(value) ||
	(customProviders?.some((provider) => provider.id === value) ?? false)

export const resolveCatalogModel = (
	requestedModelId: string,
	customProviders?: ReadonlyArray<ProviderSpec>,
): ResolvedModelSpecifier | null =>
	resolveModelSpecifier(requestedModelId, {
		...(customProviders === undefined ? {} : { customProviders }),
		minContextWindow: PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
	})

export const supportedProvidersDescription = (
	customProviders?: ReadonlyArray<ProviderSpec>,
): string => formatSupportedProviders(customProviders)

export const checkCatalogProviderCredentials = (
	providerId: string,
	config: Pick<ProviderRuntimeConfig, "env" | "aiBinding">,
	customProviders?: ReadonlyArray<ProviderSpec>,
) => {
	const provider = findProvider(providerId, customProviders)
	if (provider === undefined) {
		return {
			ok: false as const,
			missing: [] as ReadonlyArray<string>,
			message: `Unknown provider "${providerId}".`,
		}
	}
	return checkProviderCredentials(provider, config)
}
