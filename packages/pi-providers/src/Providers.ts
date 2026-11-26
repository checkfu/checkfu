import { parsePinnedProviderBaseUrl } from "./Fetch.ts"
import { isWireFormat, ownProperty } from "./Types.ts"
import type {
	ProviderAuthSpec,
	ProviderCredentialCheck,
	ProviderRuntimeConfig,
	ProviderSpec,
} from "./Types.ts"

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
export const DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api"
export const DEFAULT_CLOUDFLARE_AI_GATEWAY_HTTPS_ROOT = "https://gateway.ai.cloudflare.com/v1"
export const DEFAULT_CLOUDFLARE_AI_GATEWAY_BINDING_ROOT =
	"https://workers-binding.ai/ai-gateway/gateways"
export const DEFAULT_CLOUDFLARE_WORKERS_AI_BASE_ROOT =
	"https://api.cloudflare.com/client/v4/accounts"

// Dedicated inference token variable kept strictly separate from Alchemy / Cloudflare
// deployment credentials (`CLOUDFLARE_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_EMAIL`)
// so deployment keys are never bound to runtime Workers and inference tokens never trigger
// Alchemy's legacy global-key environment auth.
export const CLOUDFLARE_AI_API_KEY_ENV = "CLOUDFLARE_AI_API_KEY"
export const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID"
export const CLOUDFLARE_GATEWAY_ID_ENV = "CLOUDFLARE_GATEWAY_ID"

export const defineProvider = <const T extends ProviderSpec>(spec: T): T => spec

export const BUILTIN_PROVIDERS = [
	defineProvider({
		id: "openai",
		name: "OpenAI",
		source: "builtin",
		defaultModel: "gpt-6.2-sol",
		defaultFormat: "openai-responses",
		formats: ["openai-responses"],
		baseUrl: DEFAULT_OPENAI_BASE_URL,
		auth: {
			kind: "bearer",
			env: "OPENAI_API_KEY",
			label: "OpenAI API key",
			keyPrefixes: ["sk-proj-", "sk-"],
		},
		resolveBareModelIds: true,
		allowUnlistedModels: true,
	}),
	defineProvider({
		id: "anthropic",
		name: "Anthropic",
		source: "builtin",
		defaultModel: "claude-sonnet-5-5",
		defaultFormat: "anthropic-messages",
		formats: ["anthropic-messages"],
		baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
		auth: {
			kind: "api_key_header",
			header: "x-api-key",
			env: "ANTHROPIC_API_KEY",
			label: "Anthropic API key",
			keyPrefixes: ["sk-ant-"],
		},
		resolveBareModelIds: true,
		allowUnlistedModels: true,
	}),
	defineProvider({
		id: "openrouter",
		name: "OpenRouter",
		source: "builtin",
		defaultModel: "openrouter/anthropic/claude-sonnet-5.5",
		defaultFormat: "openai-completions",
		formats: ["anthropic-messages", "openai-completions"],
		baseUrl: DEFAULT_OPENROUTER_BASE_URL,
		auth: {
			kind: "bearer",
			env: "OPENROUTER_API_KEY",
			label: "OpenRouter API key",
			keyPrefixes: ["sk-or-"],
		},
		resolveBareModelIds: false,
		allowUnlistedModels: true,
	}),
	defineProvider({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		source: "builtin",
		defaultModel: "cloudflare-ai-gateway/claude-sonnet-5-5",
		defaultFormat: "openai-completions",
		formats: ["anthropic-messages", "openai-responses", "openai-completions"],
		auth: {
			kind: "cloudflare_ai_gateway",
			apiKeyEnv: CLOUDFLARE_AI_API_KEY_ENV,
			accountIdEnv: CLOUDFLARE_ACCOUNT_ID_ENV,
			gatewayIdEnv: CLOUDFLARE_GATEWAY_ID_ENV,
		},
		resolveBareModelIds: false,
		allowUnlistedModels: true,
	}),
	defineProvider({
		id: "cloudflare-workers-ai",
		name: "Cloudflare Workers AI",
		source: "builtin",
		defaultModel: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017",
		defaultFormat: "openai-completions",
		formats: ["openai-completions"],
		auth: {
			kind: "cloudflare_workers_ai",
			apiKeyEnv: CLOUDFLARE_AI_API_KEY_ENV,
			accountIdEnv: CLOUDFLARE_ACCOUNT_ID_ENV,
		},
		resolveBareModelIds: false,
		allowUnlistedModels: true,
	}),
] as const satisfies ReadonlyArray<ProviderSpec>

export type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number]
export type BuiltinProviderId = BuiltinProvider["id"]

export const BUILTIN_PROVIDER_IDS: ReadonlyArray<BuiltinProviderId> = BUILTIN_PROVIDERS.map(
	(provider) => provider.id,
)

export interface DefaultProviderModel {
	readonly provider: BuiltinProviderId
	readonly modelId: string
	readonly specifier: string
}

export const DEFAULT_PROVIDER_MODELS: ReadonlyArray<DefaultProviderModel> = BUILTIN_PROVIDERS.map(
	(provider) => ({
		provider: provider.id,
		modelId: provider.defaultModel.startsWith(`${provider.id}/`)
			? provider.defaultModel.slice(provider.id.length + 1)
			: provider.defaultModel,
		specifier: provider.defaultModel,
	}),
)

const BUILTIN_PROVIDER_MAP: ReadonlyMap<string, BuiltinProvider> = new Map(
	BUILTIN_PROVIDERS.map((provider) => [provider.id, provider]),
)

export const isBuiltinProviderId = (value: string): value is BuiltinProviderId =>
	BUILTIN_PROVIDER_MAP.has(value)

const CATALOG_ONLY_PROVIDER_SPECS = new WeakSet<ProviderSpec>()

/**
 * Marks a stripped validation-only provider projection (such as those parsed
 * from `CHECKFU_PROVIDER_CATALOG` for public API Workers) so catalog validation
 * permits the intentionally omitted `baseUrl` while runtime registration still
 * rejects it.
 */
export const markCatalogOnlyProviderSpec = <T extends ProviderSpec>(spec: T): T => {
	CATALOG_ONLY_PROVIDER_SPECS.add(spec)
	return spec
}

export const isCatalogOnlyProviderSpec = (spec: ProviderSpec): boolean =>
	CATALOG_ONLY_PROVIDER_SPECS.has(spec)

const isSupportedAuthKind = (kind: string): kind is ProviderAuthSpec["kind"] =>
	kind === "none" ||
	kind === "bearer" ||
	kind === "api_key_header" ||
	kind === "cloudflare_ai_gateway" ||
	kind === "cloudflare_workers_ai"

const hasControlOrWhitespace = (value: string): boolean => {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i)
		if (code <= 0x20 || code === 0x7f) {
			return true
		}
	}
	return /\s/.test(value)
}

export const assertValidProviderSpec = (spec: ProviderSpec): void => {
	if (spec.id.length === 0) {
		throw new Error("Provider id must be non-empty.")
	}
	if (spec.id.includes("/")) {
		throw new Error(`Provider id "${spec.id}" must not contain "/".`)
	}
	if (hasControlOrWhitespace(spec.id)) {
		throw new Error(`Provider id "${spec.id}" must not contain whitespace or control characters.`)
	}
	const authKind: string = spec.auth.kind
	if (!isSupportedAuthKind(authKind)) {
		throw new TypeError(`Provider "${spec.id}" uses unsupported auth kind "${authKind}".`)
	}
	if (spec.formats.length === 0) {
		throw new Error(`Provider "${spec.id}" must declare at least one wire format.`)
	}
	for (const format of spec.formats) {
		const candidate: string = format
		if (!isWireFormat(candidate)) {
			throw new Error(`Provider "${spec.id}" declares unsupported wire format "${candidate}".`)
		}
	}
	const defaultFormat: string = spec.defaultFormat
	if (!isWireFormat(defaultFormat)) {
		throw new Error(`Provider "${spec.id}" declares unsupported defaultFormat "${defaultFormat}".`)
	}
	if (!spec.formats.includes(spec.defaultFormat)) {
		throw new Error(
			`Provider "${spec.id}" defaultFormat "${spec.defaultFormat}" must be listed in formats (${spec.formats.join(", ")}).`,
		)
	}
	if (spec.auth.kind === "cloudflare_workers_ai") {
		if (spec.formats.some((format) => format !== "openai-completions")) {
			throw new Error(
				`Provider "${spec.id}" uses "cloudflare_workers_ai" auth and only supports the "openai-completions" wire format.`,
			)
		}
	}
	const hasDynamicCloudflareEndpoint =
		spec.auth.kind === "cloudflare_ai_gateway" || spec.auth.kind === "cloudflare_workers_ai"
	if (hasDynamicCloudflareEndpoint) {
		if (spec.baseUrl !== undefined) {
			throw new Error(
				`Provider "${spec.id}" uses "${spec.auth.kind}" auth and must not declare a static baseUrl.`,
			)
		}
	} else if (!isCatalogOnlyProviderSpec(spec) || spec.baseUrl !== undefined) {
		parsePinnedProviderBaseUrl(spec.baseUrl, `provider "${spec.id}" baseUrl`)
	}
}

const assertUniqueCustomProviders = (customProviders: ReadonlyArray<ProviderSpec>): void => {
	const seen = new Set<string>()
	for (const provider of customProviders) {
		if (provider.id.length === 0) {
			throw new Error("Custom provider id must be non-empty.")
		}
		if (BUILTIN_PROVIDER_MAP.has(provider.id)) {
			throw new Error(`Custom provider id "${provider.id}" collides with a built-in provider.`)
		}
		if (seen.has(provider.id)) {
			throw new Error(`Duplicate custom provider id "${provider.id}".`)
		}
		assertValidProviderSpec(provider)
		seen.add(provider.id)
	}
}

export const allProviders = (
	customProviders?: ReadonlyArray<ProviderSpec>,
): ReadonlyArray<ProviderSpec> => {
	if (customProviders === undefined || customProviders.length === 0) {
		return BUILTIN_PROVIDERS
	}
	assertUniqueCustomProviders(customProviders)
	return [...BUILTIN_PROVIDERS, ...customProviders]
}

export const findProvider = (
	id: string,
	customProviders?: ReadonlyArray<ProviderSpec>,
): ProviderSpec | undefined => {
	if (customProviders !== undefined && customProviders.length > 0) {
		assertUniqueCustomProviders(customProviders)
	}
	const builtin = BUILTIN_PROVIDER_MAP.get(id)
	if (builtin !== undefined) {
		return builtin
	}
	return customProviders?.find((provider) => provider.id === id)
}

export const providerRequiredSecretEnvs = (
	providers: ReadonlyArray<ProviderSpec> = BUILTIN_PROVIDERS,
): ReadonlyArray<string> => {
	const seen = new Set<string>()
	const envs: Array<string> = []
	const add = (envName: string) => {
		if (!seen.has(envName)) {
			seen.add(envName)
			envs.push(envName)
		}
	}
	for (const provider of providers) {
		switch (provider.auth.kind) {
			case "bearer":
			case "api_key_header":
				add(provider.auth.env)
				break
			case "cloudflare_ai_gateway":
			case "cloudflare_workers_ai":
				add(provider.auth.apiKeyEnv)
				break
			case "none":
				break
		}
		if (provider.secretHeaders !== undefined) {
			for (const envName of Object.values(provider.secretHeaders)) {
				add(envName)
			}
		}
	}
	return envs
}

export const providerRequiredConfigEnvs = (
	providers: ReadonlyArray<ProviderSpec> = BUILTIN_PROVIDERS,
): ReadonlyArray<string> => {
	const seen = new Set<string>()
	const envs: Array<string> = []
	const add = (envName: string) => {
		if (!seen.has(envName)) {
			seen.add(envName)
			envs.push(envName)
		}
	}
	for (const provider of providers) {
		switch (provider.auth.kind) {
			case "cloudflare_ai_gateway":
				add(provider.auth.accountIdEnv)
				add(provider.auth.gatewayIdEnv)
				break
			case "cloudflare_workers_ai":
				add(provider.auth.accountIdEnv)
				break
			case "bearer":
			case "api_key_header":
			case "none":
				break
		}
	}
	return envs
}

const hasEnvValue = (env: Readonly<Record<string, string | undefined>>, name: string): boolean => {
	const value = ownProperty(env, name)
	return value !== undefined && value.trim().length > 0
}

export type CloudflareGatewayAuthMode =
	| { readonly mode: "https" }
	| { readonly mode: "binding" }
	| { readonly mode: "incomplete"; readonly missing: ReadonlyArray<string> }

export interface CloudflareGatewayAuthInputs {
	readonly hasGatewayId: boolean
	readonly hasAccountId: boolean
	readonly hasApiKey: boolean
	readonly hasBinding: boolean
	readonly gatewayIdEnv?: string
	readonly accountIdEnv?: string
	readonly apiKeyEnv?: string
}

export const resolveCloudflareGatewayAuthMode = (
	inputs: CloudflareGatewayAuthInputs,
): CloudflareGatewayAuthMode => {
	const gatewayIdEnv = inputs.gatewayIdEnv ?? CLOUDFLARE_GATEWAY_ID_ENV
	const accountIdEnv = inputs.accountIdEnv ?? CLOUDFLARE_ACCOUNT_ID_ENV
	const apiKeyEnv = inputs.apiKeyEnv ?? CLOUDFLARE_AI_API_KEY_ENV

	if (inputs.hasApiKey) {
		const missing: Array<string> = []
		if (!inputs.hasGatewayId) {
			missing.push(gatewayIdEnv)
		}
		if (!inputs.hasAccountId) {
			missing.push(accountIdEnv)
		}
		return missing.length === 0 ? { mode: "https" } : { mode: "incomplete", missing }
	}
	if (inputs.hasBinding) {
		return inputs.hasGatewayId
			? { mode: "binding" }
			: { mode: "incomplete", missing: [gatewayIdEnv] }
	}
	const missing: Array<string> = []
	if (!inputs.hasGatewayId) {
		missing.push(gatewayIdEnv)
	}
	if (!inputs.hasAccountId) {
		missing.push(accountIdEnv)
	}
	missing.push(apiKeyEnv)
	return { mode: "incomplete", missing }
}

export const shouldBindCloudflareAiGateway = (
	env: Readonly<Record<string, string | undefined>>,
): boolean =>
	hasEnvValue(env, CLOUDFLARE_GATEWAY_ID_ENV) && !hasEnvValue(env, CLOUDFLARE_AI_API_KEY_ENV)

export const checkProviderCredentials = (
	provider: ProviderSpec,
	config: Pick<ProviderRuntimeConfig, "env" | "aiBinding">,
): ProviderCredentialCheck => {
	const authKind: string = provider.auth.kind
	if (!isSupportedAuthKind(authKind)) {
		return {
			ok: false,
			missing: [],
			message: `Provider "${provider.id}" uses unsupported auth kind "${authKind}".`,
		}
	}

	const missingSecrets: Array<string> = []
	if (provider.secretHeaders !== undefined) {
		for (const envName of Object.values(provider.secretHeaders)) {
			if (!hasEnvValue(config.env, envName)) {
				missingSecrets.push(envName)
			}
		}
	}

	switch (provider.auth.kind) {
		case "none":
			break
		case "bearer":
		case "api_key_header":
			if (!hasEnvValue(config.env, provider.auth.env)) {
				missingSecrets.unshift(provider.auth.env)
			}
			break
		case "cloudflare_ai_gateway": {
			const gatewayAuth = resolveCloudflareGatewayAuthMode({
				hasGatewayId: hasEnvValue(config.env, provider.auth.gatewayIdEnv),
				hasAccountId: hasEnvValue(config.env, provider.auth.accountIdEnv),
				hasApiKey: hasEnvValue(config.env, provider.auth.apiKeyEnv),
				hasBinding: typeof config.aiBinding?.fetch === "function",
				gatewayIdEnv: provider.auth.gatewayIdEnv,
				accountIdEnv: provider.auth.accountIdEnv,
				apiKeyEnv: provider.auth.apiKeyEnv,
			})
			const combinedMissing: Array<string> = []
			if (gatewayAuth.mode === "incomplete") {
				combinedMissing.push(...gatewayAuth.missing)
			}
			for (const secretEnv of missingSecrets) {
				if (!combinedMissing.includes(secretEnv)) {
					combinedMissing.push(secretEnv)
				}
			}
			if (combinedMissing.length > 0) {
				return {
					ok: false,
					missing: combinedMissing,
					message: `Missing ${combinedMissing.join(", ")} for provider "${provider.id}". Set ${provider.auth.gatewayIdEnv} with ${provider.auth.apiKeyEnv} and ${provider.auth.accountIdEnv} (or bind Cloudflare AI on deploy).`,
				}
			}
			return { ok: true }
		}
		case "cloudflare_workers_ai":
			if (!hasEnvValue(config.env, provider.auth.apiKeyEnv)) {
				missingSecrets.unshift(provider.auth.apiKeyEnv)
			}
			if (!hasEnvValue(config.env, provider.auth.accountIdEnv)) {
				missingSecrets.push(provider.auth.accountIdEnv)
			}
			break
	}

	if (missingSecrets.length > 0) {
		return {
			ok: false,
			missing: missingSecrets,
			message: `Missing ${missingSecrets.join(", ")} for provider "${provider.id}".`,
		}
	}
	return { ok: true }
}

export const inferProviderForApiKey = (
	key: string,
	providers: ReadonlyArray<ProviderSpec> = BUILTIN_PROVIDERS,
): ProviderSpec | undefined => {
	let bestMatch: { readonly provider: ProviderSpec; readonly prefixLength: number } | undefined
	for (const provider of providers) {
		if (provider.auth.kind !== "bearer" && provider.auth.kind !== "api_key_header") {
			continue
		}
		for (const prefix of provider.auth.keyPrefixes ?? []) {
			if (key.startsWith(prefix)) {
				if (bestMatch === undefined || prefix.length > bestMatch.prefixLength) {
					bestMatch = { provider, prefixLength: prefix.length }
				}
			}
		}
	}
	return bestMatch?.provider
}
