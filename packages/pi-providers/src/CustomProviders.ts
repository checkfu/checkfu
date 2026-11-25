import { parseProviderBaseUrl } from "./Fetch.ts"
import { isValidModelId } from "./ModelResolution.ts"
import {
	checkProviderCredentials,
	isBuiltinProviderId,
	markCatalogOnlyProviderSpec,
	providerRequiredSecretEnvs,
} from "./Providers.ts"
import {
	DEFAULT_MIN_CONTEXT_WINDOW,
	DEFAULT_SYNTHESIZED_CONTEXT_WINDOW,
	MAX_MODEL_ID_LENGTH,
	isWireFormat,
	ownProperty,
} from "./Types.ts"
import type { ProviderAuthSpec, ProviderModelDefaults, ProviderSpec, WireFormat } from "./Types.ts"

export const CUSTOM_PROVIDERS_ENV = "CHECKFU_PROVIDERS"
export const CUSTOM_PROVIDER_CATALOG_ENV = "CHECKFU_PROVIDER_CATALOG"
export const CUSTOM_PROVIDER_SECRET_ENV_PREFIX = "CHECKFU_PROVIDER_SECRET_"
export const CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES = 5 * 1024
export const MIN_OPENAI_RESPONSES_MAX_TOKENS = 16

const UTF8_ENCODER = new TextEncoder()

export const utf8ByteLength = (value: string): number => UTF8_ENCODER.encode(value).byteLength

/**
 * Computes the exact Alchemy-packed secret string written by
 * `WorkerRuntimeContext.set` (`packEnvValueKeepRedacted(Redacted.make(raw))`)
 * for plan-time `Config` bindings uploaded to Cloudflare Workers.
 */
export const packAlchemyConfigEnvValue = (value: string): string =>
	JSON.stringify({ _tag: "Redacted", value })

export interface AssertWorkerEnvByteLimitOptions {
	readonly maxBytes?: number
	readonly packedConfigBinding?: boolean
	readonly alreadyEncoded?: boolean
}

export const assertCloudflareWorkerEnvByteLimit = (
	envName: string,
	value: string,
	options?: AssertWorkerEnvByteLimitOptions,
): void => {
	const maxBytes = options?.maxBytes ?? CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES
	const wireValue = options?.packedConfigBinding ? packAlchemyConfigEnvValue(value) : value
	const bytes = utf8ByteLength(wireValue)
	if (bytes > maxBytes) {
		const verb = options?.packedConfigBinding || options?.alreadyEncoded ? "encodes to" : "is"
		throw new CustomProviderConfigError(
			`${envName} ${verb} ${bytes} UTF-8 bytes, exceeding Cloudflare Workers' ${maxBytes}-byte environment variable limit. Reduce custom provider entries, headers, or model overrides and try again.`,
		)
	}
}

const minMaxTokensForFormat = (format: WireFormat): number =>
	format === "openai-responses" ? MIN_OPENAI_RESPONSES_MAX_TOKENS : 1

const formatSafeJsonParseError = (envName: string, error: unknown): string => {
	const message = error instanceof Error ? error.message : ""
	const lineCol = /\bline\s+(\d+)\s+column\s+(\d+)\b/i.exec(message)
	if (lineCol !== null) {
		return `Invalid ${envName} JSON (line ${lineCol[1]}, column ${lineCol[2]}).`
	}
	const position = /\bposition\s+(\d+)\b/i.exec(message)
	if (position !== null) {
		return `Invalid ${envName} JSON (at position ${position[1]}).`
	}
	return `Invalid ${envName} JSON: check syntax (raw parser details omitted to avoid exposing manifest contents).`
}

/**
 * Scans already-validated RFC-8259 JSON text and rejects duplicate object members
 * (including Unicode-escaped equivalents such as `"\u0061cme"` vs `"acme"`) that
 * `JSON.parse` would otherwise collapse silently.
 */
const assertNoDuplicateJsonKeys = (json: string, envName: string): void => {
	let index = 0
	const length = json.length

	const skipWhitespace = (): void => {
		while (index < length) {
			const code = json.charCodeAt(index)
			if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
				index += 1
			} else {
				break
			}
		}
	}

	const readString = (): string => {
		const start = index
		index += 1
		while (index < length) {
			const code = json.charCodeAt(index)
			if (code === 0x5c) {
				index += 2
				continue
			}
			if (code === 0x22) {
				index += 1
				const decoded: unknown = JSON.parse(json.slice(start, index))
				return typeof decoded === "string" ? decoded : ""
			}
			index += 1
		}
		return ""
	}

	const scanValue = (depth: number): void => {
		skipWhitespace()
		if (index >= length) {
			return
		}
		const ch = json[index]
		if (ch === "{") {
			index += 1
			skipWhitespace()
			const keys = new Set<string>()
			if (json[index] === "}") {
				index += 1
				return
			}
			while (index < length) {
				skipWhitespace()
				const key = readString()
				if (keys.has(key)) {
					throw new CustomProviderConfigError(
						depth === 0 && envName === CUSTOM_PROVIDERS_ENV
							? `Duplicate custom provider id "${key}".`
							: `Duplicate JSON property "${key}" in ${envName}.`,
					)
				}
				keys.add(key)
				skipWhitespace()
				if (json[index] === ":") {
					index += 1
				}
				scanValue(depth + 1)
				skipWhitespace()
				if (json[index] === ",") {
					index += 1
					continue
				}
				if (json[index] === "}") {
					index += 1
				}
				break
			}
			return
		}
		if (ch === "[") {
			index += 1
			skipWhitespace()
			if (json[index] === "]") {
				index += 1
				return
			}
			while (index < length) {
				scanValue(depth + 1)
				skipWhitespace()
				if (json[index] === ",") {
					index += 1
					continue
				}
				if (json[index] === "]") {
					index += 1
				}
				break
			}
			return
		}
		if (ch === '"') {
			readString()
			return
		}
		while (index < length) {
			const code = json.charCodeAt(index)
			if (
				code === 0x20 ||
				code === 0x09 ||
				code === 0x0a ||
				code === 0x0d ||
				code === 0x2c ||
				code === 0x7d ||
				code === 0x5d
			) {
				break
			}
			index += 1
		}
	}

	scanValue(0)
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/
const CUSTOM_PROVIDER_SECRET_ENV_PATTERN = /^CHECKFU_PROVIDER_SECRET_[A-Z0-9][A-Z0-9_]{0,103}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const FORBIDDEN_INLINE_SECRET_KEYS = new Set([
	"api_key",
	"apiKey",
	"token",
	"secret",
	"password",
	"bearer",
])

const ALLOWED_PROVIDER_KEYS = new Set([
	"id",
	"name",
	"format",
	"base_url",
	"default_model",
	"auth",
	"api_key_env",
	"headers",
	"secret_headers",
	"context_window",
	"max_tokens",
	"reasoning",
	"input",
	"models",
])

const ALLOWED_MODEL_OVERRIDE_KEYS = new Set(["context_window", "max_tokens", "reasoning", "input"])

const DISALLOWED_CUSTOM_HEADERS = new Set([
	"host",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"upgrade",
	"te",
	"trailer",
	"proxy-authorization",
])

const SECRET_ONLY_HEADERS = new Set([
	"authorization",
	"cookie",
	"cf-aig-authorization",
	"cf-access-client-secret",
	"cf-access-jwt-assertion",
	"api-key",
	"x-api-key",
	"x-api-token",
	"x-api-secret",
	"x-auth-token",
	"x-access-token",
	"x-secret-key",
	"x-goog-api-key",
	"x-openai-api-key",
	"x-anthropic-api-key",
	"ocp-apim-subscription-key",
	"x-functions-key",
	"x-amz-security-token",
])

const CREDENTIAL_HEADER_PATTERN =
	/(?:^|-)(?:auth|authorization|key|api-?key|token|secret|password|passwd|credential|credentials|cookie|session|jwt|bearer|signature|private-?key)(?:-|$)|(?:api|access|auth|secret|private|pass|client|subscription)(?:key|token|secret)(?:-|$)/i

const ALLOWED_CATALOG_PROJECTION_KEYS = new Set([
	"id",
	"name",
	"format",
	"default_model",
	"allow_unlisted_models",
	"context_window",
	"max_tokens",
	"reasoning",
	"input",
	"models",
])

export class CustomProviderConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "CustomProviderConfigError"
	}
}

/**
 * Returns true when `name` is inside the explicit custom-provider secret
 * namespace (`CHECKFU_PROVIDER_SECRET_<NAME>`). Requiring a dedicated namespace
 * ensures custom manifests can never capture unrelated deployment, CI, platform,
 * Worker binding (`AI`), or built-in provider environment variables.
 */
export const isCustomProviderSecretEnv = (name: string): boolean =>
	CUSTOM_PROVIDER_SECRET_ENV_PATTERN.test(name)

export const usesLoopbackHttpBaseUrl = (spec: ProviderSpec): boolean =>
	spec.baseUrl !== undefined && spec.baseUrl.startsWith("http://")

const toObjectMap = (value: unknown): ReadonlyMap<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? new Map(Object.entries(value))
		: null

const validateEnvVarName = (value: unknown, contextLabel: string): string => {
	if (typeof value !== "string" || !ENV_VAR_NAME_PATTERN.test(value)) {
		throw new CustomProviderConfigError(
			`Invalid ${contextLabel}: expected an uppercase environment variable name starting with "${CUSTOM_PROVIDER_SECRET_ENV_PREFIX}".`,
		)
	}
	if (!isCustomProviderSecretEnv(value)) {
		throw new CustomProviderConfigError(
			`Disallowed environment variable in ${contextLabel}: custom provider secrets must use the "${CUSTOM_PROVIDER_SECRET_ENV_PREFIX}" prefix so unrelated deployment or built-in credentials cannot be referenced.`,
		)
	}
	return value
}

const validateHeaderName = (
	name: string,
	providerId: string,
	kind: "headers" | "secret_headers" | "auth.header",
): string => {
	if (!HEADER_NAME_PATTERN.test(name)) {
		throw new CustomProviderConfigError(
			`Invalid header name in custom provider "${providerId}" ${kind}.`,
		)
	}
	const lower = name.toLowerCase()
	if (DISALLOWED_CUSTOM_HEADERS.has(lower)) {
		throw new CustomProviderConfigError(
			`Header "${name}" cannot be overridden in custom provider "${providerId}" ${kind}.`,
		)
	}
	const normalizedCredentialHeader = lower.replaceAll(/[-_.]+/g, "-")
	if (
		kind === "headers" &&
		(SECRET_ONLY_HEADERS.has(normalizedCredentialHeader) ||
			CREDENTIAL_HEADER_PATTERN.test(normalizedCredentialHeader))
	) {
		throw new CustomProviderConfigError(
			`Credential header "${name}" cannot be placed in non-secret "headers" for custom provider "${providerId}". Use "auth" or "secret_headers" instead.`,
		)
	}
	return name
}

export const isValidHeaderValue = (value: string): boolean => {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i)
		if (code !== 0x09 && (code < 0x20 || code > 0x7e)) {
			return false
		}
	}
	return true
}

const SENDABLE_BEARER_TOKEN_PATTERN = /^[!-~]+$/

export const isSendableBearerToken = (value: string): boolean =>
	SENDABLE_BEARER_TOKEN_PATTERN.test(value)

export interface CustomProviderCredentialsValidationResult {
	readonly ok: boolean
	readonly invalidCredentialErrors: ReadonlyArray<string>
	readonly missingCredentialErrors: ReadonlyArray<string>
}

export const validateCustomProviderCredentials = (
	customProviders: ReadonlyArray<ProviderSpec>,
	env: Readonly<Record<string, string | undefined>>,
): CustomProviderCredentialsValidationResult => {
	const bearerSecretEnvs = new Set(
		customProviders.flatMap((custom) => (custom.auth.kind === "bearer" ? [custom.auth.env] : [])),
	)
	const invalidCredentialErrors: Array<string> = []
	for (const secretEnv of providerRequiredSecretEnvs(customProviders)) {
		const value = ownProperty(env, secretEnv)
		if (value === undefined || value.trim().length === 0) {
			continue
		}
		if (bearerSecretEnvs.has(secretEnv)) {
			if (!isSendableBearerToken(value)) {
				invalidCredentialErrors.push(
					`${secretEnv} cannot be sent in an HTTP header: it must be printable ASCII with no spaces or line breaks.`,
				)
				continue
			}
		} else if (value !== value.trim() || !isValidHeaderValue(value)) {
			invalidCredentialErrors.push(
				`${secretEnv} cannot be sent in an HTTP header: it must contain only printable ASCII characters with no line breaks or leading/trailing whitespace.`,
			)
			continue
		}
		const packedBytes = utf8ByteLength(packAlchemyConfigEnvValue(value))
		if (packedBytes > CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES) {
			invalidCredentialErrors.push(
				`${secretEnv} encodes to ${packedBytes} UTF-8 bytes, exceeding Cloudflare Workers' ${CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES}-byte secret limit.`,
			)
		}
	}

	const missingCredentialErrors: Array<string> = []
	for (const custom of customProviders) {
		const check = checkProviderCredentials(custom, { env })
		if (!check.ok) {
			missingCredentialErrors.push(check.message)
		}
	}

	return {
		ok: invalidCredentialErrors.length === 0 && missingCredentialErrors.length === 0,
		invalidCredentialErrors,
		missingCredentialErrors,
	}
}

export const assertValidCustomProviderCredentials = (
	customProviders: ReadonlyArray<ProviderSpec>,
	env: Readonly<Record<string, string | undefined>>,
): void => {
	if (customProviders.length === 0) {
		return
	}
	const result = validateCustomProviderCredentials(customProviders, env)
	if (result.invalidCredentialErrors.length > 0) {
		throw new CustomProviderConfigError(result.invalidCredentialErrors.join(" "))
	}
	if (result.missingCredentialErrors.length > 0) {
		throw new CustomProviderConfigError(result.missingCredentialErrors.join(" "))
	}
}

const parseStaticHeaders = (
	value: unknown,
	providerId: string,
): Readonly<Record<string, string>> | undefined => {
	if (value === undefined) {
		return undefined
	}
	const map = toObjectMap(value)
	if (map === null) {
		throw new CustomProviderConfigError(
			`Custom provider "${providerId}" "headers" must be a JSON object of string values.`,
		)
	}
	const entries: Array<readonly [string, string]> = []
	const seenLower = new Set<string>()
	for (const [headerName, headerValue] of map.entries()) {
		validateHeaderName(headerName, providerId, "headers")
		const lower = headerName.toLowerCase()
		if (seenLower.has(lower)) {
			throw new CustomProviderConfigError(
				`Duplicate header "${headerName}" in custom provider "${providerId}" "headers" (HTTP headers are case-insensitive).`,
			)
		}
		seenLower.add(lower)
		if (typeof headerValue !== "string" || !isValidHeaderValue(headerValue)) {
			throw new CustomProviderConfigError(
				`Custom provider "${providerId}" header "${headerName}" must be a valid HTTP header value containing only printable ASCII characters.`,
			)
		}
		entries.push([headerName, headerValue])
	}
	return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

const parseSecretHeaders = (
	value: unknown,
	providerId: string,
): Readonly<Record<string, string>> | undefined => {
	if (value === undefined) {
		return undefined
	}
	const map = toObjectMap(value)
	if (map === null) {
		throw new CustomProviderConfigError(
			`Custom provider "${providerId}" "secret_headers" must be a JSON object mapping header names to environment variable names.`,
		)
	}
	const entries: Array<readonly [string, string]> = []
	const seenLower = new Set<string>()
	for (const [headerName, envVar] of map.entries()) {
		validateHeaderName(headerName, providerId, "secret_headers")
		const lower = headerName.toLowerCase()
		if (seenLower.has(lower)) {
			throw new CustomProviderConfigError(
				`Duplicate header "${headerName}" in custom provider "${providerId}" "secret_headers" (HTTP headers are case-insensitive).`,
			)
		}
		seenLower.add(lower)
		const validEnv = validateEnvVarName(
			envVar,
			`custom provider "${providerId}" secret_headers["${headerName}"]`,
		)
		entries.push([headerName, validEnv])
	}
	return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

const validateHeaderConflicts = (
	providerId: string,
	auth: ProviderAuthSpec,
	headers: Readonly<Record<string, string>> | undefined,
	secretHeaders: Readonly<Record<string, string>> | undefined,
): void => {
	const primaryAuthHeader =
		auth.kind === "api_key_header"
			? auth.header
			: auth.kind === "bearer"
				? "Authorization"
				: undefined
	const primaryAuthLower = primaryAuthHeader?.toLowerCase()

	const secretHeaderLower = new Set<string>()
	if (secretHeaders !== undefined) {
		for (const headerName of Object.keys(secretHeaders)) {
			const lower = headerName.toLowerCase()
			if (primaryAuthLower !== undefined && lower === primaryAuthLower) {
				throw new CustomProviderConfigError(
					`Header "${headerName}" in custom provider "${providerId}" "secret_headers" conflicts with auth header "${primaryAuthHeader}".`,
				)
			}
			secretHeaderLower.add(lower)
		}
	}

	if (headers !== undefined) {
		for (const headerName of Object.keys(headers)) {
			const lower = headerName.toLowerCase()
			if (primaryAuthLower !== undefined && lower === primaryAuthLower) {
				throw new CustomProviderConfigError(
					`Header "${headerName}" cannot appear in both non-secret "headers" and auth header "${primaryAuthHeader}" for custom provider "${providerId}".`,
				)
			}
			if (secretHeaderLower.has(lower)) {
				throw new CustomProviderConfigError(
					`Header "${headerName}" cannot appear in both non-secret "headers" and "secret_headers" for custom provider "${providerId}".`,
				)
			}
		}
	}
}

const parseAuth = (
	fields: ReadonlyMap<string, unknown>,
	providerId: string,
	providerName: string,
	format: WireFormat,
): ProviderAuthSpec => {
	const rawAuth = fields.get("auth")
	const rawApiKeyEnv = fields.get("api_key_env")
	if (rawAuth !== undefined && rawApiKeyEnv !== undefined) {
		throw new CustomProviderConfigError(
			`Custom provider "${providerId}" cannot specify both "auth" and "api_key_env".`,
		)
	}
	if (rawApiKeyEnv !== undefined) {
		const env = validateEnvVarName(rawApiKeyEnv, `custom provider "${providerId}" api_key_env`)
		return format === "anthropic-messages"
			? {
					kind: "api_key_header",
					header: "x-api-key",
					env,
					label: `${providerName} API key`,
				}
			: {
					kind: "bearer",
					env,
					label: `${providerName} API key`,
				}
	}
	if (rawAuth === undefined) {
		throw new CustomProviderConfigError(
			`Custom provider "${providerId}" must specify "api_key_env" or "auth" (use { "type": "none" } for unauthenticated endpoints).`,
		)
	}
	const authFields = toObjectMap(rawAuth)
	if (authFields === null) {
		throw new CustomProviderConfigError(
			`Custom provider "${providerId}" "auth" must be a JSON object.`,
		)
	}
	for (const key of authFields.keys()) {
		if (FORBIDDEN_INLINE_SECRET_KEYS.has(key)) {
			throw new CustomProviderConfigError(
				`Custom provider "${providerId}" auth must not contain inline secret "${key}". Reference an environment variable via "env" instead.`,
			)
		}
	}
	const authType = authFields.get("type")
	if (authType === "none") {
		for (const key of authFields.keys()) {
			if (key !== "type") {
				throw new CustomProviderConfigError(
					`Custom provider "${providerId}" auth with type "none" does not accept "${key}".`,
				)
			}
		}
		return { kind: "none" }
	}
	if (authType === "bearer") {
		for (const key of authFields.keys()) {
			if (key !== "type" && key !== "env") {
				throw new CustomProviderConfigError(
					`Custom provider "${providerId}" auth with type "bearer" does not accept "${key}".`,
				)
			}
		}
		const env = validateEnvVarName(
			authFields.get("env"),
			`custom provider "${providerId}" auth.env`,
		)
		return { kind: "bearer", env, label: `${providerName} API key` }
	}
	if (authType === "api_key_header") {
		for (const key of authFields.keys()) {
			if (key !== "type" && key !== "header" && key !== "env") {
				throw new CustomProviderConfigError(
					`Custom provider "${providerId}" auth with type "api_key_header" does not accept "${key}".`,
				)
			}
		}
		const rawHeader = authFields.get("header")
		if (typeof rawHeader !== "string" || rawHeader.trim().length === 0) {
			throw new CustomProviderConfigError(
				`Custom provider "${providerId}" auth with type "api_key_header" requires a non-empty "header".`,
			)
		}
		const header = validateHeaderName(rawHeader.trim(), providerId, "auth.header")
		const env = validateEnvVarName(
			authFields.get("env"),
			`custom provider "${providerId}" auth.env`,
		)
		return { kind: "api_key_header", header, env, label: `${providerName} API key` }
	}
	throw new CustomProviderConfigError(
		`Custom provider "${providerId}" has an unsupported "auth.type". Expected "bearer", "api_key_header", or "none".`,
	)
}

const parseModelDefaultsObject = (
	fields: ReadonlyMap<string, unknown>,
	label: string,
	minContextWindow: number,
	minMaxTokens: number,
	inheritedContextWindow?: number,
): ProviderModelDefaults | undefined => {
	let contextWindow: number | undefined
	const rawContextWindow = fields.get("context_window")
	if (rawContextWindow !== undefined) {
		if (
			typeof rawContextWindow !== "number" ||
			!Number.isInteger(rawContextWindow) ||
			rawContextWindow < minContextWindow
		) {
			throw new CustomProviderConfigError(
				`Invalid ${label} "context_window": must be an integer >= ${minContextWindow}.`,
			)
		}
		contextWindow = rawContextWindow
	}
	const effectiveContextWindow =
		contextWindow ?? inheritedContextWindow ?? DEFAULT_SYNTHESIZED_CONTEXT_WINDOW

	let maxTokens: number | undefined
	const rawMaxTokens = fields.get("max_tokens")
	if (rawMaxTokens !== undefined) {
		if (
			typeof rawMaxTokens !== "number" ||
			!Number.isInteger(rawMaxTokens) ||
			rawMaxTokens < minMaxTokens ||
			rawMaxTokens > effectiveContextWindow
		) {
			throw new CustomProviderConfigError(
				`Invalid ${label} "max_tokens": must be an integer between ${minMaxTokens} and ${effectiveContextWindow}.`,
			)
		}
		maxTokens = rawMaxTokens
	}

	let reasoning: boolean | undefined
	const rawReasoning = fields.get("reasoning")
	if (rawReasoning !== undefined) {
		if (typeof rawReasoning !== "boolean") {
			throw new CustomProviderConfigError(`Invalid ${label} "reasoning": must be a boolean.`)
		}
		reasoning = rawReasoning
	}

	let input: ReadonlyArray<"text" | "image"> | undefined
	const rawInput = fields.get("input")
	if (rawInput !== undefined) {
		if (!Array.isArray(rawInput) || rawInput.length === 0) {
			throw new CustomProviderConfigError(
				`Invalid ${label} "input": must be a non-empty array containing "text" and optionally "image".`,
			)
		}
		const modalities: Array<"text" | "image"> = []
		for (const rawItem of rawInput) {
			const item: unknown = rawItem
			if (item !== "text" && item !== "image") {
				throw new CustomProviderConfigError(
					`Invalid ${label} "input" entry: expected "text" or "image".`,
				)
			}
			if (!modalities.includes(item)) {
				modalities.push(item)
			}
		}
		if (!modalities.includes("text")) {
			throw new CustomProviderConfigError(`Invalid ${label} "input": must include "text".`)
		}
		input = modalities
	}

	if (
		contextWindow === undefined &&
		maxTokens === undefined &&
		reasoning === undefined &&
		input === undefined
	) {
		return undefined
	}
	return {
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(reasoning === undefined ? {} : { reasoning }),
		...(input === undefined ? {} : { input }),
	}
}

const parseModelOverrides = (
	value: unknown,
	providerId: string,
	minContextWindow: number,
	minMaxTokens: number,
	inheritedContextWindow?: number,
): Readonly<Record<string, ProviderModelDefaults>> | undefined => {
	if (value === undefined) {
		return undefined
	}
	const modelsMap = toObjectMap(value)
	if (modelsMap === null) {
		throw new CustomProviderConfigError(
			`Custom provider "${providerId}" "models" must be a JSON object keyed by model ID.`,
		)
	}
	const entries: Array<readonly [string, ProviderModelDefaults]> = []
	for (const [modelId, rawModelConfig] of modelsMap.entries()) {
		if (!isValidModelId(modelId) || providerId.length + 1 + modelId.length > MAX_MODEL_ID_LENGTH) {
			throw new CustomProviderConfigError(
				`Invalid model ID in custom provider "${providerId}" models: must be 1..${MAX_MODEL_ID_LENGTH} characters (including "${providerId}/" prefix) without whitespace or control characters.`,
			)
		}
		const modelFields = toObjectMap(rawModelConfig)
		if (modelFields === null) {
			throw new CustomProviderConfigError(
				`Custom provider "${providerId}" models["${modelId}"] must be a JSON object.`,
			)
		}
		for (const key of modelFields.keys()) {
			if (!ALLOWED_MODEL_OVERRIDE_KEYS.has(key)) {
				throw new CustomProviderConfigError(
					`Unknown field "${key}" in custom provider "${providerId}" models["${modelId}"].`,
				)
			}
		}
		const defaults = parseModelDefaultsObject(
			modelFields,
			`custom provider "${providerId}" models["${modelId}"]`,
			minContextWindow,
			minMaxTokens,
			inheritedContextWindow,
		)
		entries.push([modelId, defaults ?? {}])
	}
	return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

const parseProviderEntry = (
	id: string,
	fields: ReadonlyMap<string, unknown>,
	options: {
		readonly allowLoopbackHttp: boolean
		readonly minContextWindow: number
		readonly seenIds: Set<string>
	},
): ProviderSpec => {
	if (!PROVIDER_ID_PATTERN.test(id)) {
		throw new CustomProviderConfigError(
			`Invalid custom provider id "${id}": must match /^[a-z][a-z0-9-]{0,63}$/.`,
		)
	}
	if (isBuiltinProviderId(id)) {
		throw new CustomProviderConfigError(
			`Custom provider id "${id}" collides with a built-in provider.`,
		)
	}
	if (options.seenIds.has(id)) {
		throw new CustomProviderConfigError(`Duplicate custom provider id "${id}".`)
	}
	options.seenIds.add(id)

	for (const key of fields.keys()) {
		if (FORBIDDEN_INLINE_SECRET_KEYS.has(key)) {
			throw new CustomProviderConfigError(
				`Custom provider "${id}" must not contain inline secret "${key}". Put secrets in environment variables and reference them with "api_key_env" or "secret_headers".`,
			)
		}
		if (!ALLOWED_PROVIDER_KEYS.has(key)) {
			throw new CustomProviderConfigError(`Unknown field "${key}" in custom provider "${id}".`)
		}
	}

	const rawName = fields.get("name")
	if (rawName !== undefined && (typeof rawName !== "string" || rawName.trim().length === 0)) {
		throw new CustomProviderConfigError(
			`Custom provider "${id}" "name" must be a non-empty string.`,
		)
	}
	const name = rawName === undefined ? id : rawName.trim()

	const rawFormat = fields.get("format")
	if (typeof rawFormat !== "string" || !isWireFormat(rawFormat)) {
		throw new CustomProviderConfigError(
			`Custom provider "${id}" has an unsupported "format". Expected "openai-responses", "openai-completions", or "anthropic-messages".`,
		)
	}
	const format: WireFormat = rawFormat

	const rawBaseUrl = fields.get("base_url")
	if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim().length === 0) {
		throw new CustomProviderConfigError(`Custom provider "${id}" requires a non-empty "base_url".`)
	}
	let baseUrl: string
	try {
		baseUrl = parseProviderBaseUrl(rawBaseUrl, {
			allowLoopbackHttp: options.allowLoopbackHttp,
			label: `custom provider "${id}" base_url`,
		})
	} catch (error) {
		throw new CustomProviderConfigError(
			error instanceof Error ? error.message : `Invalid base_url for custom provider "${id}".`,
		)
	}

	const auth = parseAuth(fields, id, name, format)
	const headers = parseStaticHeaders(fields.get("headers"), id)
	const secretHeaders = parseSecretHeaders(fields.get("secret_headers"), id)
	validateHeaderConflicts(id, auth, headers, secretHeaders)
	const minMaxTokens = minMaxTokensForFormat(format)
	const modelDefaults = parseModelDefaultsObject(
		fields,
		`custom provider "${id}"`,
		options.minContextWindow,
		minMaxTokens,
	)
	const models = parseModelOverrides(
		fields.get("models"),
		id,
		options.minContextWindow,
		minMaxTokens,
		modelDefaults?.contextWindow,
	)

	let defaultModel: string | undefined
	const rawDefaultModel = fields.get("default_model")
	if (rawDefaultModel !== undefined) {
		if (typeof rawDefaultModel !== "string" || !isValidModelId(rawDefaultModel)) {
			throw new CustomProviderConfigError(
				`Custom provider "${id}" "default_model" must be a non-empty model ID without whitespace or control characters.`,
			)
		}
		const prefix = `${id}/`
		const wireModelId =
			models !== undefined && ownProperty(models, rawDefaultModel) !== undefined
				? rawDefaultModel
				: rawDefaultModel.startsWith(prefix)
					? rawDefaultModel.slice(prefix.length)
					: rawDefaultModel
		if (!isValidModelId(wireModelId) || prefix.length + wireModelId.length > MAX_MODEL_ID_LENGTH) {
			throw new CustomProviderConfigError(
				`Custom provider "${id}" "default_model" must resolve to a non-empty model ID of at most ${MAX_MODEL_ID_LENGTH} total characters including "${prefix}".`,
			)
		}
		defaultModel = `${prefix}${wireModelId}`
	} else if (models !== undefined) {
		const firstDeclared = Object.keys(models)[0]
		if (firstDeclared !== undefined) {
			defaultModel = `${id}/${firstDeclared}`
		}
	}

	return {
		id,
		name,
		source: "custom",
		...(defaultModel === undefined ? {} : { defaultModel }),
		defaultFormat: format,
		formats: [format],
		baseUrl,
		auth,
		...(headers === undefined ? {} : { headers }),
		...(secretHeaders === undefined ? {} : { secretHeaders }),
		resolveBareModelIds: false,
		allowUnlistedModels: true,
		...(modelDefaults === undefined ? {} : { modelDefaults }),
		...(models === undefined ? {} : { models }),
	}
}

export interface ParseCustomProvidersOptions {
	readonly allowLoopbackHttp?: boolean
	readonly minContextWindow?: number
}

/**
 * Parses and validates a non-secret JSON provider manifest (from `CHECKFU_PROVIDERS`).
 * Accepts either a JSON object keyed by provider ID (`{ "xai": { ... } }`) or a JSON
 * array of provider objects (`[{ "id": "xai", ... }]`).
 *
 * Inline secrets (`api_key`, `token`, `secret`, auth headers in plain `headers`) and
 * reserved platform env var references (`CHECKFU_*`, `ALCHEMY_*`, `CLOUDFLARE_API_KEY`,
 * `CLOUDFLARE_API_TOKEN`) are refused fail-closed.
 */
export const parseCustomProvidersManifest = (
	raw: string,
	options?: ParseCustomProvidersOptions,
): ReadonlyArray<ProviderSpec> => {
	const trimmed = raw.trim()
	if (trimmed.length === 0) {
		return []
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch (error) {
		throw new CustomProviderConfigError(formatSafeJsonParseError(CUSTOM_PROVIDERS_ENV, error))
	}
	assertNoDuplicateJsonKeys(trimmed, CUSTOM_PROVIDERS_ENV)
	const allowLoopbackHttp = options?.allowLoopbackHttp ?? false
	const minContextWindow = options?.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW
	const seenIds = new Set<string>()
	const specs: Array<ProviderSpec> = []

	if (Array.isArray(parsed)) {
		for (let i = 0; i < parsed.length; i += 1) {
			const itemFields = toObjectMap(parsed[i])
			if (itemFields === null) {
				throw new CustomProviderConfigError(`${CUSTOM_PROVIDERS_ENV}[${i}] must be a JSON object.`)
			}
			const rawId = itemFields.get("id")
			if (typeof rawId !== "string" || rawId.trim().length === 0) {
				throw new CustomProviderConfigError(
					`${CUSTOM_PROVIDERS_ENV}[${i}] requires a non-empty string "id".`,
				)
			}
			specs.push(
				parseProviderEntry(rawId.trim(), itemFields, {
					allowLoopbackHttp,
					minContextWindow,
					seenIds,
				}),
			)
		}
		return specs
	}

	const rootMap = toObjectMap(parsed)
	if (rootMap !== null) {
		for (const [id, entry] of rootMap.entries()) {
			const entryFields = toObjectMap(entry)
			if (entryFields === null) {
				throw new CustomProviderConfigError(
					`Custom provider "${id}" in ${CUSTOM_PROVIDERS_ENV} must be a JSON object.`,
				)
			}
			const nestedId = entryFields.get("id")
			if (nestedId !== undefined && nestedId !== id) {
				throw new CustomProviderConfigError(
					`Custom provider "${id}" has a mismatched nested "id" field.`,
				)
			}
			specs.push(
				parseProviderEntry(id, entryFields, {
					allowLoopbackHttp,
					minContextWindow,
					seenIds,
				}),
			)
		}
		return specs
	}

	throw new CustomProviderConfigError(
		`${CUSTOM_PROVIDERS_ENV} must be a JSON object keyed by provider ID or a JSON array of provider objects.`,
	)
}

/**
 * Serializes a stripped, header-free validation projection of custom providers
 * safe to bind onto public API Workers (`CHECKFU_PROVIDER_CATALOG`). Omits
 * `headers`, `secret_headers`, `auth`, and `base_url` completely.
 */
export const serializeCustomProviderCatalog = (providers: ReadonlyArray<ProviderSpec>): string =>
	JSON.stringify(
		providers.map((provider) => ({
			id: provider.id,
			name: provider.name,
			format: provider.defaultFormat,
			...(provider.defaultModel === undefined ? {} : { default_model: provider.defaultModel }),
			...(provider.allowUnlistedModels === undefined
				? {}
				: { allow_unlisted_models: provider.allowUnlistedModels }),
			...(provider.modelDefaults?.contextWindow === undefined
				? {}
				: { context_window: provider.modelDefaults.contextWindow }),
			...(provider.modelDefaults?.maxTokens === undefined
				? {}
				: { max_tokens: provider.modelDefaults.maxTokens }),
			...(provider.modelDefaults?.reasoning === undefined
				? {}
				: { reasoning: provider.modelDefaults.reasoning }),
			...(provider.modelDefaults?.input === undefined
				? {}
				: { input: provider.modelDefaults.input }),
			...(provider.models === undefined
				? {}
				: {
						models: Object.fromEntries(
							Object.entries(provider.models).map(([modelId, defaults]) => [
								modelId,
								{
									...(defaults.contextWindow === undefined
										? {}
										: { context_window: defaults.contextWindow }),
									...(defaults.maxTokens === undefined ? {} : { max_tokens: defaults.maxTokens }),
									...(defaults.reasoning === undefined ? {} : { reasoning: defaults.reasoning }),
									...(defaults.input === undefined ? {} : { input: defaults.input }),
								},
							]),
						),
					}),
		})),
	)

/**
 * Parses a stripped validation-only provider projection produced by
 * `serializeCustomProviderCatalog` (rejecting any headers, auth, or base URLs).
 */
export const parseCustomProviderCatalog = (
	raw: string,
	options?: { readonly minContextWindow?: number },
): ReadonlyArray<ProviderSpec> => {
	const trimmed = raw.trim()
	if (trimmed.length === 0) {
		return []
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch (error) {
		throw new CustomProviderConfigError(
			formatSafeJsonParseError(CUSTOM_PROVIDER_CATALOG_ENV, error),
		)
	}
	assertNoDuplicateJsonKeys(trimmed, CUSTOM_PROVIDER_CATALOG_ENV)
	if (!Array.isArray(parsed)) {
		throw new CustomProviderConfigError(`${CUSTOM_PROVIDER_CATALOG_ENV} must be a JSON array.`)
	}
	const minContextWindow = options?.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW
	const seenIds = new Set<string>()
	const specs: Array<ProviderSpec> = []
	for (let i = 0; i < parsed.length; i += 1) {
		const fields = toObjectMap(parsed[i])
		if (fields === null) {
			throw new CustomProviderConfigError(
				`${CUSTOM_PROVIDER_CATALOG_ENV}[${i}] must be a JSON object.`,
			)
		}
		for (const key of fields.keys()) {
			if (!ALLOWED_CATALOG_PROJECTION_KEYS.has(key)) {
				throw new CustomProviderConfigError(
					`Disallowed field "${key}" in ${CUSTOM_PROVIDER_CATALOG_ENV}[${i}].`,
				)
			}
		}
		const rawId = fields.get("id")
		if (typeof rawId !== "string" || !PROVIDER_ID_PATTERN.test(rawId)) {
			throw new CustomProviderConfigError(
				`Invalid provider id in ${CUSTOM_PROVIDER_CATALOG_ENV}[${i}].`,
			)
		}
		if (isBuiltinProviderId(rawId) || seenIds.has(rawId)) {
			throw new CustomProviderConfigError(
				`Invalid or duplicate provider id "${rawId}" in ${CUSTOM_PROVIDER_CATALOG_ENV}.`,
			)
		}
		seenIds.add(rawId)

		const rawName = fields.get("name")
		const name = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : rawId

		const rawFormat = fields.get("format")
		if (typeof rawFormat !== "string" || !isWireFormat(rawFormat)) {
			throw new CustomProviderConfigError(
				`Invalid "format" for provider "${rawId}" in ${CUSTOM_PROVIDER_CATALOG_ENV}.`,
			)
		}
		const format: WireFormat = rawFormat

		const rawAllowUnlisted = fields.get("allow_unlisted_models")
		if (rawAllowUnlisted !== undefined && typeof rawAllowUnlisted !== "boolean") {
			throw new CustomProviderConfigError(
				`Invalid allow_unlisted_models for provider "${rawId}" in ${CUSTOM_PROVIDER_CATALOG_ENV}.`,
			)
		}

		const minMaxTokens = minMaxTokensForFormat(format)
		const modelDefaults = parseModelDefaultsObject(
			fields,
			`catalog provider "${rawId}"`,
			minContextWindow,
			minMaxTokens,
		)
		const models = parseModelOverrides(
			fields.get("models"),
			rawId,
			minContextWindow,
			minMaxTokens,
			modelDefaults?.contextWindow,
		)
		let defaultModel: string | undefined
		const rawDefaultModel = fields.get("default_model")
		if (rawDefaultModel !== undefined) {
			const prefix = `${rawId}/`
			if (
				typeof rawDefaultModel !== "string" ||
				rawDefaultModel.length > MAX_MODEL_ID_LENGTH ||
				!rawDefaultModel.startsWith(prefix) ||
				!isValidModelId(rawDefaultModel.slice(prefix.length))
			) {
				throw new CustomProviderConfigError(
					`Invalid default_model for provider "${rawId}" in ${CUSTOM_PROVIDER_CATALOG_ENV}.`,
				)
			}
			defaultModel = rawDefaultModel
		}

		specs.push(
			markCatalogOnlyProviderSpec({
				id: rawId,
				name,
				source: "custom",
				...(defaultModel === undefined ? {} : { defaultModel }),
				defaultFormat: format,
				formats: [format],
				auth: { kind: "none" },
				resolveBareModelIds: false,
				allowUnlistedModels: rawAllowUnlisted ?? true,
				...(modelDefaults === undefined ? {} : { modelDefaults }),
				...(models === undefined ? {} : { models }),
			}),
		)
	}
	return specs
}
