import {
	BUILTIN_PROVIDER_IDS,
	BUILTIN_PROVIDERS,
	CUSTOM_PROVIDERS_ENV,
	CUSTOM_PROVIDER_CATALOG_ENV,
	allProviders,
	assertCloudflareWorkerEnvByteLimit,
	checkProviderCredentials,
	findProvider,
	formatSupportedProviders,
	isBuiltinProviderId,
	parseCustomProviderCatalog,
	parseCustomProvidersManifest,
	resolveModelSpecifier,
	serializeCustomProviderCatalog,
	usesLoopbackHttpBaseUrl,
} from "@checkfu/pi-providers/catalog"
import type {
	BuiltinProviderId,
	ProviderRuntimeConfig,
	ProviderSpec,
	ResolvedModelSpecifier,
} from "@checkfu/pi-providers/catalog"
import { AlchemyContext } from "alchemy/AlchemyContext"
import * as Output from "alchemy/Output"
import { CurrentRuntimeContext, packEnvValue } from "alchemy/RuntimeContext"
import { Stage } from "alchemy/Stage"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW } from "./PiContextBudget.ts"

export {
	CUSTOM_PROVIDERS_ENV,
	CUSTOM_PROVIDER_CATALOG_ENV,
	allProviders,
	parseCustomProviderCatalog,
	parseCustomProvidersManifest,
	serializeCustomProviderCatalog,
}

export const LOCAL_DEV_SIGNAL_ENV = "CHECKFU_LOCAL_DEV"
export const LOCAL_DEV_SIGNAL_VALUE = "local-dev"

export const SUPPORTED_PROVIDERS = BUILTIN_PROVIDER_IDS
export type SupportedProvider = BuiltinProviderId

export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = Object.fromEntries(
	BUILTIN_PROVIDERS.flatMap((provider) =>
		provider.auth.kind === "bearer" || provider.auth.kind === "api_key_header"
			? [[provider.id, provider.auth.env] as const]
			: [],
	),
)

const optionalConfigString = (name: string): Config.Config<string | null> =>
	Config.option(Config.String(name)).pipe(
		Config.map((value) =>
			value.pipe(
				Option.map((raw) => raw.trim()),
				Option.filter((trimmed) => trimmed.length > 0),
				Option.getOrNull,
			),
		),
	)

const optionalRawConfigString = (name: string): Config.Config<string | null> =>
	Config.option(Config.String(name)).pipe(
		Config.map((value) =>
			value.pipe(
				Option.filter((raw) => raw.trim().length > 0),
				Option.getOrNull,
			),
		),
	)

/**
 * Reads and validates the full `CHECKFU_PROVIDERS` JSON manifest for
 * `PiHarnessWorker` (never used directly by `ApiWorker` during plan phase so
 * static headers and base URLs never leak into the public API Worker).
 */
export const configuredCustomProviders = Effect.gen(function* () {
	const raw = yield* optionalRawConfigString(CUSTOM_PROVIDERS_ENV)
	if (raw === null) {
		return [] as ReadonlyArray<ProviderSpec>
	}
	const alchemyContext = yield* Effect.serviceOption(AlchemyContext)
	if (Option.isSome(alchemyContext)) {
		const stage = yield* Effect.serviceOption(Stage)
		const allowLoopbackHttp =
			alchemyContext.value.dev && !(Option.isSome(stage) && stage.value === "production")
		const providers = parseCustomProvidersManifest(raw, {
			allowLoopbackHttp,
			minContextWindow: PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
		})
		assertCloudflareWorkerEnvByteLimit(CUSTOM_PROVIDERS_ENV, packEnvValue(Redacted.make(raw)), {
			alreadyEncoded: true,
		})
		if (providers.length > 0) {
			assertCloudflareWorkerEnvByteLimit(
				CUSTOM_PROVIDER_CATALOG_ENV,
				serializeCustomProviderCatalog(providers),
			)
		}
		if (allowLoopbackHttp && providers.some(usesLoopbackHttpBaseUrl)) {
			const runtimeContext = yield* CurrentRuntimeContext
			yield* (
				runtimeContext?.set(LOCAL_DEV_SIGNAL_ENV, Output.literal(LOCAL_DEV_SIGNAL_VALUE)) ??
				Effect.void
			)
		}
		return providers
	}
	const runtimeStage = yield* optionalConfigString("ALCHEMY_STAGE")
	const localDevSignal = yield* optionalConfigString(LOCAL_DEV_SIGNAL_ENV)
	const allowLoopbackHttp =
		runtimeStage !== "production" && localDevSignal === LOCAL_DEV_SIGNAL_VALUE
	return parseCustomProvidersManifest(raw, {
		allowLoopbackHttp,
		minContextWindow: PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
	})
}).pipe(Effect.orDie)

/**
 * Plan-time Worker props binding a stripped, header-free validation projection
 * (`CHECKFU_PROVIDER_CATALOG`) to `ApiWorker` so `ApiWorker` validates custom
 * agent models without ever receiving custom static headers, auth specs, or base URLs.
 */
export const apiWorkerCustomProvidersProps = Effect.gen(function* () {
	const alchemyContext = yield* Effect.serviceOption(AlchemyContext)
	if (Option.isNone(alchemyContext)) {
		return {}
	}
	const raw = yield* optionalRawConfigString(CUSTOM_PROVIDERS_ENV)
	if (raw === null) {
		return {}
	}
	const stage = yield* Effect.serviceOption(Stage)
	const allowLoopbackHttp =
		alchemyContext.value.dev && !(Option.isSome(stage) && stage.value === "production")
	const providers = parseCustomProvidersManifest(raw, {
		allowLoopbackHttp,
		minContextWindow: PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
	})
	assertCloudflareWorkerEnvByteLimit(CUSTOM_PROVIDERS_ENV, packEnvValue(Redacted.make(raw)), {
		alreadyEncoded: true,
	})
	if (providers.length === 0) {
		return {}
	}
	const serializedCatalog = serializeCustomProviderCatalog(providers)
	assertCloudflareWorkerEnvByteLimit(CUSTOM_PROVIDER_CATALOG_ENV, serializedCatalog)
	return { env: { [CUSTOM_PROVIDER_CATALOG_ENV]: serializedCatalog } }
}).pipe(Effect.orDie)

/**
 * Loads the stripped validation-only view of custom providers for `ApiWorker`.
 * During Alchemy plan phase it avoids reading `CHECKFU_PROVIDERS` so the raw
 * manifest is never captured into `ApiWorker`'s bindings.
 */
export const configuredApiCustomProviders = Effect.gen(function* () {
	const alchemyContext = yield* Effect.serviceOption(AlchemyContext)
	if (Option.isSome(alchemyContext)) {
		return [] as ReadonlyArray<ProviderSpec>
	}
	const catalogRaw = yield* optionalConfigString(CUSTOM_PROVIDER_CATALOG_ENV)
	if (catalogRaw !== null) {
		return parseCustomProviderCatalog(catalogRaw, {
			minContextWindow: PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
		})
	}
	const providers = yield* configuredCustomProviders
	return providers.length === 0
		? ([] as ReadonlyArray<ProviderSpec>)
		: parseCustomProviderCatalog(serializeCustomProviderCatalog(providers), {
				minContextWindow: PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
			})
}).pipe(Effect.orDie)

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
