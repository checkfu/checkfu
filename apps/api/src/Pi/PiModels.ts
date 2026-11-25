import * as Cloudflare from "@alchemy.run/cloudflare"
import {
	BUILTIN_PROVIDERS,
	CLOUDFLARE_AI_API_KEY_ENV,
	CLOUDFLARE_GATEWAY_ID_ENV,
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_OPENAI_BASE_URL,
	DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL,
	DEFAULT_OPENROUTER_BASE_URL,
	providerRequiredConfigEnvs,
	providerRequiredSecretEnvs,
	shouldBindCloudflareAiGateway,
} from "@checkfu/pi-providers/catalog"
import type {
	CloudflareAiBindingLike,
	ProviderRuntimeConfig,
	ProviderSpec,
} from "@checkfu/pi-providers/catalog"
import {
	createNoRedirectProviderFetch,
	createProviderModels,
	parseLoopbackBaseUrl as parseProviderLoopbackBaseUrl,
} from "@checkfu/pi-providers/runtime"
import type { MutableModels } from "@earendil-works/pi-ai/models"
import { AlchemyContext } from "alchemy/AlchemyContext"
import * as Output from "alchemy/Output"
import { CurrentRuntimeContext } from "alchemy/RuntimeContext"
import { Stage } from "alchemy/Stage"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { optionalSecret } from "../Secrets.ts"
import { PROVIDER_API_KEY_ENV } from "./PiCatalog.ts"
import { PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW } from "./PiContextBudget.ts"

export {
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_OPENAI_BASE_URL,
	DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL,
	DEFAULT_OPENROUTER_BASE_URL,
	createNoRedirectProviderFetch,
}

export const OPENAI_BASE_URL_ENV = "CHECKFU_OPENAI_BASE_URL"
export const OPENROUTER_BASE_URL_ENV = "CHECKFU_OPENROUTER_BASE_URL"
export const CLOUDFLARE_AI_GATEWAY_BASE_URL_ENV = "CHECKFU_CLOUDFLARE_AI_GATEWAY_BASE_URL"
export const CLOUDFLARE_WORKERS_AI_BASE_URL_ENV = "CHECKFU_CLOUDFLARE_WORKERS_AI_BASE_URL"
export const LOCAL_DEV_SIGNAL_ENV = "CHECKFU_LOCAL_DEV"
export const LOCAL_DEV_SIGNAL_VALUE = "local-dev"

export const parseLoopbackBaseUrl = (raw: string): string =>
	parseProviderLoopbackBaseUrl(raw, OPENAI_BASE_URL_ENV)

export interface ProviderBaseUrlOverrides {
	readonly openai?: string | null
	readonly anthropic?: string | null
	readonly openrouter?: string | null
	readonly "cloudflare-ai-gateway"?: string | null
	readonly "cloudflare-workers-ai"?: string | null
}

const EMPTY_BASE_URLS: ProviderBaseUrlOverrides = {
	openai: null,
}

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

export const loadProviderEnv = (
	providers: ReadonlyArray<ProviderSpec> = BUILTIN_PROVIDERS,
): Effect.Effect<Readonly<Record<string, string | undefined>>> =>
	Effect.gen(function* () {
		const entries: Array<readonly [string, string | undefined]> = []
		for (const secretEnv of providerRequiredSecretEnvs(providers)) {
			const secret = yield* optionalSecret(secretEnv)
			entries.push([secretEnv, secret === null ? undefined : Redacted.value(secret)])
		}
		for (const configEnv of providerRequiredConfigEnvs(providers)) {
			const value = yield* optionalConfigString(configEnv)
			entries.push([configEnv, value ?? undefined])
		}
		return Object.fromEntries(entries)
	}).pipe(Effect.orDie)

export const providerApiKeys = Effect.map(loadProviderEnv(BUILTIN_PROVIDERS), (env) => ({
	env,
	openai:
		env[PROVIDER_API_KEY_ENV.openai ?? "OPENAI_API_KEY"] === undefined
			? null
			: Redacted.make(env[PROVIDER_API_KEY_ENV.openai ?? "OPENAI_API_KEY"] ?? ""),
	anthropic:
		env[PROVIDER_API_KEY_ENV.anthropic ?? "ANTHROPIC_API_KEY"] === undefined
			? null
			: Redacted.make(env[PROVIDER_API_KEY_ENV.anthropic ?? "ANTHROPIC_API_KEY"] ?? ""),
}))

/**
 * Attaches the native Cloudflare Workers `AI` binding to `PiHarnessWorker` on
 * deploy when `CLOUDFLARE_GATEWAY_ID` is configured without a `CLOUDFLARE_AI_API_KEY`,
 * enabling zero-token in-account AI Gateway passthrough. Never attached in
 * `alchemy dev`, so local development and offline workerd tests stay fully local.
 */
export const piHarnessAiBindingProps = Effect.gen(function* () {
	const alchemyContext = yield* Effect.serviceOption(AlchemyContext)
	if (Option.isNone(alchemyContext) || alchemyContext.value.dev) {
		return {}
	}
	const gatewayId = yield* optionalConfigString(CLOUDFLARE_GATEWAY_ID_ENV)
	const apiKey = yield* optionalSecret(CLOUDFLARE_AI_API_KEY_ENV)
	const env = Object.fromEntries([
		[CLOUDFLARE_GATEWAY_ID_ENV, gatewayId ?? undefined],
		[CLOUDFLARE_AI_API_KEY_ENV, apiKey === null ? undefined : Redacted.value(apiKey)],
	])
	return shouldBindCloudflareAiGateway(env) ? { env: { AI: Cloudflare.Workers.AI() } } : {}
}).pipe(Effect.orDie)

const isAiBindingLike = (value: unknown): value is CloudflareAiBindingLike =>
	typeof value === "object" &&
	value !== null &&
	"fetch" in value &&
	typeof value.fetch === "function"

export const extractAiBinding = (workerEnv: unknown): CloudflareAiBindingLike | null => {
	if (typeof workerEnv !== "object" || workerEnv === null || !("AI" in workerEnv)) {
		return null
	}
	return isAiBindingLike(workerEnv.AI) ? workerEnv.AI : null
}

const readLoopbackOverrides = Effect.gen(function* () {
	const rawOpenAI = yield* optionalConfigString(OPENAI_BASE_URL_ENV)
	const rawOpenRouter = yield* optionalConfigString(OPENROUTER_BASE_URL_ENV)
	const rawGateway = yield* optionalConfigString(CLOUDFLARE_AI_GATEWAY_BASE_URL_ENV)
	const rawWorkersAi = yield* optionalConfigString(CLOUDFLARE_WORKERS_AI_BASE_URL_ENV)
	const overrides: ProviderBaseUrlOverrides = {
		openai:
			rawOpenAI === null ? null : parseProviderLoopbackBaseUrl(rawOpenAI, OPENAI_BASE_URL_ENV),
		...(rawOpenRouter === null
			? {}
			: { openrouter: parseProviderLoopbackBaseUrl(rawOpenRouter, OPENROUTER_BASE_URL_ENV) }),
		...(rawGateway === null
			? {}
			: {
					"cloudflare-ai-gateway": parseProviderLoopbackBaseUrl(
						rawGateway,
						CLOUDFLARE_AI_GATEWAY_BASE_URL_ENV,
					),
				}),
		...(rawWorkersAi === null
			? {}
			: {
					"cloudflare-workers-ai": parseProviderLoopbackBaseUrl(
						rawWorkersAi,
						CLOUDFLARE_WORKERS_AI_BASE_URL_ENV,
					),
				}),
	}
	return overrides
})

export const providerBaseUrls = Effect.gen(function* () {
	const alchemyContext = yield* Effect.serviceOption(AlchemyContext)
	if (Option.isSome(alchemyContext)) {
		if (!alchemyContext.value.dev) {
			return EMPTY_BASE_URLS
		}
		const stage = yield* Effect.serviceOption(Stage)
		if (Option.isSome(stage) && stage.value === "production") {
			return EMPTY_BASE_URLS
		}
		const overrides = yield* readLoopbackOverrides
		const hasAny =
			overrides.openai !== null ||
			overrides.openrouter !== undefined ||
			overrides["cloudflare-ai-gateway"] !== undefined ||
			overrides["cloudflare-workers-ai"] !== undefined
		if (!hasAny) {
			return EMPTY_BASE_URLS
		}
		const runtimeContext = yield* CurrentRuntimeContext
		yield* (
			runtimeContext?.set(LOCAL_DEV_SIGNAL_ENV, Output.literal(LOCAL_DEV_SIGNAL_VALUE)) ??
			Effect.void
		)
		return overrides
	}
	const runtimeStage = yield* optionalConfigString("ALCHEMY_STAGE")
	if (runtimeStage === "production") {
		return EMPTY_BASE_URLS
	}
	const localDevSignal = yield* optionalConfigString(LOCAL_DEV_SIGNAL_ENV)
	if (localDevSignal !== LOCAL_DEV_SIGNAL_VALUE) {
		return EMPTY_BASE_URLS
	}
	return yield* readLoopbackOverrides
}).pipe(Effect.orDie)

export interface ProviderApiKeysInput {
	readonly env?: Readonly<Record<string, string | undefined>>
	readonly openai?: Redacted.Redacted<string> | null
	readonly anthropic?: Redacted.Redacted<string> | null
}

export const toProviderRuntimeConfig = (
	apiKeys: ProviderApiKeysInput,
	baseUrls?: ProviderBaseUrlOverrides,
	extra?: Pick<ProviderRuntimeConfig, "aiBinding" | "customProviders">,
): ProviderRuntimeConfig => {
	const entries: Array<readonly [string, string | undefined]> =
		apiKeys.env === undefined ? [] : Object.entries(apiKeys.env)
	if (apiKeys.openai !== undefined) {
		entries.push([
			"OPENAI_API_KEY",
			apiKeys.openai === null ? undefined : Redacted.value(apiKeys.openai),
		])
	}
	if (apiKeys.anthropic !== undefined) {
		entries.push([
			"ANTHROPIC_API_KEY",
			apiKeys.anthropic === null ? undefined : Redacted.value(apiKeys.anthropic),
		])
	}
	return {
		env: Object.fromEntries(entries),
		...(baseUrls === undefined
			? {}
			: {
					baseUrlOverrides: {
						openai: baseUrls.openai,
						anthropic: baseUrls.anthropic,
						openrouter: baseUrls.openrouter,
						"cloudflare-ai-gateway": baseUrls["cloudflare-ai-gateway"],
						"cloudflare-workers-ai": baseUrls["cloudflare-workers-ai"],
					},
				}),
		...(extra?.aiBinding === undefined ? {} : { aiBinding: extra.aiBinding }),
		...(extra?.customProviders === undefined ? {} : { customProviders: extra.customProviders }),
		minContextWindow: PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
	}
}

export const createPiModels = (
	apiKeys: ProviderApiKeysInput,
	baseUrls?: ProviderBaseUrlOverrides,
	extra?: Pick<ProviderRuntimeConfig, "aiBinding" | "customProviders">,
): MutableModels => createProviderModels(toProviderRuntimeConfig(apiKeys, baseUrls, extra))
