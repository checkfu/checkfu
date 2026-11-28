import * as Cloudflare from "@alchemy.run/cloudflare"
import type { ProviderCredentialCheck, ProviderRuntimeConfig } from "@checkfu/pi-providers/catalog"
import { createProviderModels } from "@checkfu/pi-providers/runtime"
import type { MutableModels } from "@earendil-works/pi-ai/models"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { checkCatalogProviderCredentials, configuredCustomProviders } from "./PiCatalog.ts"
import {
	extractAiBinding,
	loadProviderApiKeys,
	providerBaseUrls,
	toProviderRuntimeConfig,
} from "./PiModels.ts"

export interface PiProviderSessionContext {
	readonly sessionId: string
}

/** Operation admitted by the native runtime, available even when the Pi harness reopens. */
export interface PiProviderOperationContext {
	readonly currentOperationId: () => string | null
}

export interface PiSessionProviders {
	readonly createModels: (operation?: PiProviderOperationContext) => MutableModels
	readonly checkCredentials: (provider: string) => ProviderCredentialCheck
}

export interface PiProviderRuntimeService {
	readonly forSession: (context: PiProviderSessionContext) => Effect.Effect<PiSessionProviders>
}

export class PiProviderRuntime extends Context.Service<
	PiProviderRuntime,
	PiProviderRuntimeService
>()("@checkfu/api/PiProviderRuntime") {}

export const staticPiProviderRuntime = (
	config: ProviderRuntimeConfig,
): PiProviderRuntimeService => ({
	forSession: () =>
		Effect.succeed({
			createModels: () => createProviderModels(config),
			checkCredentials: (provider) =>
				checkCatalogProviderCredentials(provider, config, config.customProviders),
		}),
})

/**
 * Loads provider credentials, custom provider definitions, and local-dev loopback
 * base URL overrides from the Worker environment, capturing the corresponding
 * Alchemy secret and config bindings during plan time.
 */
export const loadEnvPiProviderRuntime = Effect.gen(function* () {
	const workerEnv = yield* Effect.serviceOption(Cloudflare.Workers.WorkerEnvironment)
	const customProviders = yield* configuredCustomProviders
	const apiKeys = yield* loadProviderApiKeys(customProviders)
	const baseUrls = yield* providerBaseUrls
	return PiProviderRuntime.of({
		forSession: () => {
			const aiBinding = extractAiBinding(Option.getOrUndefined(workerEnv))
			const config = toProviderRuntimeConfig(apiKeys, baseUrls, { aiBinding, customProviders })
			return Effect.succeed({
				createModels: () => createProviderModels(config),
				checkCredentials: (provider: string) =>
					checkCatalogProviderCredentials(provider, config, customProviders),
			})
		},
	})
})

export const EnvPiProviderRuntimeLive = Layer.effect(PiProviderRuntime, loadEnvPiProviderRuntime)
