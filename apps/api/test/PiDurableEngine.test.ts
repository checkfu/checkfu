import { NO_AGENT_TOOLS, NO_MCP_SERVERS } from "@checkfu/domain/Mcp/McpServers"
import { createServer } from "node:http"
import { PassThrough } from "node:stream"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/domain/Agent/AgentVersion.id"
import { CreateAgent } from "@checkfu/domain/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/domain/Agent/CreateAgent.decision"
import { Harness } from "@checkfu/domain/Session/Harness.external"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { describe, expect, it, vi } from "@effect/vitest"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { RuntimeContext, packEnvValue } from "alchemy/RuntimeContext"
import type { BaseRuntimeContext } from "alchemy/RuntimeContext"
import { Stage } from "alchemy/Stage"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Logger from "effect/Logger"
import * as Redacted from "effect/Redacted"
import * as References from "effect/References"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
	PI_HARNESS_SETTINGS,
} from "../src/Pi/PiContextBudget.ts"
import {
	CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES,
	packAlchemyConfigEnvValue,
	parseCustomProvidersManifest,
	serializeCustomProviderCatalog,
	utf8ByteLength,
} from "@checkfu/pi-providers/catalog"
import {
	CUSTOM_PROVIDERS_ENV,
	CUSTOM_PROVIDER_CATALOG_ENV,
	apiWorkerCustomProvidersProps,
	configuredCustomProviders,
	resolveCatalogModel,
} from "../src/Pi/PiCatalog.ts"
import {
	AbortGrace,
	RestoredHistoryLimit,
	abortPiDurableTurn,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../src/Pi/PiDurableEngine.ts"
import type { PiDurableBackend } from "../src/Pi/PiDurableEngine.ts"
import type { PiTurnOutcome, PiTurnRequest } from "../src/Pi/PiTurn.ts"
import {
	CLOUDFLARE_AI_GATEWAY_BASE_URL_ENV,
	CLOUDFLARE_WORKERS_AI_BASE_URL_ENV,
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_OPENAI_BASE_URL,
	LOCAL_DEV_SIGNAL_ENV,
	LOCAL_DEV_SIGNAL_VALUE,
	OPENAI_BASE_URL_ENV,
	OPENROUTER_BASE_URL_ENV,
	createNoRedirectProviderFetch,
	createPiModels,
	loadProviderApiKeys,
	parseLoopbackBaseUrl,
	providerBaseUrls,
} from "../src/Pi/PiModels.ts"
import {
	PROVIDER_FAILURE_MESSAGE,
	createCheckfuRegistry,
	isProviderRefusalStopReason,
	isRefusalAssistantMessage,
	mapAssistantMessageToOutcome,
} from "../src/Pi/PiRefusals.ts"
import { makePiHarnessBackend } from "../src/Pi/PiSession.do.ts"
import {
	AUTH_HEADERS,
	TEST_API_KEY,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	makeScriptedPiModels,
	providerError,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"
import type { InMemoryPiDurableBackend, InMemoryStorage } from "./helpers/InMemoryPiBackend.ts"
import {
	measurePause,
	observePauseWait,
	reportPauseMeasurement,
	waitForPauseProbe,
} from "./helpers/PiPauseProbe.ts"

describe("PiDurableEngine storage, compaction, and provider error classification", () => {
	it("supports OpenAI + Anthropic only and surfaces missing_api_key_error / unknown_model_error", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(
			async (model) => makeAssistantReply(model, null, "unused", 1, 1),
			{ env: { CHECKFU_API_KEY: TEST_API_KEY } },
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const provider = yield* Harness

					const openaiRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "OpenAI Agent", model: "gpt-4o-mini" },
					})
					const openaiAgent = (yield* Effect.promise(() => openaiRes.json())) as { id: string }

					const geminiRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Unsupported Provider Agent", model: "gemini-2.5-flash" },
					})
					expect(geminiRes.status).toBe(400)
					const geminiAgent = { id: AgentId.make("agent_unsupported_model") }
					const createUnsupported = yield* CreateAgentDecision
					yield* createUnsupported.send(
						new CreateAgent({
							mcp_servers: NO_MCP_SERVERS,
							tools: NO_AGENT_TOOLS,
							agent_id: geminiAgent.id,
							version_id: AgentVersionId.make("aver_unsupported_model"),
							name: "Unsupported Provider Agent",
							model: { id: "gemini-2.5-flash" },
							system: null,
							description: null,
						}),
					)

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Model Check Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const missingKeyErr = yield* Effect.flip(
						provider.runTurn({
							last_reply_turn: 0,
							segment: 1,
							session_id: SessionId.make("sess_test"),
							agent_id: openaiAgent.id,
							agent_version: 1,
							environment_id: env.id,
							resources: [],
							turn: 1,
							input: ["Hi"],
						}),
					)
					expect(providerError(missingKeyErr).error_type).toBe("missing_api_key_error")
					expect(providerError(missingKeyErr).terminal).toBe(false)

					const unsupportedModelErr = yield* Effect.flip(
						provider.runTurn({
							last_reply_turn: 0,
							segment: 1,
							session_id: SessionId.make("sess_test"),
							agent_id: geminiAgent.id,
							agent_version: 1,
							environment_id: "env_1",
							resources: [],
							turn: 1,
							input: ["Hi"],
						}),
					)
					expect(providerError(unsupportedModelErr).error_type).toBe("unknown_model_error")
					expect(providerError(unsupportedModelErr).terminal).toBe(true)

					// OpenRouter and Cloudflare AI Gateway agents validate cleanly and report missing credentials.
					const openRouterRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "OpenRouter Agent", model: "openrouter/google/gemini-2.5-pro" },
					})
					expect(openRouterRes.status).toBe(201)
					const openRouterAgent = (yield* Effect.promise(() => openRouterRes.json())) as {
						id: string
					}
					const missingOpenRouter = yield* Effect.flip(
						provider.runTurn({
							last_reply_turn: 0,
							segment: 1,
							session_id: SessionId.make("sess_openrouter_missing"),
							agent_id: openRouterAgent.id,
							agent_version: 1,
							environment_id: env.id,
							turn: 1,
							input: ["Hi"],
							resources: [],
						}),
					)
					expect(providerError(missingOpenRouter).error_type).toBe("missing_api_key_error")
					expect(providerError(missingOpenRouter).message).toContain("OPENROUTER_API_KEY")

					const gatewayRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Gateway Agent", model: "cloudflare-ai-gateway/claude-sonnet-5-5" },
					})
					expect(gatewayRes.status).toBe(201)
					const gatewayAgent = (yield* Effect.promise(() => gatewayRes.json())) as { id: string }
					const missingGateway = yield* Effect.flip(
						provider.runTurn({
							last_reply_turn: 0,
							segment: 1,
							session_id: SessionId.make("sess_gateway_missing"),
							agent_id: gatewayAgent.id,
							agent_version: 1,
							environment_id: env.id,
							turn: 1,
							input: ["Hi"],
							resources: [],
						}),
					)
					expect(providerError(missingGateway).error_type).toBe("missing_api_key_error")
					expect(providerError(missingGateway).message).toContain("CLOUDFLARE_GATEWAY_ID")
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("runs turns end to end on OpenRouter and Cloudflare AI Gateway agents", async () => {
		const seenModels: Array<{
			readonly provider: string
			readonly modelId: string
			readonly api: string
		}> = []
		const { layer, closeAll } = makePiDurableTestLayer(
			async (model) => {
				seenModels.push({ provider: model.provider, modelId: model.id, api: model.api })
				return makeAssistantReply(model, null, `reply from ${model.provider}/${model.id}`, 10, 5)
			},
			{
				env: {
					CHECKFU_API_KEY: TEST_API_KEY,
					OPENROUTER_API_KEY: "sk-or-v1-test",
					CLOUDFLARE_AI_API_KEY: "cf-key-test",
					CLOUDFLARE_ACCOUNT_ID: "acct-test",
					CLOUDFLARE_GATEWAY_ID: "gw-test",
				},
			},
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const provider = yield* Harness
					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Multi-provider Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const orAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "OR Agent", model: "openrouter/anthropic/claude-sonnet-5.5" },
					})
					expect(orAgentRes.status).toBe(201)
					const orAgent = (yield* Effect.promise(() => orAgentRes.json())) as { id: string }
					const orReply = yield* provider.runTurn({
						last_reply_turn: 0,
						segment: 1,
						session_id: SessionId.make("sess_or"),
						agent_id: orAgent.id,
						agent_version: 1,
						environment_id: env.id,
						turn: 1,
						input: ["Hello OpenRouter"],
						resources: [],
					})
					expect(orReply.text).toBe("reply from openrouter/anthropic/claude-sonnet-5.5")

					const gwAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "GW Agent", model: "cloudflare-ai-gateway/anthropic/claude-sonnet-5-5" },
					})
					expect(gwAgentRes.status).toBe(201)
					const gwAgent = (yield* Effect.promise(() => gwAgentRes.json())) as { id: string }
					const gwReply = yield* provider.runTurn({
						last_reply_turn: 0,
						segment: 1,
						session_id: SessionId.make("sess_gw"),
						agent_id: gwAgent.id,
						agent_version: 1,
						environment_id: env.id,
						turn: 1,
						input: ["Hello Gateway"],
						resources: [],
					})
					expect(gwReply.text).toBe("reply from cloudflare-ai-gateway/claude-sonnet-5-5")

					const gwFineTuneRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: {
							name: "GW Fine-tune Agent",
							model: "cloudflare-ai-gateway/openai/ft:gpt-4o-mini:org:pilot:id",
						},
					})
					expect(gwFineTuneRes.status).toBe(201)
					const gwFineTuneAgent = (yield* Effect.promise(() => gwFineTuneRes.json())) as {
						id: string
					}
					const gwFineTuneReply = yield* provider.runTurn({
						last_reply_turn: 0,
						segment: 1,
						session_id: SessionId.make("sess_gw_ft"),
						agent_id: gwFineTuneAgent.id,
						agent_version: 1,
						environment_id: env.id,
						turn: 1,
						input: ["Hello Fine-tune"],
						resources: [],
					})
					expect(gwFineTuneReply.text).toBe(
						"reply from cloudflare-ai-gateway/ft:gpt-4o-mini:org:pilot:id",
					)

					expect(seenModels).toEqual([
						{
							provider: "openrouter",
							modelId: "anthropic/claude-sonnet-5.5",
							api: "anthropic-messages",
						},
						{
							provider: "cloudflare-ai-gateway",
							modelId: "claude-sonnet-5-5",
							api: "anthropic-messages",
						},
						{
							provider: "cloudflare-ai-gateway",
							modelId: "ft:gpt-4o-mini:org:pilot:id",
							api: "openai-responses",
						},
					])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("supports custom format-compatible providers via CHECKFU_PROVIDERS with loopback gated to local dev", async () => {
		const manifest = JSON.stringify({
			xai: {
				name: "xAI",
				format: "openai-responses",
				base_url: "https://api.x.ai/v1",
				api_key_env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
				secret_headers: { "x-gw-token": "CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN" },
				default_model: "grok-4",
			},
		})
		const { layer, closeAll } = makePiDurableTestLayer(
			async (model) =>
				makeAssistantReply(model, null, `custom reply: ${model.provider}/${model.id}`, 8, 4),
			{
				env: {
					CHECKFU_API_KEY: TEST_API_KEY,
					[CUSTOM_PROVIDERS_ENV]: manifest,
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "xai-secret-key",
					CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "xai-gw-secret",
				},
			},
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const provider = yield* Harness
					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Custom Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "xAI Agent", model: "xai/grok-4" },
					})
					expect(agentRes.status).toBe(201)
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
					const reply = yield* provider.runTurn({
						last_reply_turn: 0,
						segment: 1,
						session_id: SessionId.make("sess_xai"),
						agent_id: agent.id,
						agent_version: 1,
						environment_id: env.id,
						turn: 1,
						input: ["Hello xAI"],
						resources: [],
					})
					expect(reply.text).toBe("custom reply: xai/grok-4")
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}

		// Loopback HTTP custom providers are refused outside non-production local dev.
		const loopbackManifest = JSON.stringify({
			ollama: {
				format: "openai-completions",
				base_url: "http://127.0.0.1:11434/v1",
				auth: { type: "none" },
			},
		})
		const runCustomConfig = (env: Record<string, string>) =>
			Effect.runPromiseExit(
				configuredCustomProviders.pipe(
					Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
				),
			)
		const deniedWithoutSignal = await runCustomConfig({
			[CUSTOM_PROVIDERS_ENV]: loopbackManifest,
		})
		expect(Exit.isFailure(deniedWithoutSignal)).toBe(true)

		const deniedInProd = await runCustomConfig({
			ALCHEMY_STAGE: "production",
			[LOCAL_DEV_SIGNAL_ENV]: LOCAL_DEV_SIGNAL_VALUE,
			[CUSTOM_PROVIDERS_ENV]: loopbackManifest,
		})
		expect(Exit.isFailure(deniedInProd)).toBe(true)

		const allowedInLocalDev = await runCustomConfig({
			ALCHEMY_STAGE: "dev-local",
			[LOCAL_DEV_SIGNAL_ENV]: LOCAL_DEV_SIGNAL_VALUE,
			[CUSTOM_PROVIDERS_ENV]: loopbackManifest,
		})
		expect(Exit.isSuccess(allowedInLocalDev)).toBe(true)
		if (Exit.isSuccess(allowedInLocalDev)) {
			expect(allowedInLocalDev.value[0]?.id).toBe("ollama")
		}

		// Plan-time Worker binding size limits reject oversized CHECKFU_PROVIDERS and
		// CHECKFU_PROVIDER_CATALOG payloads (> 5,120 UTF-8 bytes) before Cloudflare deploy.
		const runPlan = <A>(
			effect: Effect.Effect<A, never, AlchemyContext | Stage>,
			env: Record<string, string>,
			dev = false,
		) =>
			Effect.runPromiseExit(
				effect.pipe(
					Effect.provideService(AlchemyContext, {
						dotAlchemy: ".alchemy",
						dev,
						adopt: false,
					}),
					Effect.provideService(Stage, dev ? "dev-local" : "live"),
					Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
				),
			)

		const validPlanProps = await runPlan(apiWorkerCustomProvidersProps, {
			[CUSTOM_PROVIDERS_ENV]: manifest,
		})
		expect(Exit.isSuccess(validPlanProps)).toBe(true)
		expect(packAlchemyConfigEnvValue(manifest)).toBe(packEnvValue(Redacted.make(manifest)))

		// Manifest under 5,120 raw bytes with a tiny API catalog projection, whose Alchemy-packed
		// Redacted config binding exceeds 5,120 UTF-8 bytes due to JSON wrapper + quote escaping.
		const packedOverflowManifest = JSON.stringify({
			acme: {
				format: "openai-responses",
				base_url: "https://api.acme.example/v1",
				auth: { type: "none" },
				headers: Object.fromEntries(
					Array.from({ length: 300 }, (_, index) => [`x-h-${String(index).padStart(3, "0")}`, "v"]),
				),
			},
		})
		expect(utf8ByteLength(packedOverflowManifest)).toBeLessThan(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES)
		expect(
			utf8ByteLength(
				serializeCustomProviderCatalog(parseCustomProvidersManifest(packedOverflowManifest)),
			),
		).toBeLessThan(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES)
		expect(utf8ByteLength(packEnvValue(Redacted.make(packedOverflowManifest)))).toBeGreaterThan(
			CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES,
		)
		const harnessPackedExit = await runPlan(configuredCustomProviders, {
			[CUSTOM_PROVIDERS_ENV]: packedOverflowManifest,
		})
		expect(Exit.isFailure(harnessPackedExit)).toBe(true)
		if (Exit.isFailure(harnessPackedExit)) {
			expect(String(harnessPackedExit.cause)).toContain(CUSTOM_PROVIDERS_ENV)
			expect(String(harnessPackedExit.cause)).toContain(String(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES))
		}
		const apiPackedExit = await runPlan(apiWorkerCustomProvidersProps, {
			[CUSTOM_PROVIDERS_ENV]: packedOverflowManifest,
		})
		expect(Exit.isFailure(apiPackedExit)).toBe(true)
		if (Exit.isFailure(apiPackedExit)) {
			expect(String(apiPackedExit.cause)).toContain(CUSTOM_PROVIDERS_ENV)
			expect(String(apiPackedExit.cause)).toContain(String(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES))
		}

		// Multi-byte UTF-8 provider name (< 5,120 UTF-16 code units, > 5,120 UTF-8 bytes)
		const oversizedRawManifest = JSON.stringify({
			acme: {
				name: "東".repeat(1750),
				format: "openai-responses",
				base_url: "https://api.acme.example/v1",
				auth: { type: "none" },
			},
		})
		expect(oversizedRawManifest.length).toBeLessThan(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES)
		expect(utf8ByteLength(oversizedRawManifest)).toBeGreaterThan(
			CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES,
		)
		for (const dev of [false, true]) {
			const harnessRawExit = await runPlan(
				configuredCustomProviders,
				{ [CUSTOM_PROVIDERS_ENV]: oversizedRawManifest },
				dev,
			)
			expect(Exit.isFailure(harnessRawExit)).toBe(true)
			if (Exit.isFailure(harnessRawExit)) {
				expect(String(harnessRawExit.cause)).toContain(CUSTOM_PROVIDERS_ENV)
				expect(String(harnessRawExit.cause)).toContain(String(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES))
			}
			const apiRawExit = await runPlan(
				apiWorkerCustomProvidersProps,
				{ [CUSTOM_PROVIDERS_ENV]: oversizedRawManifest },
				dev,
			)
			expect(Exit.isFailure(apiRawExit)).toBe(true)
			if (Exit.isFailure(apiRawExit)) {
				expect(String(apiRawExit.cause)).toContain(CUSTOM_PROVIDERS_ENV)
				expect(String(apiRawExit.cause)).toContain(String(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES))
			}
		}

		// Manifest whose packed CHECKFU_PROVIDERS binding is <= 5,120 bytes while its plain
		// serialized CHECKFU_PROVIDER_CATALOG projection exceeds 5,120 bytes.
		const catalogExpansionManifest = JSON.stringify(
			Object.fromEntries(
				Array.from({ length: 31 }, (_, index) => [
					`provider-${String(index).padStart(2, "0")}-${"x".repeat(46)}`,
					{
						format: "openai-responses",
						base_url: "https://a.co",
						auth: { type: "none" },
					},
				]),
			),
		)
		expect(
			utf8ByteLength(packEnvValue(Redacted.make(catalogExpansionManifest))),
		).toBeLessThanOrEqual(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES)
		expect(
			utf8ByteLength(
				serializeCustomProviderCatalog(parseCustomProvidersManifest(catalogExpansionManifest)),
			),
		).toBeGreaterThan(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES)
		const harnessCatalogExit = await runPlan(configuredCustomProviders, {
			[CUSTOM_PROVIDERS_ENV]: catalogExpansionManifest,
		})
		expect(Exit.isFailure(harnessCatalogExit)).toBe(true)
		if (Exit.isFailure(harnessCatalogExit)) {
			expect(String(harnessCatalogExit.cause)).toContain(CUSTOM_PROVIDER_CATALOG_ENV)
			expect(String(harnessCatalogExit.cause)).toContain(
				String(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES),
			)
		}
		const apiCatalogExit = await runPlan(apiWorkerCustomProvidersProps, {
			[CUSTOM_PROVIDERS_ENV]: catalogExpansionManifest,
		})
		expect(Exit.isFailure(apiCatalogExit)).toBe(true)
		if (Exit.isFailure(apiCatalogExit)) {
			expect(String(apiCatalogExit.cause)).toContain(CUSTOM_PROVIDER_CATALOG_ENV)
			expect(String(apiCatalogExit.cause)).toContain(String(CLOUDFLARE_WORKER_ENV_VAR_MAX_BYTES))
		}

		// Direct Alchemy harness planning validates custom provider credentials (presence and HTTP
		// header sendability) without requiring credentials for unused built-in providers.
		const plannedCustom = parseCustomProvidersManifest(manifest)
		const missingSecretPlan = await runPlan(loadProviderApiKeys(plannedCustom), {
			OPENAI_API_KEY: "sk-unused-builtin",
			CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "xai-secret-key",
		})
		expect(Exit.isFailure(missingSecretPlan)).toBe(true)
		if (Exit.isFailure(missingSecretPlan)) {
			expect(String(missingSecretPlan.cause)).toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
		}

		const badNewlinePlan = await runPlan(loadProviderApiKeys(plannedCustom), {
			CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "xai-secret-key",
			CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "gw-line1\ngw-line2",
		})
		expect(Exit.isFailure(badNewlinePlan)).toBe(true)
		if (Exit.isFailure(badNewlinePlan)) {
			const cause = String(badNewlinePlan.cause)
			expect(cause).toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
			expect(cause).toContain("HTTP header")
			expect(cause).not.toContain("gw-line1")
		}

		const badSpacedBearerPlan = await runPlan(loadProviderApiKeys(plannedCustom), {
			CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "Bearer xai-space-leak",
			CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "gw-ok",
		})
		expect(Exit.isFailure(badSpacedBearerPlan)).toBe(true)
		if (Exit.isFailure(badSpacedBearerPlan)) {
			const cause = String(badSpacedBearerPlan.cause)
			expect(cause).toContain("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")
			expect(cause).toContain("HTTP header")
			expect(cause).not.toContain("xai-space-leak")
		}

		const validCustomOnlyPlan = await runPlan(loadProviderApiKeys(plannedCustom), {
			CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "k".repeat(5090),
			CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "Bearer gw-token-ok",
		})
		expect(Exit.isSuccess(validCustomOnlyPlan)).toBe(true)

		// Custom secrets whose Alchemy-packed binding exceeds 5,120 UTF-8 bytes fail planning
		// while reporting only the variable name and size.
		const oversizedPrimaryPlan = await runPlan(loadProviderApiKeys(plannedCustom), {
			CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "k".repeat(5091),
			CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "gw-ok",
		})
		expect(Exit.isFailure(oversizedPrimaryPlan)).toBe(true)
		if (Exit.isFailure(oversizedPrimaryPlan)) {
			const cause = String(oversizedPrimaryPlan.cause)
			expect(cause).toContain("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")
			expect(cause).toContain("5121")
			expect(cause).toContain("5120")
			expect(cause).not.toContain("kkkkkk")
		}

		const oversizedHeaderPlan = await runPlan(loadProviderApiKeys(plannedCustom), {
			CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "xai-secret-key",
			CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "t".repeat(5091),
		})
		expect(Exit.isFailure(oversizedHeaderPlan)).toBe(true)
		if (Exit.isFailure(oversizedHeaderPlan)) {
			const cause = String(oversizedHeaderPlan.cause)
			expect(cause).toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
			expect(cause).toContain("5121")
			expect(cause).toContain("5120")
			expect(cause).not.toContain("tttttt")
		}

		const runtimeMissingCustom = await Effect.runPromiseExit(
			loadProviderApiKeys(plannedCustom).pipe(
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
			),
		)
		expect(Exit.isSuccess(runtimeMissingCustom)).toBe(true)
	})

	it("maps an assistant response and its settled operation usage", () => {
		const baseUsage = {
			input: 12,
			output: 8,
			cacheRead: 100,
			cacheWrite: 20,
			totalTokens: 140,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}

		const okMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Step 1" },
				{ type: "text", text: "Final answer" },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: baseUsage,
			stopReason: "stop",
			timestamp: 0,
		}
		const usage = { input_tokens: 132, output_tokens: 8 }
		expect(mapAssistantMessageToOutcome(okMsg, usage)).toEqual({
			ok: true,
			reply: {
				thinking: "Step 1",
				text: "Final answer",
				input_tokens: 132,
				output_tokens: 8,
				stop_reason: { type: "end_turn" },
			},
		})

		const lengthMsg: AssistantMessage = {
			...okMsg,
			content: [{ type: "text", text: "Partial reply" }],
			stopReason: "length",
		}
		expect(mapAssistantMessageToOutcome(lengthMsg, usage)).toEqual({
			ok: true,
			reply: {
				thinking: null,
				text: "Partial reply",
				input_tokens: 132,
				output_tokens: 8,
				stop_reason: { type: "budget_reached" },
			},
		})

		const authErrMsg: AssistantMessage = {
			...okMsg,
			content: [],
			stopReason: "error",
			errorMessage: "401 Unauthorized: invalid_api_key",
		}
		expect(mapAssistantMessageToOutcome(authErrMsg, usage)).toEqual({
			ok: false,
			error: {
				_tag: "TurnFailed",
				error_type: "model_request_failed_error",
				message: PROVIDER_FAILURE_MESSAGE,
				terminal: false,
				model_usage: usage,
			},
		})
	})

	it("offers no model whose context window is too small for Pi's compaction defaults", () => {
		const registry = createPiModels({ openai: null, anthropic: null })
		const models = registry.getModels()
		const small = models.filter(
			(model) => model.contextWindow < PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
		)
		expect(small).toEqual([])
		expect(models.map((model) => `${model.provider}/${model.id}`)).not.toContain("openai/gpt-4")
		expect(registry.getModel("openai", "gpt-4")).toBeUndefined()
		for (const model of models) {
			expect(resolveCatalogModel(`${model.provider}/${model.id}`)).not.toBeNull()
		}
		expect(resolveCatalogModel("gpt-4")).toBeNull()
		expect(resolveCatalogModel("openai/gpt-4")).toBeNull()
		expect(resolveCatalogModel("gpt-4o-mini")).not.toBeNull()
		expect("modelOverrides" in PI_HARNESS_SETTINGS.compaction).toBe(false)
	})

	it("logs Pi's reason for an unanswered turn without echoing raw provider error bodies", async () => {
		const secretBody = "SECRET_ECHOED_PAYLOAD_98765"
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model) => ({
				...makeAssistantReply(model, null, "", 4, 0),
				stopReason: "error",
				errorMessage: `400 invalid_request: ${secretBody}`,
			})),
		)
		const warnLogs: Array<{
			readonly level: string
			readonly message: unknown
			readonly annotations: {
				readonly operationId?: unknown
				readonly provider?: unknown
				readonly reason?: unknown
			}
		}> = []
		const captureLogger = Logger.layer(
			[
				Logger.make(({ logLevel, message, fiber }) => {
					warnLogs.push({
						level: logLevel,
						message,
						annotations: fiber.getRef(References.CurrentLogAnnotations),
					})
				}),
			],
			{ mergeWithExisting: false },
		)
		try {
			const result = await Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:1",
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "trigger error",
				}).pipe(Effect.provide(captureLogger)),
			)
			expect(result).toMatchObject({
				ok: false,
				error: { error_type: "model_request_failed_error", message: PROVIDER_FAILURE_MESSAGE },
			})
			expect(warnLogs.length).toBeGreaterThanOrEqual(1)
			const serialized = JSON.stringify(warnLogs)
			expect(serialized).not.toContain(secretBody)
			expect(warnLogs).toContainEqual({
				level: "Warn",
				message: ["pi turn unanswered"],
				annotations: { operationId: "turn:1", provider: "openai", reason: "model_error" },
			})
		} finally {
			await backend.close()
		}
	})
})

describe("turn engine", () => {
	const turnRequest = (turn: number, text: string): PiTurnRequest => ({
		operationId: `turn:${turn}`,
		turn,
		provider: "openai",
		modelId: "gpt-4o-mini",
		system: null,
		text,
	})

	const blockingBackend = async () => {
		let calls = 0
		let release: () => void = () => undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let markStarted: () => void = () => undefined
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context, signal) => {
				calls += 1
				markStarted()
				await Promise.race([
					gate,
					new Promise<void>((resolve) => {
						signal?.addEventListener("abort", () => resolve(), { once: true })
					}),
				])
				return signal?.aborted
					? { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" as const }
					: makeAssistantReply(model, null, `re: ${extractLastUserText(context)}`, 3, 2)
			}),
		)
		return { backend, release, started, calls: () => calls }
	}

	it.each(["fresh", "recovery"] as const)(
		"counts pause polling during a %s wait",
		async (path) => {
			const { backend, release, started } = await blockingBackend()
			const observer = await observePauseWait(
				backend,
				path,
				turnRequest(1, "measure a waiting turn"),
			)
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				const wait = await observer.start()
				try {
					await waitForPauseProbe(started, "starting the model")
					let previous = 0
					for (const elapsed of [1000, 10_000, 30_000]) {
						await vi.advanceTimersByTimeAsync(elapsed - previous)
						previous = elapsed
						const counts = wait.counts()
						reportPauseMeasurement({
							path,
							workload: "pending model",
							elapsed,
							atWait: wait.atWait,
							...counts,
						})
						expect(counts).toMatchObject({
							waitCalls: 1,
							submissionReads: elapsed / 100,
							inspections: elapsed / 100,
							waitAborts: 0,
							turnAborts: 0,
						})
					}
					release()
					expect(await wait.result()).toMatchObject({ ok: true })
				} finally {
					release()
					await wait.stop()
				}
			} finally {
				release()
				vi.useRealTimers()
				observer.restore()
				await backend.close()
			}
		},
		15_000,
	)

	it.each(["fresh", "recovery"] as const)(
		"settles or cancels a %s wait before the first tick",
		async (path) => {
			for (const action of ["finish", "cancel"] as const) {
				const { backend, release, started } = await blockingBackend()
				const observer = await observePauseWait(
					backend,
					path,
					turnRequest(1, "measure pause cancellation"),
				)
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
				try {
					const wait = await observer.start()
					try {
						await waitForPauseProbe(started, "starting the model")
						await vi.advanceTimersByTimeAsync(99)
						if (action === "cancel") {
							await wait.abort()
						} else {
							release()
						}
						const outcome = await wait.result()
						expect(outcome).toMatchObject(
							action === "cancel"
								? { ok: false, error: { _tag: "TurnInterrupted" } }
								: { ok: true },
						)
						const counts = wait.counts()
						reportPauseMeasurement({
							path,
							workload: action,
							elapsed: 99,
							atWait: wait.atWait,
							...counts,
						})
						expect(counts).toMatchObject({
							inspections: 0,
							turnAborts: action === "cancel" ? 1 : 0,
						})
					} finally {
						release()
						await wait.stop()
					}
				} finally {
					release()
					vi.useRealTimers()
					observer.restore()
					await backend.close()
				}
			}
		},
		15_000,
	)

	it.runIf(measurePause).each(["fresh", "recovery"] as const)(
		"measures real pending polling cost on a %s wait",
		async (path) => {
			for (let repetition = 1; repetition <= 5; repetition++) {
				const { backend, release, started } = await blockingBackend()
				const observer = await observePauseWait(
					backend,
					path,
					turnRequest(1, "measure a pending turn"),
				)
				try {
					const wait = await observer.start()
					try {
						await waitForPauseProbe(started, "starting the model")
						const began = performance.now()
						const startCpu = process.cpuUsage()
						for (const targetMs of [1000, 10_000, 30_000]) {
							const remaining = Math.max(0, Math.ceil(targetMs - (performance.now() - began)))
							await new Promise<void>((resolve) => {
								setTimeout(resolve, remaining)
							})
							const elapsedMs = Number((performance.now() - began).toFixed(3))
							const cpu = process.cpuUsage(startCpu)
							reportPauseMeasurement({
								path,
								workload: "pending model realtime",
								targetMs,
								elapsedMs,
								repetition,
								cpuUserUs: cpu.user,
								cpuSystemUs: cpu.system,
								...wait.counts(),
							})
						}
						release()
						expect(await wait.result()).toMatchObject({ ok: true })
					} finally {
						release()
						await wait.stop()
					}
				} finally {
					release()
					observer.restore()
					await backend.close()
				}
			}
		},
		180_000,
	)

	it("accounts for blocking compaction and failed attempts exactly once across replay", async () => {
		let summaries = 0
		let attempts = 0
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context) => {
				const prompt = extractLastUserText(context)
				if (prompt.startsWith("<conversation>")) {
					summaries++
					return makeAssistantReply(model, null, "Summary", 12, 3)
				}
				if (prompt === "First") {
					return makeAssistantReply(model, null, "a".repeat(84_000), 120_000, 1)
				}
				if (prompt === "Second" && ++attempts === 1) {
					const failed = makeAssistantReply(model, null, "", 4, 1)
					return {
						...failed,
						usage: { ...failed.usage, cacheRead: 5, cacheWrite: 2 },
						stopReason: "error",
						errorMessage: "503 service unavailable",
					}
				}
				return makeAssistantReply(model, null, "Done", 6, 2)
			}),
		)
		try {
			const first = await Effect.runPromise(runPiDurableTurn(backend, turnRequest(1, "First")))
			expect(first).toMatchObject({ ok: true, reply: { input_tokens: 120_000, output_tokens: 1 } })
			const second = await Effect.runPromise(runPiDurableTurn(backend, turnRequest(2, "Second")))
			expect(summaries).toBe(1)
			expect(attempts).toBe(2)
			expect(second).toMatchObject({ ok: true, reply: { input_tokens: 29, output_tokens: 6 } })
			expect(
				await Effect.runPromise(runPiDurableTurn(backend, turnRequest(3, "Third"))),
			).toMatchObject({
				ok: true,
				reply: { input_tokens: 6, output_tokens: 2 },
			})
			expect(await Effect.runPromise(runPiDurableTurn(backend, turnRequest(2, "Second")))).toEqual(
				second,
			)
			expect(await Effect.runPromise(runPiDurableTurn(backend, turnRequest(1, "First")))).toEqual(
				first,
			)
			expect(attempts).toBe(2)
		} finally {
			await backend.close()
		}
	})

	it("reports a turn cancelled before it reached Pi as interrupted, without calling the model", async () => {
		const { backend, calls } = await blockingBackend()
		try {
			await Effect.runPromise(backend.abort("turn:1"))
			expect(
				await Effect.runPromise(runPiDurableTurn(backend, turnRequest(1, "never sent"))),
			).toMatchObject({
				ok: false,
				error: { _tag: "TurnInterrupted" },
			})
			expect(calls()).toBe(0)
		} finally {
			await backend.close()
		}
	})

	it("reports an aborted running turn as interrupted", async () => {
		const { backend, started } = await blockingBackend()
		try {
			const running = Effect.runPromise(runPiDurableTurn(backend, turnRequest(1, "stop me")))
			await started
			await Effect.runPromise(backend.abort("turn:1"))
			expect(await running).toMatchObject({ ok: false, error: { _tag: "TurnInterrupted" } })
		} finally {
			await backend.close()
		}
	})

	it("drops an interrupted turn's tool rounds from the context of the turns that follow", async () => {
		const contexts: Array<TranscriptContext> = []
		const conversationRoles = (context: TranscriptContext | undefined) =>
			context?.messages.map((message) => message.role).filter((role) => role !== "system")
		let markToolRan: () => void = () => undefined
		const toolRan = new Promise<void>((resolve) => {
			markToolRan = resolve
		})
		const registry = createCheckfuRegistry()
		registry.install({
			name: "probe",
			tools: [
				{
					name: "probe",
					description: "Probe.",
					parameters: { type: "object", properties: {} },
					replay: "safe",
					execute: () => Promise.resolve({ output: [{ type: "text", text: "probed" }] }),
				},
			],
		})
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context, signal) => {
				contexts.push(context)
				if (extractLastUserText(context) !== "use the tool") {
					return makeAssistantReply(model, null, "fresh start", 3, 2)
				}
				if (contexts.length === 1) {
					return {
						...makeAssistantReply(model, null, "", 3, 2),
						content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }],
						stopReason: "toolUse",
					}
				}
				markToolRan()
				await new Promise<void>((resolve) => {
					signal?.addEventListener("abort", () => resolve(), { once: true })
				})
				return { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" }
			}),
			1,
			registry,
		)
		try {
			const running = Effect.runPromise(runPiDurableTurn(backend, turnRequest(1, "use the tool")))
			await toolRan
			expect(conversationRoles(contexts[1])).toEqual(["user", "assistant", "toolResult"])
			await Effect.runPromise(backend.abort("turn:1"))
			expect(await running).toMatchObject({ ok: false, error: { _tag: "TurnInterrupted" } })

			expect(
				await Effect.runPromise(runPiDurableTurn(backend, turnRequest(2, "start over"))),
			).toMatchObject({ ok: true, reply: { text: "fresh start" } })
			expect(conversationRoles(contexts[2])).toEqual(["user"])
		} finally {
			await backend.close()
		}
	})

	const contextAfterInterruptedCompaction = async (restoredLimit?: number) => {
		const run = <A, E>(effect: Effect.Effect<A, E>) =>
			Effect.runPromise(
				restoredLimit === undefined
					? effect
					: Effect.provideService(effect, RestoredHistoryLimit, restoredLimit),
			)
		const contexts: Array<TranscriptContext> = []
		const texts = (context: TranscriptContext | undefined) =>
			JSON.stringify(context?.messages ?? [])
		let markSecondCall: () => void = () => undefined
		const secondCall = new Promise<void>((resolve) => {
			markSecondCall = resolve
		})
		const registry = createCheckfuRegistry()
		registry.install({
			name: "probe",
			tools: [
				{
					name: "probe",
					description: "Probe.",
					parameters: { type: "object", properties: {} },
					replay: "safe",
					execute: () => Promise.resolve({ output: [{ type: "text", text: "b".repeat(84_000) }] }),
				},
			],
		})
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context, signal) => {
				const prompt = extractLastUserText(context)
				if (prompt.startsWith("<conversation>")) {
					return makeAssistantReply(model, null, "SUMMARY-OF-UNPUBLISHED-WORK", 12, 3)
				}
				contexts.push(context)
				if (prompt.startsWith("History ")) {
					return makeAssistantReply(
						model,
						null,
						`FACT-${prompt.slice(8)} ${"a".repeat(84_000)}`,
						3,
						1,
					)
				}
				if (prompt !== "use the tool") {
					return makeAssistantReply(model, null, "fresh start", 3, 2)
				}
				if (!context.messages.some((message) => message.role === "toolResult")) {
					return {
						...makeAssistantReply(model, null, "", 120_000, 2),
						content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }],
						stopReason: "toolUse",
					}
				}
				markSecondCall()
				await new Promise<void>((resolve) => {
					signal?.addEventListener("abort", () => resolve(), { once: true })
				})
				return { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" }
			}),
			1,
			registry,
		)
		try {
			for (const turn of [1, 2, 3]) {
				await run(runPiDurableTurn(backend, turnRequest(turn, `History ${turn}`)))
			}
			const running = run(runPiDurableTurn(backend, turnRequest(4, "use the tool")))
			await secondCall
			expect(texts(contexts.at(-1))).toContain("SUMMARY-OF-UNPUBLISHED-WORK")
			await run(backend.abort("turn:4"))
			expect(await running).toMatchObject({ ok: false, error: { _tag: "TurnInterrupted" } })

			expect(await run(runPiDurableTurn(backend, turnRequest(5, "start over")))).toMatchObject({
				ok: true,
				reply: { text: "fresh start" },
			})
			return contexts.at(-1)
		} finally {
			await backend.close()
		}
	}

	it("puts back the history a compaction dropped when the turn that compacted is interrupted", async () => {
		const context = await contextAfterInterruptedCompaction()
		const text = JSON.stringify(context?.messages ?? [])
		expect(text).not.toContain("SUMMARY-OF-UNPUBLISHED-WORK")
		expect(text).not.toContain("use the tool")
		expect(text).not.toContain("b".repeat(100))
		expect(context?.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
		])
		for (const turn of [1, 2, 3]) {
			expect(text).toContain(`"History ${turn}"`)
			expect(text).toContain(`FACT-${turn} aaa`)
		}
	})

	it("puts back only the newest turns that fit, and never the summary of an interrupted turn", async () => {
		const some = JSON.stringify((await contextAfterInterruptedCompaction(100_000))?.messages ?? [])
		expect(some).not.toContain("SUMMARY-OF-UNPUBLISHED-WORK")
		expect(some).not.toContain("b".repeat(100))
		expect(some).toContain("Earlier messages of this conversation are no longer available")
		expect(some).not.toContain("FACT-1 aaa")
		expect(some).toContain("FACT-2 aaa")
		expect(some).toContain("FACT-3 aaa")

		const none = JSON.stringify((await contextAfterInterruptedCompaction(50_000))?.messages ?? [])
		expect(none).not.toContain("SUMMARY-OF-UNPUBLISHED-WORK")
		expect(none).toContain("Earlier messages of this conversation are no longer available")
		expect(none).not.toContain("FACT-2 aaa")
		expect(none).toContain("FACT-3 aaa")
	})

	it("makes recovery wait while a turn enters its workspace, then returns that turn's reply", async () => {
		const { backend, release } = await blockingBackend()
		let enter: () => void = () => undefined
		let entering: () => void = () => undefined
		const entered = new Promise<void>((resolve) => {
			entering = resolve
		})
		const slowEntry: PiDurableBackend = {
			...backend,
			enterWorkspace: () =>
				new Promise<boolean>((resolve) => {
					entering()
					enter = () => resolve(true)
				}),
		}
		try {
			const running = Effect.runPromise(runPiDurableTurn(slowEntry, turnRequest(1, "hello")))
			await entered
			let recovered: PiTurnOutcome | null | "pending" = "pending"
			const recovering = Effect.runPromise(recoverPiDurableTurn(slowEntry, "turn:1")).then(
				(result) => {
					recovered = result
				},
			)
			await Effect.runPromise(Effect.sleep("20 millis"))
			expect(recovered).toBe("pending")
			enter()
			release()
			expect(await running).toMatchObject({ ok: true, reply: { text: "re: hello" } })
			await recovering
			expect(recovered).toMatchObject({ ok: true, reply: { text: "re: hello" } })
		} finally {
			await backend.close()
		}
	})

	it("ends a turn whose workspace refuses it before asking the model anything", async () => {
		const { backend, release, calls } = await blockingBackend()
		const refusing: PiDurableBackend = { ...backend, enterWorkspace: () => Promise.resolve(false) }
		try {
			expect(
				await Effect.runPromise(runPiDurableTurn(refusing, turnRequest(1, "too late"))),
			).toEqual({ ok: false, error: { _tag: "TurnInterrupted" } })
			expect(calls()).toBe(0)
			release()
			expect(
				await Effect.runPromise(runPiDurableTurn(backend, turnRequest(1, "on time"))),
			).toMatchObject({ ok: true, reply: { text: "re: on time" } })
		} finally {
			await backend.close()
		}
	})

	it("replays a saved reply when a late abort arrives", async () => {
		const { backend, release } = await blockingBackend()
		try {
			release()
			expect(
				await Effect.runPromise(runPiDurableTurn(backend, turnRequest(1, "done first"))),
			).toMatchObject({
				ok: true,
				reply: { text: "re: done first" },
			})
			await Effect.runPromise(backend.abort("turn:1"))
			expect(
				await Effect.runPromise(runPiDurableTurn(backend, turnRequest(1, "done first"))),
			).toMatchObject({
				ok: true,
				reply: { text: "re: done first" },
			})
		} finally {
			await backend.close()
		}
	})

	it("keeps a turn running when the caller's connection drops, and returns its reply on re-entry", async () => {
		const { backend, release, started, calls } = await blockingBackend()
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const dropped = yield* Effect.forkChild(
						runPiDurableTurn(backend, turnRequest(1, "keep going")),
						{ startImmediately: true },
					)
					yield* Effect.promise(() => started)
					yield* Fiber.interrupt(dropped)
					expect(Exit.isFailure(yield* Fiber.await(dropped))).toBe(true)
					const next = yield* Effect.forkChild(runPiDurableTurn(backend, turnRequest(2, "next")), {
						startImmediately: true,
					})
					release()
					expect(yield* Fiber.join(next)).toMatchObject({
						ok: true,
						reply: { input_tokens: 3, output_tokens: 2 },
					})
					expect(yield* runPiDurableTurn(backend, turnRequest(1, "keep going"))).toMatchObject({
						ok: true,
						reply: { text: "re: keep going", input_tokens: 3, output_tokens: 2 },
					})
					expect(calls()).toBe(2)
				}),
			)
		} finally {
			await backend.close()
		}
	})

	it("cleans up an unanswered turn after a dropped connection before admitting the successor", async () => {
		const textOf = (message: TranscriptContext["messages"][number]) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")

		let releaseFailed: () => void = () => undefined
		const failedGate = new Promise<void>((resolve) => {
			releaseFailed = resolve
		})
		let markFailedStarted: () => void = () => undefined
		const failedStarted = new Promise<void>((resolve) => {
			markFailedStarted = resolve
		})
		const failedContexts: Array<ReadonlyArray<string>> = []
		const failedBackend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context) => {
				const last = extractLastUserText(context)
				failedContexts.push(
					context.messages
						.filter((m) => m.role === "user" || m.role === "assistant")
						.map((m) => `${m.role}:${textOf(m)}`),
				)
				if (last === "doomed-turn-1") {
					markFailedStarted()
					await failedGate
					return {
						...makeAssistantReply(model, null, "", 7, 1),
						stopReason: "error" as const,
						errorMessage: "400 invalid_request",
					}
				}
				return makeAssistantReply(model, null, `re: ${last}`, 4, 2)
			}),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const dropped = yield* Effect.forkChild(
						runPiDurableTurn(failedBackend, turnRequest(1, "doomed-turn-1")),
						{ startImmediately: true },
					)
					yield* Effect.promise(() => failedStarted)
					yield* Fiber.interrupt(dropped)
					expect(Exit.isFailure(yield* Fiber.await(dropped))).toBe(true)

					const successor = yield* Effect.forkChild(
						runPiDurableTurn(failedBackend, turnRequest(2, "clean-turn-2")),
						{ startImmediately: true },
					)
					releaseFailed()
					expect(yield* Fiber.join(successor)).toMatchObject({
						ok: true,
						reply: { text: "re: clean-turn-2", input_tokens: 4, output_tokens: 2 },
					})
					expect(failedContexts.at(-1)).toEqual(["user:clean-turn-2"])

					expect(
						yield* runPiDurableTurn(failedBackend, turnRequest(1, "doomed-turn-1")),
					).toMatchObject({
						ok: false,
						error: {
							error_type: "model_request_failed_error",
							model_usage: { input_tokens: 7, output_tokens: 1 },
						},
					})
				}),
			)
		} finally {
			await failedBackend.close()
		}

		let markAbortStarted: () => void = () => undefined
		const abortStarted = new Promise<void>((resolve) => {
			markAbortStarted = resolve
		})
		const abortContexts: Array<ReadonlyArray<string>> = []
		const abortedBackend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context, signal) => {
				const last = extractLastUserText(context)
				abortContexts.push(
					context.messages
						.filter((m) => m.role === "user" || m.role === "assistant")
						.map((m) => `${m.role}:${textOf(m)}`),
				)
				if (last === "aborted-after-drop") {
					markAbortStarted()
					await new Promise<void>((resolve) => {
						if (signal?.aborted) {
							resolve()
							return
						}
						signal?.addEventListener("abort", () => resolve(), { once: true })
					})
					return { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" as const }
				}
				return makeAssistantReply(model, null, `re: ${last}`, 3, 2)
			}),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const dropped = yield* Effect.forkChild(
						runPiDurableTurn(abortedBackend, turnRequest(1, "aborted-after-drop")),
						{ startImmediately: true },
					)
					yield* Effect.promise(() => abortStarted)
					yield* Fiber.interrupt(dropped)
					expect(Exit.isFailure(yield* Fiber.await(dropped))).toBe(true)

					const successor = yield* Effect.forkChild(
						runPiDurableTurn(abortedBackend, turnRequest(2, "successor-after-abort")),
						{ startImmediately: true },
					)
					yield* abortedBackend.abort("turn:1")
					expect(yield* Fiber.join(successor)).toMatchObject({
						ok: true,
						reply: { text: "re: successor-after-abort", input_tokens: 3, output_tokens: 2 },
					})
					expect(abortContexts.at(-1)).toEqual(["user:successor-after-abort"])
				}),
			)
		} finally {
			await abortedBackend.close()
		}
	})

	it("reports an interrupt that lands while the turn is being admitted, without submitting it", async () => {
		const { backend, calls } = await blockingBackend()
		try {
			let admitting: () => void = () => undefined
			const reachedRoot = new Promise<void>((resolve) => {
				admitting = resolve
			})
			let proceed: () => void = () => undefined
			const gate = new Promise<void>((resolve) => {
				proceed = resolve
			})
			const slowRoot: PiDurableBackend = {
				...backend,
				ensureRoot: async (agent) => {
					admitting()
					await gate
					return backend.ensureRoot(agent)
				},
			}
			await Effect.runPromise(
				Effect.gen(function* () {
					const running = yield* Effect.forkChild(
						runPiDurableTurn(slowRoot, turnRequest(1, "cancel me")),
						{ startImmediately: true },
					)
					yield* Effect.promise(() => reachedRoot)
					const aborting = yield* Effect.forkChild(backend.abort("turn:1"), {
						startImmediately: true,
					})
					proceed()
					expect(yield* Fiber.join(running)).toMatchObject({
						ok: false,
						error: { _tag: "TurnInterrupted" },
					})
					yield* Fiber.join(aborting)
					expect(
						yield* Effect.promise(() =>
							backend.storage.submissionByRequest(
								ROOT_CONVERSATION_ID,
								"turn:1",
								BACKGROUND_CONTEXT,
							),
						),
					).toBeUndefined()
					expect(calls()).toBe(0)
				}),
			)
		} finally {
			await backend.close()
		}
	})

	it("matches only provider-specific, case-sensitive confirmed refusal stop reasons", () => {
		expect(isProviderRefusalStopReason("anthropic-messages", "anthropic", "refusal")).toBe(true)
		expect(isProviderRefusalStopReason("anthropic-messages", "anthropic", "sensitive")).toBe(true)
		expect(isProviderRefusalStopReason("anthropic-messages", "anthropic", "content_filter")).toBe(
			false,
		)
		expect(
			isProviderRefusalStopReason("anthropic-messages", "anthropic", "incomplete.content_filter"),
		).toBe(false)
		expect(isProviderRefusalStopReason("anthropic-messages", "anthropic", "REFUSAL")).toBe(false)
		expect(isProviderRefusalStopReason("anthropic-messages", "anthropic", "Sensitive")).toBe(false)

		expect(isProviderRefusalStopReason("openai-responses", "openai", "refusal")).toBe(true)
		expect(
			isProviderRefusalStopReason("openai-responses", "openai", "incomplete.content_filter"),
		).toBe(true)
		expect(isProviderRefusalStopReason("openai-responses", "openai", "content_filter")).toBe(false)
		expect(isProviderRefusalStopReason("openai-responses", "openai", "sensitive")).toBe(false)
		expect(isProviderRefusalStopReason("openai-responses", "openai", "REFUSAL")).toBe(false)
		expect(
			isProviderRefusalStopReason("openai-responses", "openai", "INCOMPLETE.CONTENT_FILTER"),
		).toBe(false)

		const baseUsage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}
		const unconfirmedAnthropic: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: baseUsage,
			stopReason: "error",
			rawStopReason: "content_filter",
			errorMessage: "Unhandled stop reason: content_filter",
			timestamp: 0,
		}
		expect(isRefusalAssistantMessage(unconfirmedAnthropic)).toBe(false)
		expect(
			mapAssistantMessageToOutcome(unconfirmedAnthropic, { input_tokens: 1, output_tokens: 1 }),
		).toMatchObject({
			ok: false,
			error: {
				error_type: "model_request_failed_error",
				message: PROVIDER_FAILURE_MESSAGE,
			},
		})
	})

	it("refuses HTTP redirects and cross-origin requests at the provider fetch transport", async () => {
		let targetHits = 0
		const targetServer = createServer((_req, res) => {
			targetHits += 1
			res.writeHead(200, { "content-type": "text/plain" })
			res.end("SHOULD_NOT_BE_REACHED")
		})
		await new Promise<void>((resolve) => {
			targetServer.listen(0, "127.0.0.1", () => resolve())
		})
		const targetPort = (targetServer.address() as { port: number }).port

		let redirectorHits = 0
		const redirectorServer = createServer((_req, res) => {
			redirectorHits += 1
			res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/steal` })
			res.end()
		})
		await new Promise<void>((resolve) => {
			redirectorServer.listen(0, "127.0.0.1", () => resolve())
		})
		const redirectorPort = (redirectorServer.address() as { port: number }).port

		try {
			const models = createPiModels(
				{
					openai: Redacted.make("sk-openai-test"),
					anthropic: Redacted.make("sk-ant-test"),
				},
				{
					openai: `http://127.0.0.1:${redirectorPort}/v1`,
					anthropic: `http://127.0.0.1:${redirectorPort}`,
				},
			)

			const openaiBase = models.getModel("openai", "gpt-4o-mini")
			if (openaiBase === undefined) {
				throw new Error("expected gpt-4o-mini")
			}
			const openaiStream = models.streamSimple(
				openaiBase,
				{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
				{ apiKey: "sk-openai-test", maxRetries: 0 },
			)
			const openaiResult = await openaiStream.result()
			expect(openaiResult.stopReason).toBe("error")
			expect(redirectorHits).toBeGreaterThanOrEqual(1)
			expect(targetHits).toBe(0)

			const hitsBeforeAnthropic = redirectorHits
			const anthropicBase = models.getModel("anthropic", "claude-sonnet-4-5")
			if (anthropicBase === undefined) {
				throw new Error("expected claude-sonnet-4-5")
			}
			const anthropicStream = models.streamSimple(
				anthropicBase,
				{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
				{ apiKey: "sk-ant-test", maxRetries: 0 },
			)
			const anthropicResult = await anthropicStream.result()
			expect(anthropicResult.stopReason).toBe("error")
			expect(redirectorHits).toBeGreaterThan(hitsBeforeAnthropic)
			expect(targetHits).toBe(0)

			const hitsBeforePinnedCheck = redirectorHits
			const prodModels = createPiModels({
				openai: Redacted.make("sk-openai-prod"),
				anthropic: Redacted.make("sk-ant-prod"),
			})
			const rejectedOpenAI = await prodModels
				.streamSimple(
					openaiBase,
					{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
					{ maxRetries: 0 },
				)
				.result()
			expect(rejectedOpenAI.stopReason).toBe("error")
			expect(rejectedOpenAI.errorMessage).toMatch(/disallowed origin/i)
			const rejectedAnthropic = await prodModels
				.streamSimple(
					anthropicBase,
					{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
					{ maxRetries: 0 },
				)
				.result()
			expect(rejectedAnthropic.stopReason).toBe("error")
			expect(rejectedAnthropic.errorMessage).toMatch(/disallowed origin/i)
			expect(redirectorHits).toBe(hitsBeforePinnedCheck)
			const seenInits: Array<RequestInit | undefined> = []
			const mockRedirectFetch = (async (
				_input: Parameters<typeof fetch>[0],
				init?: RequestInit,
			) => {
				seenInits.push(init)
				return new Response(null, {
					status: 307,
					headers: { location: "https://api.anthropic.com/v1/messages" },
				})
			}) as typeof fetch
			const guardedFetch = createNoRedirectProviderFetch(
				"https://api.openai.com/v1",
				mockRedirectFetch,
			)
			await expect(
				guardedFetch("https://api.openai.com/v1/responses", { redirect: "follow" }),
			).rejects.toThrow(/redirect/i)
			expect(seenInits).toHaveLength(1)
			expect(seenInits[0]?.redirect).toBe("manual")

			await expect(guardedFetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(
				/disallowed origin/i,
			)
			expect(seenInits).toHaveLength(1)

			const spoofedUrl = Object.assign(new URL("https://evil.example/steal"), {
				url: "https://api.openai.com/v1/responses",
			})
			await expect(guardedFetch(spoofedUrl)).rejects.toThrow(/disallowed origin/i)
			expect(seenInits).toHaveLength(1)

			let opaqueBodyCancelled = false
			const opaqueBody = new ReadableStream<Uint8Array>({
				cancel() {
					opaqueBodyCancelled = true
				},
			})
			const guardedOpaque = createNoRedirectProviderFetch(
				"https://api.openai.com/v1",
				(async () => ({
					status: 0,
					redirected: false,
					type: "opaqueredirect",
					body: opaqueBody,
				})) as unknown as typeof fetch,
			)
			await expect(guardedOpaque("https://api.openai.com/v1/responses")).rejects.toThrow(
				/redirect/i,
			)
			expect(opaqueBodyCancelled).toBe(true)

			const guardedRedirectedFlag = createNoRedirectProviderFetch(
				"https://api.openai.com/v1",
				(async () => ({
					status: 200,
					redirected: true,
					type: "basic",
					body: null,
				})) as unknown as typeof fetch,
			)
			await expect(guardedRedirectedFlag("https://api.openai.com/v1/responses")).rejects.toThrow(
				/redirect/i,
			)

			const seenDispatches: Array<{
				readonly input: Parameters<typeof fetch>[0]
				readonly init: RequestInit | undefined
			}> = []
			const okFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				seenDispatches.push({ input, init })
				return new Response("ok", { status: 200 })
			}) as typeof fetch
			const guardedOkFetch = createNoRedirectProviderFetch("https://api.openai.com/v1", okFetch)

			const nativePost = new Request("https://api.openai.com/v1/responses", {
				method: "POST",
				body: "must-stay-unused",
			})
			await expect(guardedOkFetch(nativePost)).rejects.toThrow(
				/only URL strings and URL instances/i,
			)
			expect(nativePost.bodyUsed).toBe(false)

			class SubclassedRequest extends Request {}
			await expect(
				guardedOkFetch(new SubclassedRequest("https://api.openai.com/v1/responses")),
			).rejects.toThrow(/only URL strings and URL instances/i)

			await expect(
				guardedOkFetch({
					href: "https://api.openai.com/v1/responses",
				} as unknown as Parameters<typeof fetch>[0]),
			).rejects.toThrow(/only URL strings and URL instances/i)
			expect(seenDispatches).toHaveLength(0)

			const allowedUrl = Object.assign(new URL("https://api.openai.com/v1/responses"), {
				url: "https://evil.example/override",
			})
			await guardedOkFetch(allowedUrl)
			expect(seenDispatches.map((entry) => entry.input)).toEqual([
				"https://api.openai.com/v1/responses",
			])

			let releaseGate!: () => void
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve
			})
			const asyncObservedTargets: Array<Parameters<typeof fetch>[0]> = []
			const guardedAsync = createNoRedirectProviderFetch(
				"https://api.openai.com/v1",
				async (input: Parameters<typeof fetch>[0]) => {
					await gate
					asyncObservedTargets.push(input)
					return new Response("ok", { status: 200 })
				},
			)
			const mutableUrl = new URL("https://api.openai.com/v1/responses")
			const inFlight = guardedAsync(mutableUrl)
			mutableUrl.hostname = "evil.example"
			releaseGate()
			await inFlight
			expect(asyncObservedTargets).toEqual(["https://api.openai.com/v1/responses"])

			let bodyGetterCalls = 0
			let headersGetterCalls = 0
			let proxyGetterCalls = 0
			const getterBackedInit: RequestInit = { method: "POST", keepalive: false, redirect: "follow" }
			Object.defineProperty(getterBackedInit, "body", {
				enumerable: true,
				configurable: true,
				get: () => {
					bodyGetterCalls += 1
					return JSON.stringify({ input: "from-lazy-getter" })
				},
			})
			Object.defineProperty(getterBackedInit, "headers", {
				enumerable: true,
				configurable: true,
				get: () => {
					headersGetterCalls += 1
					return { "x-provider-test": "lazy-getter" }
				},
			})
			Object.defineProperty(getterBackedInit, "proxy", {
				enumerable: true,
				configurable: true,
				get: () => {
					proxyGetterCalls += 1
					return "http://127.0.0.1:8081"
				},
			})
			await guardedOkFetch("https://api.openai.com/v1/responses", getterBackedInit)
			expect(bodyGetterCalls).toBe(1)
			expect(headersGetterCalls).toBe(1)
			expect(proxyGetterCalls).toBe(1)
			expect(getterBackedInit.redirect).toBe("follow")
			const lastInit = seenDispatches.at(-1)?.init
			expect(lastInit?.redirect).toBe("manual")
			expect(lastInit?.keepalive).toBe(false)
			expect(lastInit !== undefined && "proxy" in lastInit ? lastInit.proxy : undefined).toBe(
				"http://127.0.0.1:8081",
			)

			const protoPollutingInit: RequestInit = { method: "POST", redirect: "follow" }
			Object.defineProperty(protoPollutingInit, "__proto__", {
				value: {
					proxy: "http://evil.example:9999",
					headers: { authorization: "Bearer injected" },
				},
				enumerable: true,
				configurable: true,
			})
			await guardedOkFetch("https://api.openai.com/v1/responses", protoPollutingInit)
			const copiedProtoInit = seenDispatches.at(-1)?.init
			expect(copiedProtoInit).toBeDefined()
			expect(Object.getPrototypeOf(copiedProtoInit)).toBe(Object.prototype)
			expect(copiedProtoInit?.redirect).toBe("manual")
			expect(copiedProtoInit?.method).toBe("POST")
			expect(copiedProtoInit?.headers).toBeUndefined()
			expect(copiedProtoInit !== undefined && "proxy" in copiedProtoInit).toBe(false)

			const savedGlobalFetch = globalThis.fetch
			const lateBoundTargets: Array<Parameters<typeof fetch>[0]> = []
			try {
				const guardedDefault = createNoRedirectProviderFetch("https://api.openai.com/v1")
				globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => {
					lateBoundTargets.push(input)
					return new Response("ok", { status: 200 })
				}
				await guardedDefault("https://api.openai.com/v1/responses")
			} finally {
				globalThis.fetch = savedGlobalFetch
			}
			expect(lateBoundTargets).toEqual(["https://api.openai.com/v1/responses"])
		} finally {
			redirectorServer.close()
			targetServer.close()
		}
	})

	it.skipIf("Bun" in globalThis)(
		"preserves Node fetch routing, keepalive, headers, and streaming parity in the redirect guard",
		async () => {
			const directReceived: Array<{
				readonly authorization: string | undefined
				readonly header: string | undefined
				readonly contentType: string | undefined
				readonly contentLength: string | undefined
				readonly transferEncoding: string | undefined
				readonly body: string
			}> = []
			const directServer = createServer((req, res) => {
				const chunks: Array<Buffer> = []
				req.on("data", (chunk: Buffer) => {
					chunks.push(chunk)
				})
				req.on("end", () => {
					const rawHeader = req.headers["x-provider-test"]
					directReceived.push({
						authorization: req.headers.authorization,
						header: typeof rawHeader === "string" ? rawHeader : undefined,
						contentType: req.headers["content-type"],
						contentLength: req.headers["content-length"],
						transferEncoding: req.headers["transfer-encoding"],
						body: Buffer.concat(chunks).toString("utf8"),
					})
					res.writeHead(200, { "content-type": "text/plain" })
					res.end("from-direct")
				})
			})
			await new Promise<void>((resolve) => {
				directServer.listen(0, "127.0.0.1", () => resolve())
			})
			const directPort = (directServer.address() as { port: number }).port
			const directBaseUrl = `http://127.0.0.1:${directPort}/v1`
			const directRequestUrl = `${directBaseUrl}/responses`
			try {
				interface NodeDispatchHandler {
					readonly onConnect: (abort: () => void) => void
					readonly onHeaders: (
						statusCode: number,
						headers: ReadonlyArray<Buffer>,
						resume: () => void,
						statusText: string,
					) => void
					readonly onData: (chunk: Buffer) => void
					readonly onComplete: (trailers: ReadonlyArray<Buffer>) => void
				}
				const realGuardedFetch = createNoRedirectProviderFetch(directBaseUrl)

				let dispatcherHits = 0
				const customDispatcher = {
					dispatch(_opts: unknown, handler: NodeDispatchHandler) {
						dispatcherHits += 1
						handler.onConnect(() => undefined)
						handler.onHeaders(
							200,
							[Buffer.from("content-type"), Buffer.from("text/plain")],
							() => undefined,
							"OK",
						)
						handler.onData(Buffer.from("from-configured-transport"))
						handler.onComplete([])
						return true
					},
				}
				const transportInit: RequestInit = {
					method: "POST",
					headers: { "x-provider-test": "transport-routing" },
					body: JSON.stringify({ input: "routed" }),
					keepalive: false,
					redirect: "follow",
				}
				Object.defineProperty(transportInit, "dispatcher", {
					value: customDispatcher,
					enumerable: true,
					configurable: true,
				})
				const routedResponse = await realGuardedFetch(directRequestUrl, transportInit)
				expect(routedResponse.status).toBe(200)
				expect(await routedResponse.text()).toBe("from-configured-transport")
				expect(dispatcherHits).toBe(1)
				expect(directReceived).toHaveLength(0)

				const redirectDispatcher = {
					dispatch(_opts: unknown, handler: NodeDispatchHandler) {
						handler.onConnect(() => undefined)
						handler.onHeaders(
							302,
							[Buffer.from("location"), Buffer.from("https://evil.example/steal")],
							() => undefined,
							"Found",
						)
						handler.onComplete([])
						return true
					},
				}
				const redirectInit: RequestInit = { redirect: "follow" }
				Object.defineProperty(redirectInit, "dispatcher", {
					value: redirectDispatcher,
					enumerable: true,
					configurable: true,
				})
				await expect(realGuardedFetch(directRequestUrl, redirectInit)).rejects.toThrow(/redirect/i)
				expect(directReceived).toHaveLength(0)

				const directKeepaliveRes = await fetch(directRequestUrl, {
					method: "POST",
					headers: { "x-provider-test": "keepalive" },
					body: "hello",
					keepalive: true,
				})
				const directKeepaliveObserved = directReceived.at(-1)
				const guardedKeepaliveRes = await realGuardedFetch(directRequestUrl, {
					method: "POST",
					headers: { "x-provider-test": "keepalive" },
					body: "hello",
					keepalive: true,
				})
				const guardedKeepaliveObserved = directReceived.at(-1)
				expect(guardedKeepaliveRes.status).toBe(directKeepaliveRes.status)
				expect(await guardedKeepaliveRes.text()).toBe(await directKeepaliveRes.text())
				expect(guardedKeepaliveObserved).toEqual(directKeepaliveObserved)
				expect(guardedKeepaliveObserved).toMatchObject({
					header: "keepalive",
					contentLength: "5",
					transferEncoding: undefined,
					body: "hello",
				})

				const clearedHeadersRes = await realGuardedFetch(directRequestUrl, {
					method: "POST",
					headers: {},
					body: "no-auth",
				})
				expect(clearedHeadersRes.status).toBe(200)
				expect(await clearedHeadersRes.text()).toBe("from-direct")
				expect(directReceived.at(-1)?.authorization).toBeUndefined()

				const multipartForm = new FormData()
				multipartForm.set("payload", "multipart-payload")
				const multipartRes = await realGuardedFetch(new URL(directRequestUrl), {
					method: "POST",
					headers: { "x-provider-test": "multipart" },
					body: multipartForm,
					redirect: "follow",
				})
				expect(multipartRes.status).toBe(200)
				expect(await multipartRes.text()).toBe("from-direct")
				const receivedMultipart = directReceived.at(-1)
				expect(receivedMultipart?.header).toBe("multipart")
				const boundaryMatch = receivedMultipart?.contentType?.match(
					/^multipart\/form-data;\s*boundary=(.+)$/i,
				)
				expect(boundaryMatch?.[1]).toBeTruthy()
				expect(receivedMultipart?.body).toContain(`--${boundaryMatch?.[1] ?? ""}`)
				expect(receivedMultipart?.body).toContain("multipart-payload")

				const countBeforeRequestReject = directReceived.length
				const rejectedReq = new Request(directRequestUrl, {
					method: "POST",
					body: "must-not-send",
				})
				await expect(realGuardedFetch(rejectedReq)).rejects.toThrow(
					/only URL strings and URL instances/i,
				)
				expect(rejectedReq.bodyUsed).toBe(false)

				class CredentialedKeepaliveRequest extends Request {
					constructor(input: string, init?: RequestInit) {
						const headers = new Headers(init?.headers)
						if (!headers.has("authorization")) {
							headers.set("authorization", "Bearer subclass-default-secret")
						}
						super(input, { keepalive: true, ...init, headers })
					}
				}
				const credentialedReq = new CredentialedKeepaliveRequest(directRequestUrl, {
					method: "POST",
					body: "subclass-payload",
				})
				await expect(
					realGuardedFetch(credentialedReq, { headers: {}, keepalive: true }),
				).rejects.toThrow(/only URL strings and URL instances/i)
				expect(credentialedReq.bodyUsed).toBe(false)
				expect(directReceived).toHaveLength(countBeforeRequestReject)

				const uploadStream = new PassThrough()
				const uploadError = new Error("upload destroyed before response")
				const transportError = new Error("transport failed after upload destroy")
				const observedStreamErrors: Array<Error> = []
				let listenerCountAtTransport = -1
				const guardedNodeStreamTransport = createNoRedirectProviderFetch(
					directBaseUrl,
					async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
						const forwardedBody = init?.body as unknown as PassThrough
						expect(forwardedBody).toBe(uploadStream)
						listenerCountAtTransport = forwardedBody.listenerCount("error")
						forwardedBody.destroy(uploadError)
						forwardedBody.on("error", (error: Error) => {
							observedStreamErrors.push(error)
						})
						throw transportError
					},
				)
				await expect(
					guardedNodeStreamTransport(directRequestUrl, {
						method: "POST",
						body: uploadStream as unknown as BodyInit,
					}),
				).rejects.toThrow("transport failed after upload destroy")
				await new Promise<void>((resolve) => {
					setImmediate(resolve)
				})
				expect(listenerCountAtTransport).toBe(0)
				expect(observedStreamErrors).toEqual([uploadError])
			} finally {
				directServer.close()
			}
		},
	)

	it.runIf("Bun" in globalThis)(
		"preserves Bun proxy routing and keepalive: false connection behavior in the redirect guard",
		async () => {
			const directReceived: Array<{
				readonly authorization: string | undefined
				readonly contentType: string | undefined
				readonly contentLength: string | undefined
				readonly transferEncoding: string | undefined
				readonly body: string
			}> = []
			const directServer = createServer((req, res) => {
				const chunks: Array<Buffer> = []
				req.on("data", (chunk: Buffer) => {
					chunks.push(chunk)
				})
				req.on("end", () => {
					directReceived.push({
						authorization: req.headers.authorization,
						contentType: req.headers["content-type"],
						contentLength: req.headers["content-length"],
						transferEncoding: req.headers["transfer-encoding"],
						body: Buffer.concat(chunks).toString("utf8"),
					})
					res.writeHead(200, { "content-type": "text/plain" })
					res.end("from-direct")
				})
			})
			let proxyHits = 0
			const proxyBodies: Array<string> = []
			let proxyRespondRedirect = false
			const proxyServer = createServer((req, res) => {
				proxyHits += 1
				const chunks: Array<Buffer> = []
				req.on("data", (chunk: Buffer) => {
					chunks.push(chunk)
				})
				req.on("end", () => {
					proxyBodies.push(Buffer.concat(chunks).toString("utf8"))
					if (proxyRespondRedirect) {
						res.writeHead(302, { location: "https://evil.example/steal" })
						res.end()
						return
					}
					res.writeHead(200, { "content-type": "text/plain" })
					res.end("from-configured-proxy")
				})
			})

			let noReuseConnections = 0
			const noReuseServer = createServer((_req, res) => {
				res.writeHead(200, { "content-type": "text/plain" })
				res.end("ok")
			})
			noReuseServer.on("connection", () => {
				noReuseConnections += 1
			})

			let reuseConnections = 0
			const reuseServer = createServer((_req, res) => {
				res.writeHead(200, { "content-type": "text/plain" })
				res.end("ok")
			})
			reuseServer.on("connection", () => {
				reuseConnections += 1
			})

			await Promise.all([
				new Promise<void>((resolve) => {
					directServer.listen(0, "127.0.0.1", () => resolve())
				}),
				new Promise<void>((resolve) => {
					proxyServer.listen(0, "127.0.0.1", () => resolve())
				}),
				new Promise<void>((resolve) => {
					noReuseServer.listen(0, "127.0.0.1", () => resolve())
				}),
				new Promise<void>((resolve) => {
					reuseServer.listen(0, "127.0.0.1", () => resolve())
				}),
			])

			const directPort = (directServer.address() as { port: number }).port
			const proxyPort = (proxyServer.address() as { port: number }).port
			const noReusePort = (noReuseServer.address() as { port: number }).port
			const reusePort = (reuseServer.address() as { port: number }).port

			try {
				const directBaseUrl = `http://127.0.0.1:${directPort}/v1`
				const guardedProxyFetch = createNoRedirectProviderFetch(directBaseUrl)

				const payload = JSON.stringify({ input: "via-bun-proxy" })
				const proxyInit: RequestInit = {
					method: "POST",
					headers: { "x-provider-test": "bun-proxy" },
					body: payload,
					redirect: "follow",
				}
				Object.defineProperty(proxyInit, "proxy", {
					value: `http://127.0.0.1:${proxyPort}`,
					enumerable: true,
					configurable: true,
				})
				const proxyResponse = await guardedProxyFetch(`${directBaseUrl}/responses`, proxyInit)
				expect(proxyResponse.status).toBe(200)
				expect(await proxyResponse.text()).toBe("from-configured-proxy")
				expect(proxyHits).toBe(1)
				expect(proxyBodies).toEqual([payload])
				expect(directReceived).toHaveLength(0)

				proxyRespondRedirect = true
				const proxyRedirectInit: RequestInit = { redirect: "follow" }
				Object.defineProperty(proxyRedirectInit, "proxy", {
					value: `http://127.0.0.1:${proxyPort}`,
					enumerable: true,
					configurable: true,
				})
				await expect(
					guardedProxyFetch(`${directBaseUrl}/responses`, proxyRedirectInit),
				).rejects.toThrow(/redirect/i)
				expect(proxyHits).toBe(2)
				expect(directReceived).toHaveLength(0)

				const protoProxyInit: RequestInit = { method: "POST", body: "direct-only" }
				Object.defineProperty(protoProxyInit, "__proto__", {
					value: {
						proxy: `http://127.0.0.1:${proxyPort}`,
						headers: { authorization: "Bearer injected" },
					},
					enumerable: true,
					configurable: true,
				})
				const protoRes = await guardedProxyFetch(`${directBaseUrl}/responses`, protoProxyInit)
				expect(protoRes.status).toBe(200)
				expect(await protoRes.text()).toBe("from-direct")
				expect(proxyHits).toBe(2)
				expect(directReceived).toHaveLength(1)
				expect(directReceived[0]?.authorization).toBeUndefined()
				expect(directReceived[0]?.body).toBe("direct-only")

				const noReuseBaseUrl = `http://127.0.0.1:${noReusePort}/v1`
				const guardedNoReuseFetch = createNoRedirectProviderFetch(noReuseBaseUrl)
				for (let call = 0; call < 2; call++) {
					const res = await guardedNoReuseFetch(`${noReuseBaseUrl}/responses`, {
						keepalive: false,
						redirect: "follow",
					})
					expect(res.status).toBe(200)
					expect(await res.text()).toBe("ok")
				}
				expect(noReuseConnections).toBe(2)

				const reuseBaseUrl = `http://127.0.0.1:${reusePort}/v1`
				const guardedReuseFetch = createNoRedirectProviderFetch(reuseBaseUrl)
				for (let call = 0; call < 2; call++) {
					const res = await guardedReuseFetch(`${reuseBaseUrl}/responses`)
					expect(res.status).toBe(200)
					expect(await res.text()).toBe("ok")
				}
				expect(reuseConnections).toBe(1)

				const fixedLengthRes = await guardedProxyFetch(`${directBaseUrl}/responses`, {
					method: "POST",
					body: "abcd",
				})
				expect(fixedLengthRes.status).toBe(200)
				expect(await fixedLengthRes.text()).toBe("from-direct")
				expect(directReceived.at(-1)).toMatchObject({
					contentLength: "4",
					transferEncoding: undefined,
					body: "abcd",
				})

				const emptyPostRes = await guardedProxyFetch(`${directBaseUrl}/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "",
				})
				expect(emptyPostRes.status).toBe(200)
				expect(await emptyPostRes.text()).toBe("from-direct")
				expect(directReceived.at(-1)).toMatchObject({
					contentType: "application/json",
					contentLength: "0",
					transferEncoding: undefined,
					body: "",
				})

				const uploadController = new AbortController()
				let streamCancelled = false
				const uploadStream = new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(new TextEncoder().encode("part"))
						uploadController.abort()
					},
					cancel() {
						streamCancelled = true
					},
				})
				await expect(
					guardedProxyFetch(`${directBaseUrl}/responses`, {
						method: "POST",
						body: uploadStream,
						signal: uploadController.signal,
					}),
				).rejects.toThrow()
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 40)
				})
				expect(streamCancelled).toBe(true)

				const countBeforeReject = directReceived.length
				const rejectedReq = new Request(`${directBaseUrl}/responses`, {
					method: "POST",
					body: "must-not-send",
				})
				await expect(guardedProxyFetch(rejectedReq)).rejects.toThrow(
					/only URL strings and URL instances/i,
				)
				expect(rejectedReq.bodyUsed).toBe(false)
				expect(directReceived).toHaveLength(countBeforeReject)
			} finally {
				directServer.close()
				proxyServer.close()
				noReuseServer.close()
				reuseServer.close()
			}
		},
	)

	it("keeps withLock mutually exclusive even when the lock holder fiber is interrupted mid-critical-section", async () => {
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model) => makeAssistantReply(model, null, "unused", 1, 1)),
		)
		let markEntered!: () => void
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve
		})
		let releaseCritical!: () => void
		const holdCritical = new Promise<void>((resolve) => {
			releaseCritical = resolve
		})
		const events: Array<string> = []
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					try {
						const holder = yield* Effect.forkChild(
							backend.withLock(
								Effect.promise(async () => {
									events.push("holder:start")
									markEntered()
									await holdCritical
									events.push("holder:end")
								}),
							),
							{ startImmediately: true },
						)
						yield* Effect.promise(() => entered)

						const interrupting = yield* Effect.forkChild(Fiber.interrupt(holder), {
							startImmediately: true,
						})
						const waiter = yield* Effect.forkChild(
							backend.withLock(
								Effect.sync(() => {
									events.push("waiter:enter")
								}),
							),
							{ startImmediately: true },
						)
						yield* Effect.sleep("15 millis")
						expect(events).toEqual(["holder:start"])

						releaseCritical()
						yield* Fiber.join(interrupting)
						yield* Fiber.join(waiter)
						expect(events).toEqual(["holder:start", "holder:end", "waiter:enter"])
					} finally {
						releaseCritical()
					}
				}),
			)
		} finally {
			releaseCritical()
			await backend.close()
		}
	})

	it("returns a submitted turn's reply, and stops a cancelled one, when the provider key has since gone", async () => {
		let keyed = true
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model) => makeAssistantReply(model, null, "Saved", 1, 1)),
			1,
			undefined,
			() => keyed,
		)
		const turn = (number: number): PiTurnRequest => ({
			operationId: `turn:${number}`,
			turn: number,
			provider: "openai",
			modelId: "gpt-4o-mini",
			system: null,
			text: "hello",
		})
		try {
			expect(await Effect.runPromise(runPiDurableTurn(backend, turn(1)))).toMatchObject({
				ok: true,
			})
			await Effect.runPromise(backend.abort("turn:2"))
			keyed = false
			expect(await Effect.runPromise(runPiDurableTurn(backend, turn(1)))).toMatchObject({
				ok: true,
				reply: { text: "Saved" },
			})
			expect(await Effect.runPromise(runPiDurableTurn(backend, turn(2)))).toMatchObject({
				ok: false,
				error: { _tag: "TurnInterrupted" },
			})
			expect(await Effect.runPromise(runPiDurableTurn(backend, turn(3)))).toMatchObject({
				ok: false,
				error: { error_type: "missing_api_key_error" },
			})
		} finally {
			await backend.close()
		}
	})

	it("answers for a provider key only when the session object is bound to one", () => {
		const backend = makePiHarnessBackend(
			{} as unknown as Parameters<typeof makePiHarnessBackend>[0],
			{} as unknown as Parameters<typeof makePiHarnessBackend>[1],
			{ openai: Redacted.make("sk-test"), anthropic: null },
			() => undefined,
			() => Promise.resolve(true),
		)
		expect(backend.hasApiKey("openai")).toBe(true)
		expect(backend.hasApiKey("anthropic")).toBe(false)
	})

	it("keeps a queued abort alive when interrupted while submit holds the permit", async () => {
		const cancelled = new Set<string>()
		const harnessAborts: Array<string> = []
		const harnessBackend = makePiHarnessBackend(
			{
				pi: async () => ({
					commit: async <T>(
						change: (tx: {
							submissionByRequest: (conversation: string, operationId: string) => undefined
						}) => T,
					): Promise<T> =>
						change({
							submissionByRequest: (_conversation, operationId) => {
								harnessAborts.push(operationId)
								return undefined
							},
						}),
				}),
			} as unknown as Parameters<typeof makePiHarnessBackend>[0],
			{
				markCancelled: (operationId: string) => {
					cancelled.add(operationId)
				},
				isCancelled: (operationId: string) => cancelled.has(operationId),
			} as unknown as Parameters<typeof makePiHarnessBackend>[1],
			{ openai: null, anthropic: null },
			() => undefined,
			() => Promise.resolve(true),
		)
		let markSubmitHeld!: () => void
		const submitHeld = new Promise<void>((resolve) => {
			markSubmitHeld = resolve
		})
		let releaseSubmitHold!: () => void
		const holdSubmit = new Promise<void>((resolve) => {
			releaseSubmitHold = resolve
		})
		await Effect.runPromise(
			Effect.gen(function* () {
				try {
					const holder = yield* Effect.forkChild(
						harnessBackend.withLock(
							Effect.promise(async () => {
								markSubmitHeld()
								await holdSubmit
							}),
						),
						{ startImmediately: true },
					)
					yield* Effect.promise(() => submitHeld)

					const abortFiber = yield* Effect.forkChild(harnessBackend.abort("turn:1"), {
						startImmediately: true,
					})
					expect(harnessBackend.isCancelled("turn:1")).toBe(true)
					expect(harnessAborts).toEqual([])

					const interrupting = yield* Effect.forkChild(Fiber.interrupt(abortFiber), {
						startImmediately: true,
					})
					yield* Effect.sleep("15 millis")
					expect(harnessAborts).toEqual([])

					releaseSubmitHold()
					yield* Fiber.join(holder)
					yield* Fiber.join(interrupting)
					expect(harnessAborts).toEqual(["turn:1"])
				} finally {
					releaseSubmitHold()
				}
			}),
		)

		let markEnteredSubmit!: () => void
		const enteredSubmit = new Promise<void>((resolve) => {
			markEnteredSubmit = resolve
		})
		let releaseSubmit!: () => void
		const submitGate = new Promise<void>((resolve) => {
			releaseSubmit = resolve
		})
		const rawBackend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, _context, signal) => {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					const timer = setTimeout(resolve, 150)
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer)
							resolve()
						},
						{ once: true },
					)
				})
				if (signal?.aborted) {
					return { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" as const }
				}
				return makeAssistantReply(model, null, "should have been aborted", 5, 3)
			}),
		)
		const backend: PiDurableBackend = {
			...rawBackend,
			submit: async (text, operationId) => {
				markEnteredSubmit()
				await submitGate
				return rawBackend.submit(text, operationId)
			},
		}
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					try {
						const turnFiber = yield* Effect.forkChild(
							runPiDurableTurn(backend, {
								operationId: "turn:1",
								turn: 1,
								provider: "openai",
								modelId: "gpt-4o-mini",
								system: null,
								text: "abort while submit holds permit",
							}),
							{ startImmediately: true },
						)
						yield* Effect.promise(() => enteredSubmit)

						const abortFiber = yield* Effect.forkChild(backend.abort("turn:1"), {
							startImmediately: true,
						})
						expect(backend.isCancelled("turn:1")).toBe(true)

						const interrupting = yield* Effect.forkChild(Fiber.interrupt(abortFiber), {
							startImmediately: true,
						})
						yield* Effect.sleep("15 millis")

						releaseSubmit()
						yield* Fiber.join(interrupting)

						const outcome = yield* Fiber.join(turnFiber)
						expect(outcome).toMatchObject({
							ok: false,
							error: { _tag: "TurnInterrupted" },
						})
						const recovered = yield* recoverPiDurableTurn(backend, "turn:1")
						expect(recovered).toMatchObject({
							ok: false,
							error: { _tag: "TurnInterrupted" },
						})
					} finally {
						releaseSubmit()
					}
				}),
			)
		} finally {
			releaseSubmit()
			await rawBackend.close()
		}
	})

	it("restricts CHECKFU_OPENAI_BASE_URL to loopback URLs and disables it in production and non-dev plans", async () => {
		expect(parseLoopbackBaseUrl("http://127.0.0.1:4321/v1/")).toBe("http://127.0.0.1:4321/v1")
		expect(parseLoopbackBaseUrl("http://[::1]:4321/v1")).toBe("http://[::1]:4321/v1")
		expect(parseLoopbackBaseUrl("http://127.0.0.1:80/v1/")).toBe("http://127.0.0.1:80/v1")
		expect(parseLoopbackBaseUrl("http://[::1]:80/v1")).toBe("http://[::1]:80/v1")
		expect(parseLoopbackBaseUrl(parseLoopbackBaseUrl("http://127.0.0.1:80/v1"))).toBe(
			"http://127.0.0.1:80/v1",
		)

		for (const rejected of [
			"not-a-url",
			"https://api.openai.com/v1",
			"https://127.0.0.1:4321/v1",
			"http://example.com:4321/v1",
			"http://localhost:4321/v1",
			"http://127.0.0.1/v1",
			"http://[::1]/v1",
			"http://127.0.0.1:0/v1",
			"http://user:pass@127.0.0.1:4321/v1",
			"http://127.0.0.1:4321/v1?",
			"http://127.0.0.1:4321/v1?x=1",
			"http://127.0.0.1:4321/v1#",
			"http://127.0.0.1:4321/v1#frag",
		]) {
			expect(() => parseLoopbackBaseUrl(rejected)).toThrow(TypeError)
		}

		const runWithConfig = (env: Record<string, string>) =>
			Effect.runPromise(
				providerBaseUrls.pipe(
					Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
				),
			)

		expect(await runWithConfig({})).toEqual({ openai: null })
		expect(
			await runWithConfig({
				ALCHEMY_STAGE: "staging",
				[OPENAI_BASE_URL_ENV]: "http://127.0.0.1:4321/v1/",
			}),
		).toEqual({ openai: null })
		expect(
			await runWithConfig({
				ALCHEMY_STAGE: "dev-local",
				[LOCAL_DEV_SIGNAL_ENV]: LOCAL_DEV_SIGNAL_VALUE,
				[OPENAI_BASE_URL_ENV]: "http://127.0.0.1:4321/v1/",
			}),
		).toEqual({ openai: "http://127.0.0.1:4321/v1" })
		expect(
			await runWithConfig({
				ALCHEMY_STAGE: "production",
				[LOCAL_DEV_SIGNAL_ENV]: LOCAL_DEV_SIGNAL_VALUE,
				[OPENAI_BASE_URL_ENV]: "https://evil.example/v1",
			}),
		).toEqual({ openai: null })

		const readKeys: Array<string> = []
		const boundSignals: Array<string> = []
		const trackingRuntimeContext: BaseRuntimeContext = {
			Type: "test",
			id: "test",
			env: {},
			get: () => Effect.undefined,
			set: (key, _output) => {
				boundSignals.push(key)
				return Effect.succeed(key)
			},
		}
		const trackingConfig = ConfigProvider.make((path) => {
			readKeys.push(path.join("_"))
			return Effect.succeed(
				path[0] === OPENAI_BASE_URL_ENV
					? ConfigProvider.makeValue("http://127.0.0.1:4321/v1")
					: undefined,
			)
		})
		const deployPlanResult = await Effect.runPromise(
			providerBaseUrls.pipe(
				Effect.provideService(AlchemyContext, {
					dotAlchemy: ".alchemy",
					dev: false,
					adopt: false,
				}),
				Effect.provideService(Stage, "staging"),
				Effect.provideService(RuntimeContext, trackingRuntimeContext),
				Effect.provide(ConfigProvider.layer(trackingConfig)),
			),
		)
		expect(deployPlanResult).toEqual({ openai: null })
		expect(readKeys).toEqual([])
		expect(boundSignals).toEqual([])

		const devProdStageResult = await Effect.runPromise(
			providerBaseUrls.pipe(
				Effect.provideService(AlchemyContext, {
					dotAlchemy: ".alchemy",
					dev: true,
					adopt: false,
				}),
				Effect.provideService(Stage, "production"),
				Effect.provideService(RuntimeContext, trackingRuntimeContext),
				Effect.provide(ConfigProvider.layer(trackingConfig)),
			),
		)
		expect(devProdStageResult).toEqual({ openai: null })
		expect(readKeys).toEqual([])
		expect(boundSignals).toEqual([])

		const devStageResult = await Effect.runPromise(
			providerBaseUrls.pipe(
				Effect.provideService(AlchemyContext, {
					dotAlchemy: ".alchemy",
					dev: true,
					adopt: false,
				}),
				Effect.provideService(Stage, "workerd-test"),
				Effect.provideService(RuntimeContext, trackingRuntimeContext),
				Effect.provide(ConfigProvider.layer(trackingConfig)),
			),
		)
		expect(devStageResult).toEqual({ openai: "http://127.0.0.1:4321/v1" })
		expect(readKeys).toEqual([
			OPENAI_BASE_URL_ENV,
			OPENROUTER_BASE_URL_ENV,
			CLOUDFLARE_AI_GATEWAY_BASE_URL_ENV,
			CLOUDFLARE_WORKERS_AI_BASE_URL_ENV,
		])
		expect(boundSignals).toEqual([LOCAL_DEV_SIGNAL_ENV])

		const overridden = createPiModels(
			{ openai: Redacted.make("sk-test"), anthropic: null },
			{ openai: "http://127.0.0.1:4321/v1" },
		)
		expect(overridden.getModel("openai", "gpt-4o-mini")?.baseUrl).toBe("http://127.0.0.1:4321/v1")
		expect(overridden.getModel("anthropic", "claude-sonnet-4-5")?.baseUrl).toBe(
			DEFAULT_ANTHROPIC_BASE_URL,
		)

		const port80BaseUrls = await runWithConfig({
			ALCHEMY_STAGE: "dev-local",
			[LOCAL_DEV_SIGNAL_ENV]: LOCAL_DEV_SIGNAL_VALUE,
			[OPENAI_BASE_URL_ENV]: "http://127.0.0.1:80/v1",
		})
		expect(port80BaseUrls).toEqual({ openai: "http://127.0.0.1:80/v1" })
		const port80Models = createPiModels(
			{ openai: Redacted.make("sk-test"), anthropic: null },
			port80BaseUrls,
		)
		expect(port80Models.getModel("openai", "gpt-4o-mini")?.baseUrl).toBe("http://127.0.0.1:80/v1")

		const defaults = createPiModels({ openai: null, anthropic: null })
		expect(defaults.getModel("openai", "gpt-4o-mini")?.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL)
	})

	it("resets a session object whose stuck turn ignores abort, and runs the next turn once it reopens", async () => {
		const prompts: Array<string> = []
		const models = makeScriptedPiModels((model, context) => {
			const prompt = extractLastUserText(context)
			prompts.push(prompt)
			return prompt === "hang"
				? new Promise<AssistantMessage>(() => {})
				: Promise.resolve(makeAssistantReply(model, null, `Echo: ${prompt}`, 1, 1))
		})
		let resets = 0
		let object: InMemoryPiDurableBackend
		const open = (storage?: InMemoryStorage): Promise<InMemoryPiDurableBackend> =>
			createInMemoryPiDurableBackend(models, 1, undefined, undefined, {
				...(storage === undefined ? {} : { storage }),
				reset: Effect.andThen(
					Effect.promise(async () => {
						resets += 1
						object = await open(object.storage)
					}),
					Effect.die(new Error("The Pi session object was reset")),
				),
			})
		const turn = (number: number, text: string): PiTurnRequest => ({
			operationId: `turn:${number}`,
			turn: number,
			provider: "openai",
			modelId: "gpt-4o-mini",
			system: null,
			text,
		})
		const runNext = () =>
			Effect.runPromiseExit(
				runPiDurableTurn(object, turn(2, "next")).pipe(
					Effect.provideService(AbortGrace, "30 millis"),
				),
			)

		object = await open()
		void Effect.runPromiseExit(runPiDurableTurn(object, turn(1, "hang")))
		while (prompts.length === 0) {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 5)
			})
		}

		expect(Exit.isFailure(await runNext())).toBe(true)
		expect(resets).toBe(1)

		const next = await runNext()
		expect(Exit.isSuccess(next) && next.value).toMatchObject({
			ok: true,
			reply: { text: "Echo: next" },
		})
		expect(resets).toBe(1)
		expect(prompts).toEqual(["hang", "next"])
		expect(await Effect.runPromise(recoverPiDurableTurn(object, "turn:1"))).toMatchObject({
			ok: false,
			error: { _tag: "TurnInterrupted" },
		})
	}, 20_000)

	it("refuses a turn older than one the conversation already admitted, without touching the newer one", async () => {
		const prompts: Array<string> = []
		let releaseSecond: () => void = () => undefined
		const secondHeld = new Promise<void>((resolve) => {
			releaseSecond = resolve
		})
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context) => {
				const prompt = extractLastUserText(context)
				prompts.push(prompt)
				if (prompt === "second") {
					await secondHeld
				}
				return makeAssistantReply(model, null, `Echo: ${prompt}`, 1, 1)
			}),
		)
		const turn = (number: number, text: string): PiTurnRequest => ({
			operationId: `turn:${number}`,
			turn: number,
			provider: "openai",
			modelId: "gpt-4o-mini",
			system: null,
			text,
		})
		const interrupted = { ok: false, error: { _tag: "TurnInterrupted" } }
		try {
			const second = Effect.runPromise(runPiDurableTurn(backend, turn(2, "second")))
			while (prompts.length === 0) {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 5)
				})
			}
			expect(await Effect.runPromise(runPiDurableTurn(backend, turn(1, "late")))).toMatchObject(
				interrupted,
			)
			expect(backend.isCancelled("turn:2")).toBe(false)
			releaseSecond()
			expect(await second).toMatchObject({ ok: true, reply: { text: "Echo: second" } })

			expect(await Effect.runPromise(runPiDurableTurn(backend, turn(1, "late")))).toMatchObject(
				interrupted,
			)
			expect(prompts).toEqual(["second"])
		} finally {
			releaseSecond()
			await backend.close()
		}
	})
	it("publishes what a turn brings for MCP only once it is the admitted turn, and lists tools outside admission", async () => {
		const prompts: Array<string> = []
		let releaseSecond: () => void = () => undefined
		const secondHeld = new Promise<void>((resolve) => {
			releaseSecond = resolve
		})
		const inner = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context) => {
				const prompt = extractLastUserText(context)
				prompts.push(prompt)
				if (prompt === "second") {
					await secondHeld
				}
				return makeAssistantReply(model, null, `Echo: ${prompt}`, 1, 1)
			}),
		)
		const published: Array<number> = []
		const discovered: Array<number> = []
		let locked = false
		let listedUnderLock = false
		const backend: PiDurableBackend = {
			...inner,
			withLock: (effect) =>
				inner.withLock(
					Effect.acquireUseRelease(
						Effect.sync(() => {
							locked = true
						}),
						() => effect,
						() =>
							Effect.sync(() => {
								locked = false
							}),
					),
				),
			publishMcp: async (request) => {
				published.push(request.turn)
				return !discovered.includes(request.turn)
			},
			discoverMcp: async (request) => {
				listedUnderLock ||= locked
				discovered.push(request.turn)
			},
		}
		const turn = (number: number, text: string, allowed: string): PiTurnRequest => ({
			operationId: `turn:${number}`,
			turn: number,
			provider: "openai",
			modelId: "gpt-4o-mini",
			system: null,
			text,
			mcp: {
				servers: [],
				networking: {
					type: "limited",
					allow_mcp_servers: false,
					allow_package_managers: false,
					allowed_hosts: [allowed],
				},
			},
		})
		try {
			const second = Effect.runPromise(runPiDurableTurn(backend, turn(2, "second", "new.example")))
			while (prompts.length === 0) {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 5)
				})
			}
			expect(published).toEqual([2, 2])
			expect(discovered).toEqual([2])
			expect(listedUnderLock).toBe(false)

			expect(
				await Effect.runPromise(runPiDurableTurn(backend, turn(1, "late", "old.example"))),
			).toMatchObject({ ok: false, error: { _tag: "TurnInterrupted" } })
			const again = Effect.runPromise(runPiDurableTurn(backend, turn(2, "second", "old.example")))
			releaseSecond()
			expect(await second).toMatchObject({ ok: true, reply: { text: "Echo: second" } })
			expect(await again).toMatchObject({ ok: true, reply: { text: "Echo: second" } })
			expect(published).toEqual([2, 2])
			expect(discovered).toEqual([2])
			expect(prompts).toEqual(["second"])
		} finally {
			releaseSecond()
			await inner.close()
		}
	})

	it("stops listing MCP tools when the turn is cancelled, and does not start the turn", async () => {
		const cancelled = new Set<string>()
		const inner = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model) => makeAssistantReply(model, null, "never", 1, 1)),
		)
		const harnessBackend = makePiHarnessBackend(
			{ pi: () => inner.pi() } as unknown as Parameters<typeof makePiHarnessBackend>[0],
			{
				markCancelled: (operationId: string) => {
					cancelled.add(operationId)
				},
				isCancelled: (operationId: string) => cancelled.has(operationId),
			} as unknown as Parameters<typeof makePiHarnessBackend>[1],
			{ openai: Redacted.make("sk-test"), anthropic: null },
			() => undefined,
			() => Promise.resolve(true),
		)
		let listing: () => void = () => undefined
		const started = new Promise<void>((resolve) => {
			listing = resolve
		})
		let stopped = false
		const backend: PiDurableBackend = {
			...inner,
			isCancelled: harnessBackend.isCancelled,
			abort: harnessBackend.abort,
			untilCancelled: harnessBackend.untilCancelled!,
			publishMcp: () => Promise.resolve(true),
			discoverMcp: (_request, signal) =>
				new Promise<void>((resolve) => {
					listing()
					signal.addEventListener("abort", () => {
						stopped = true
						resolve()
					})
				}),
		}
		try {
			const running = Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:1",
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "cancel me",
					mcp: { servers: [], networking: null },
				}),
			)
			await started
			await Effect.runPromise(backend.abort("turn:1"))
			expect(await running).toMatchObject({ ok: false, error: { _tag: "TurnInterrupted" } })
			expect(stopped).toBe(true)
			expect(
				await inner.storage.submissionByRequest(ROOT_CONVERSATION_ID, "turn:1", BACKGROUND_CONTEXT),
			).toBeUndefined()
		} finally {
			await inner.close()
		}
	})

	it("lets a reset session object neither read nor write the storage the next one owns", async () => {
		const models = makeScriptedPiModels(async (model, context) =>
			makeAssistantReply(model, null, `Echo ${extractLastUserText(context)}`, 1, 1),
		)
		const turn = (number: number, text: string): PiTurnRequest => ({
			operationId: `turn:${number}`,
			turn: number,
			provider: "openai",
			modelId: "gpt-4o-mini",
			system: null,
			text,
		})
		const first = await createInMemoryPiDurableBackend(models)
		expect(await Effect.runPromise(runPiDurableTurn(first, turn(1, "before")))).toMatchObject({
			ok: true,
		})
		first.retire()
		const second = await createInMemoryPiDurableBackend(models, 1, undefined, undefined, {
			storage: first.storage,
		})
		try {
			await expect(first.submit("late", "turn:9")).rejects.toThrow()
			await expect(first.wait("turn:1")).rejects.toThrow("This session object was reset")
			expect(() => first.isCancelled("turn:1")).toThrow("This session object was reset")
			const stored = (operationId: string) =>
				second.storage.submissionByRequest(ROOT_CONVERSATION_ID, operationId, BACKGROUND_CONTEXT)
			expect(await stored("turn:1")).toBeDefined()
			expect(await stored("turn:9")).toBeUndefined()
			expect(await Effect.runPromise(runPiDurableTurn(second, turn(2, "after")))).toMatchObject({
				ok: true,
				reply: { text: "Echo after" },
			})
		} finally {
			await second.close()
		}
	})

	it("synchronizes recoverPiDurableTurn with an in-progress admission before submit", async () => {
		let markEnteredEnsureRoot!: () => void
		const enteredEnsureRoot = new Promise<void>((resolve) => {
			markEnteredEnsureRoot = resolve
		})
		let releaseLockStep!: () => void
		const holdLockStep = new Promise<void>((resolve) => {
			releaseLockStep = resolve
		})

		const rawBackend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model) =>
				makeAssistantReply(model, null, "Committed after disconnect", 8, 4),
			),
		)
		const backend = {
			...rawBackend,
			ensureRoot: async (agent: Parameters<typeof rawBackend.ensureRoot>[0]) => {
				markEnteredEnsureRoot()
				await holdLockStep
				return rawBackend.ensureRoot(agent)
			},
		}

		try {
			const originalTurn = Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:1",
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "hello",
				}),
			)
			await enteredEnsureRoot

			let recoverySettled = false
			const recovery = Effect.runPromise(recoverPiDurableTurn(backend, "turn:1")).then(
				(outcome) => {
					recoverySettled = true
					return outcome
				},
			)
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 15)
			})
			expect(recoverySettled).toBe(false)

			releaseLockStep()
			const [originalResult, recoveredResult] = await Promise.all([originalTurn, recovery])
			expect(originalResult).toMatchObject({ ok: true })
			expect(recoveredResult).not.toBeNull()
			expect(recoveredResult?.ok === true ? recoveredResult.reply.text : null).toBe(
				"Committed after disconnect",
			)
		} finally {
			releaseLockStep()
			await rawBackend.close()
		}
	})
	it("resets a stuck session object even when the caller stops waiting for the abort", async () => {
		const real = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model) => makeAssistantReply(model, null, "unused", 1, 1)),
		)
		let resets = 0
		const stuck: PiDurableBackend = {
			...real,
			abort: () => Effect.never,
			reset: Effect.andThen(
				Effect.sync(() => {
					resets += 1
				}),
				Effect.never,
			),
		}
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const waiting = yield* Effect.forkChild(abortPiDurableTurn(stuck, "turn:1"))
					yield* Effect.sleep("5 millis")
					yield* Fiber.interrupt(waiting)
					yield* Effect.sleep("100 millis")
				}).pipe(Effect.provideService(AbortGrace, "20 millis")),
			)
			expect(resets).toBe(1)
		} finally {
			await real.close()
		}
	})
	it("keeps every turn the session did not publish out of the next turn's context, even after Pi answered it", async () => {
		const contexts: Array<string> = []
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context) => {
				contexts.push(
					context.messages
						.map((message) =>
							typeof message.content === "string"
								? message.content
								: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
						)
						.join(" | "),
				)
				return makeAssistantReply(model, null, `Echo ${extractLastUserText(context)}`, 1, 1)
			}),
		)
		const turn = (
			number: number,
			text: string,
			unpublished: ReadonlyArray<number> = [],
		): PiTurnRequest => ({
			operationId: `turn:${number}`,
			turn: number,
			provider: "openai",
			modelId: "gpt-4o-mini",
			system: null,
			text,
			unpublishedOperationIds: unpublished.map((n) => `turn:${n}`),
		})
		try {
			await Effect.runPromise(runPiDurableTurn(backend, turn(1, "lost")))
			const conversation = await (
				await backend.pi()
			).conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
			if (conversation === undefined) {
				throw new Error("The session has no conversation.")
			}
			const entries = vi.spyOn(
				Object.getPrototypeOf(conversation) as typeof conversation,
				"entries",
			)
			const scans = () =>
				entries.mock.calls.filter(
					([query]) => query.order === "ascending" && query.maxEntryId === undefined,
				).length
			await Effect.runPromise(runPiDurableTurn(backend, turn(2, "also lost", [1])))
			const afterFirst = scans()
			await Effect.runPromise(runPiDurableTurn(backend, turn(3, "kept", [1, 2])))
			await Effect.runPromise(runPiDurableTurn(backend, turn(4, "next")))
			expect(contexts).toEqual(["lost", "also lost", "kept", "kept | Echo kept | next"])
			// Turn 1's omission is recorded once; turn 3 reads only turn 2's entries, not turn 1's again.
			expect(scans() - afterFirst).toBe(1)
		} finally {
			vi.restoreAllMocks()
			await backend.close()
		}
	})
	it("makes a recovery probe wait while the same turn's admission waits for a predecessor to drain", async () => {
		let releaseFirst: () => void = () => undefined
		const firstHeld = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const prompts: Array<string> = []
		const real = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context) => {
				const prompt = extractLastUserText(context)
				prompts.push(prompt)
				if (prompt === "first") {
					await firstHeld
				}
				return makeAssistantReply(model, null, `Echo ${prompt}`, 1, 1)
			}),
		)
		let releaseDrain: () => void = () => undefined
		const drainHeld = new Promise<void>((resolve) => {
			releaseDrain = resolve
		})
		let draining = false
		const backend: PiDurableBackend = {
			...real,
			abort: () => Effect.succeed(true),
			wait: async (operationId, signal) => {
				if (operationId === "turn:1") {
					draining = true
					await drainHeld
				}
				return real.wait(operationId, signal)
			},
		}
		const turn = (number: number, text: string): PiTurnRequest => ({
			operationId: `turn:${number}`,
			turn: number,
			provider: "openai",
			modelId: "gpt-4o-mini",
			system: null,
			text,
		})
		const until = async (condition: () => boolean) => {
			while (!condition()) {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 5)
				})
			}
		}
		try {
			const first = Effect.runPromise(runPiDurableTurn(real, turn(1, "first")))
			await until(() => prompts.length === 1)
			const second = Effect.runPromise(runPiDurableTurn(backend, turn(2, "second")))
			await until(() => draining)
			let probed = false
			const recovery = Effect.runPromise(recoverPiDurableTurn(backend, "turn:2")).then(
				(outcome) => {
					probed = true
					return outcome
				},
			)
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 30)
			})
			expect(probed).toBe(false)
			releaseFirst()
			releaseDrain()
			await first
			expect(await second).toMatchObject({ ok: true, reply: { text: "Echo second" } })
			expect(await recovery).toMatchObject({ ok: true, reply: { text: "Echo second" } })
		} finally {
			releaseFirst()
			releaseDrain()
			await real.close()
		}
	})
	it("keeps a recovery probe waiting while any of a turn's overlapping admissions is still under way", async () => {
		let releaseFirst: () => void = () => undefined
		const firstHeld = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const prompts: Array<string> = []
		const real = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context) => {
				const prompt = extractLastUserText(context)
				prompts.push(prompt)
				if (prompt === "first") {
					await firstHeld
				}
				return makeAssistantReply(model, null, `Echo ${prompt}`, 1, 1)
			}),
		)
		let releaseDrain: () => void = () => undefined
		const drainHeld = new Promise<void>((resolve) => {
			releaseDrain = resolve
		})
		let draining = 0
		const backend: PiDurableBackend = {
			...real,
			abort: () => Effect.succeed(true),
			wait: async (operationId, signal) => {
				if (operationId === "turn:1") {
					draining += 1
					await drainHeld
				}
				return real.wait(operationId, signal)
			},
		}
		const turn = (number: number, text: string): PiTurnRequest => ({
			operationId: `turn:${number}`,
			turn: number,
			provider: "openai",
			modelId: "gpt-4o-mini",
			system: null,
			text,
		})
		const until = async (condition: () => boolean) => {
			while (!condition()) {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 5)
				})
			}
		}
		try {
			const first = Effect.runPromise(runPiDurableTurn(real, turn(1, "first")))
			await until(() => prompts.length === 1)
			const original = Effect.runPromise(runPiDurableTurn(backend, turn(2, "second")))
			await until(() => draining === 1)
			const retry = Effect.runFork(runPiDurableTurn(backend, turn(2, "second")))
			await until(() => draining === 2)
			await Effect.runPromise(Fiber.interrupt(retry))
			let probed = false
			const recovery = Effect.runPromise(recoverPiDurableTurn(backend, "turn:2")).then(
				(outcome) => {
					probed = true
					return outcome
				},
			)
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 30)
			})
			expect(probed).toBe(false)
			releaseFirst()
			releaseDrain()
			await first
			expect(await original).toMatchObject({ ok: true, reply: { text: "Echo second" } })
			expect(await recovery).toMatchObject({ ok: true, reply: { text: "Echo second" } })
		} finally {
			releaseFirst()
			releaseDrain()
			await real.close()
		}
	})
})
