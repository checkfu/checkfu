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
] as const satisfies ReadonlyArray<ProviderSpec>

export type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number]
export type BuiltinProviderId = BuiltinProvider["id"]

export const BUILTIN_PROVIDER_IDS: ReadonlyArray<BuiltinProviderId> = BUILTIN_PROVIDERS.map(
	(provider) => provider.id,
)

const BUILTIN_PROVIDER_MAP: ReadonlyMap<string, BuiltinProvider> = new Map(
	BUILTIN_PROVIDERS.map((provider) => [provider.id, provider]),
)

export const isBuiltinProviderId = (value: string): value is BuiltinProviderId =>
	BUILTIN_PROVIDER_MAP.has(value)

const isSupportedAuthKind = (kind: string): kind is ProviderAuthSpec["kind"] =>
	kind === "none" || kind === "bearer" || kind === "api_key_header"

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
	parsePinnedProviderBaseUrl(spec.baseUrl, `provider "${spec.id}" baseUrl`)
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
	const envs: Array<string> = []
	for (const provider of providers) {
		switch (provider.auth.kind) {
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
