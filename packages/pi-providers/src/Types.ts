import type {
	AnthropicMessagesCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai"

export const WIRE_FORMATS = [
	"anthropic-messages",
	"openai-responses",
	"openai-completions",
] as const

export type WireFormat = (typeof WIRE_FORMATS)[number]

export const isWireFormat = (value: string): value is WireFormat =>
	value === "anthropic-messages" || value === "openai-responses" || value === "openai-completions"

export const MAX_MODEL_ID_LENGTH = 256
export const DEFAULT_MIN_CONTEXT_WINDOW = 65_536
export const DEFAULT_SYNTHESIZED_CONTEXT_WINDOW = 128_000
export const DEFAULT_SYNTHESIZED_MAX_TOKENS = 16_384

export const ownProperty = <T>(
	record: Readonly<Record<string, T>> | undefined,
	key: string,
): T | undefined => (record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined)

export type ProviderAuthSpec =
	| {
			readonly kind: "bearer"
			readonly env: string
			readonly label: string
			readonly keyPrefixes?: ReadonlyArray<string>
	  }
	| {
			readonly kind: "api_key_header"
			readonly header: string
			readonly env: string
			readonly label: string
			readonly keyPrefixes?: ReadonlyArray<string>
	  }
	| {
			readonly kind: "none"
	  }
	| {
			readonly kind: "cloudflare_ai_gateway"
			readonly apiKeyEnv: string
			readonly accountIdEnv: string
			readonly gatewayIdEnv: string
	  }
	| {
			readonly kind: "cloudflare_workers_ai"
			readonly apiKeyEnv: string
			readonly accountIdEnv: string
	  }

export interface ProviderModelDefaults {
	readonly contextWindow?: number
	readonly maxTokens?: number
	readonly reasoning?: boolean
	readonly thinkingLevelMap?: ThinkingLevelMap
	readonly input?: ReadonlyArray<"text" | "image">
	readonly openAICompletionsCompat?: OpenAICompletionsCompat
	readonly openAIResponsesCompat?: OpenAIResponsesCompat
	readonly anthropicMessagesCompat?: AnthropicMessagesCompat
}

export interface ProviderSpec {
	readonly id: string
	readonly name: string
	readonly source: "builtin" | "custom"
	readonly defaultModel?: string
	readonly defaultFormat: WireFormat
	readonly formats: ReadonlyArray<WireFormat>
	readonly baseUrl?: string
	readonly auth: ProviderAuthSpec
	readonly headers?: Readonly<Record<string, string>>
	readonly secretHeaders?: Readonly<Record<string, string>>
	readonly resolveBareModelIds?: boolean
	readonly allowUnlistedModels?: boolean
	readonly modelDefaults?: ProviderModelDefaults
	readonly models?: Readonly<Record<string, ProviderModelDefaults>>
}

export interface ResolvedModelSpecifier {
	readonly provider: string
	readonly modelId: string
	readonly cataloged: boolean
}

export interface CloudflareAiBindingLike {
	readonly fetch?: typeof fetch
}

export interface ProviderRuntimeConfig {
	readonly env: Readonly<Record<string, string | undefined>>
	readonly aiBinding?: CloudflareAiBindingLike | null
	readonly baseUrlOverrides?: Readonly<Record<string, string | null | undefined>>
	readonly customProviders?: ReadonlyArray<ProviderSpec>
	readonly minContextWindow?: number
}

export type ProviderCredentialCheck =
	| { readonly ok: true }
	| { readonly ok: false; readonly missing: ReadonlyArray<string>; readonly message: string }
