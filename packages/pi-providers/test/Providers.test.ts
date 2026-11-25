import type { AssistantMessage } from "@earendil-works/pi-ai"
import { createProvider } from "@earendil-works/pi-ai/models"
import { describe, expect, it } from "vitest"
import {
	BUILTIN_PROVIDERS,
	DEFAULT_MIN_CONTEXT_WINDOW,
	MAX_MODEL_ID_LENGTH,
	checkProviderCredentials,
	defineProvider,
	inferProviderForApiKey,
	parseLoopbackBaseUrl,
	parseProviderBaseUrl,
	providerRequiredSecretEnvs,
	resolveModelSpecifier,
} from "../src/Catalog.ts"
import {
	DEFAULT_REFUSAL_TEXT,
	OPENAI_COMPLETIONS_CONTENT_FILTER_ERROR,
	isRefusalAssistantMessage,
	isWireFormatRefusalStopReason,
	normalizeRefusalAssistantMessage,
} from "../src/Refusals.ts"
import {
	buildPiProvider,
	createNoRedirectProviderFetch,
	createOpenAICompletionsWire,
	createOpenAIResponsesWire,
	createProviderModels,
} from "../src/Runtime.ts"

describe("@checkfu/pi-providers catalog & registry", () => {
	it("resolves bare and explicit built-in models while rejecting undersized legacy models", () => {
		expect(resolveModelSpecifier("gpt-4o-mini")).toEqual({
			provider: "openai",
			modelId: "gpt-4o-mini",
			cataloged: true,
		})
		expect(resolveModelSpecifier("claude-sonnet-5-5")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-5-5",
			cataloged: true,
		})
		expect(resolveModelSpecifier("openai/gpt-4o-mini")).toEqual({
			provider: "openai",
			modelId: "gpt-4o-mini",
			cataloged: true,
		})
		expect(resolveModelSpecifier("gpt-4")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4")).toBeNull()
		expect(resolveModelSpecifier("openai/computer-use-preview")).toBeNull()
		expect(resolveModelSpecifier("openai/computer-use-preview-2025-03-11")).toBeNull()
		expect(
			resolveModelSpecifier("openai/computer-use-preview-2025-03-11", { minContextWindow: 4096 }),
		).toEqual({
			provider: "openai",
			modelId: "computer-use-preview-2025-03-11",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/gpt-audio")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-audio-1.5")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-audio-mini")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4o-audio-preview")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4o-search-preview")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-5-search-api")).toBeNull()
		expect(
			resolveModelSpecifier("openai/gpt-3.5-turbo-instruct", { minContextWindow: 4096 }),
		).toBeNull()
		expect(
			resolveModelSpecifier("openai/gpt-3.5-turbo-instruct-0914", { minContextWindow: 1024 }),
		).toBeNull()
		expect(
			resolveModelSpecifier("openai/ft:gpt-3.5-turbo-instruct:org:helper:id", {
				minContextWindow: 1024,
			}),
		).toBeNull()
		expect(resolveModelSpecifier("openai/ft:gpt-4o-mini:org:my-transcribe-helper:id")).toEqual({
			provider: "openai",
			modelId: "ft:gpt-4o-mini:org:my-transcribe-helper:id",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/ft:gpt-4o-mini:org:my-search-preview-bot:id")).toEqual({
			provider: "openai",
			modelId: "ft:gpt-4o-mini:org:my-search-preview-bot:id",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/ft:gpt-4o-mini:org:my-audio-preview-bot:id")).toEqual({
			provider: "openai",
			modelId: "ft:gpt-4o-mini:org:my-audio-preview-bot:id",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/ft:gpt-4o-transcribe:org:chat-helper:id")).toBeNull()
		expect(resolveModelSpecifier("openai/ft:gpt-4o-search-preview:org:chat-helper:id")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-future-2027")).toEqual({
			provider: "openai",
			modelId: "gpt-future-2027",
			cataloged: false,
		})
		const maxOkId = `openai/${"a".repeat(MAX_MODEL_ID_LENGTH - "openai/".length)}`
		expect(resolveModelSpecifier(maxOkId)).toEqual({
			provider: "openai",
			modelId: "a".repeat(MAX_MODEL_ID_LENGTH - "openai/".length),
			cataloged: false,
		})
		expect(resolveModelSpecifier(`${maxOkId}x`)).toBeNull()
		expect(resolveModelSpecifier("gemini-2.5-flash")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-future-2027")).toEqual({
			provider: "openai",
			modelId: "gpt-future-2027",
			cataloged: false,
		})
		expect(resolveModelSpecifier("anthropic/claude-future-6")).toEqual({
			provider: "anthropic",
			modelId: "claude-future-6",
			cataloged: false,
		})
		expect(resolveModelSpecifier("unknown-provider/foo")).toBeNull()
		expect(resolveModelSpecifier("openai/")).toBeNull()
		expect(resolveModelSpecifier("openai/has spaces")).toBeNull()
	})

	it("collects secret env vars and infers providers by longest key prefix", () => {
		expect(providerRequiredSecretEnvs(BUILTIN_PROVIDERS)).toEqual([
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
		])
		expect(inferProviderForApiKey("sk-ant-api03-123")?.id).toBe("anthropic")
		expect(inferProviderForApiKey("sk-proj-123")?.id).toBe("openai")
		expect(inferProviderForApiKey("unknown-prefix")).toBeUndefined()
	})

	it("validates HTTPS base URLs and blocks private/loopback targets outside local dev", () => {
		expect(parseProviderBaseUrl("https://api.example.com/v1/", { allowLoopbackHttp: false })).toBe(
			"https://api.example.com/v1",
		)
		expect(parseProviderBaseUrl("http://127.0.0.1:11434/v1/", { allowLoopbackHttp: true })).toBe(
			"http://127.0.0.1:11434/v1",
		)
		expect(() =>
			parseProviderBaseUrl("http://127.0.0.1:11434/v1", { allowLoopbackHttp: false }),
		).toThrow(/https:\/\//)
		for (const disallowed of [
			"https://127.0.0.1/v1",
			"https://localhost/v1",
			"https://169.254.169.254/latest",
			"https://10.0.0.1/v1",
			"https://192.168.1.5/v1",
			"https://[::1]/v1",
			"https://user:pass@api.example.com/v1",
			"https://api.example.com/v1?foo=bar",
			"https://api.example.com/v1#frag",
		]) {
			expect(() => parseProviderBaseUrl(disallowed, { allowLoopbackHttp: false })).toThrow(
				TypeError,
			)
		}
		expect(parseLoopbackBaseUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1")
	})

	it("checks credentials across bearer, api_key_header, none, and secretHeaders", () => {
		const bearer = defineProvider({
			id: "acme",
			name: "Acme",
			source: "custom",
			defaultModel: "acme/model-1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://api.acme.example/v1",
			auth: { kind: "bearer", env: "ACME_KEY", label: "Acme key" },
			secretHeaders: { "x-gw": "ACME_GW_TOKEN" },
		})
		expect(checkProviderCredentials(bearer, { env: {} })).toEqual({
			ok: false,
			missing: ["ACME_KEY", "ACME_GW_TOKEN"],
			message: 'Missing ACME_KEY, ACME_GW_TOKEN for provider "acme".',
		})
		expect(
			checkProviderCredentials(bearer, { env: { ACME_KEY: "k", ACME_GW_TOKEN: "t" } }),
		).toEqual({ ok: true })

		const keyless = defineProvider({
			id: "ollama",
			name: "Ollama",
			source: "custom",
			defaultModel: "ollama/llama3",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "http://127.0.0.1:11434/v1",
			auth: { kind: "none" },
		})
		expect(checkProviderCredentials(keyless, { env: {} })).toEqual({ ok: true })
	})
})

describe("@checkfu/pi-providers runtime & wire-format hardening", () => {
	it("synthesizes Day-1 unlisted models and refuses undersized static catalog models", () => {
		const models = createProviderModels({
			env: { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" },
		})
		expect(models.getModel("openai", "gpt-4")).toBeUndefined()
		const cataloged = models.getModel("openai", "gpt-4o-mini")
		expect(cataloged?.contextWindow).toBeGreaterThanOrEqual(DEFAULT_MIN_CONTEXT_WINDOW)
		const unlisted = models.getModel("openai", "gpt-future-2027")
		expect(unlisted).toMatchObject({
			id: "gpt-future-2027",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			contextWindow: 128_000,
			maxTokens: 16_384,
		})
	})

	it("classifies confirmed refusals per wire format across any provider", () => {
		expect(isWireFormatRefusalStopReason("anthropic-messages", "refusal")).toBe(true)
		expect(isWireFormatRefusalStopReason("anthropic-messages", "sensitive")).toBe(true)
		expect(isWireFormatRefusalStopReason("anthropic-messages", "content_filter")).toBe(false)
		expect(isWireFormatRefusalStopReason("openai-responses", "refusal")).toBe(true)
		expect(isWireFormatRefusalStopReason("openai-responses", "incomplete.content_filter")).toBe(
			true,
		)
		expect(isWireFormatRefusalStopReason("openai-responses", "content_filter")).toBe(false)
		expect(isWireFormatRefusalStopReason("openai-completions", "refusal")).toBe(true)
		expect(isWireFormatRefusalStopReason("openai-completions", "content_filter")).toBe(true)
		expect(isWireFormatRefusalStopReason("openai-completions", "CONTENT_FILTER")).toBe(false)

		const filterMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial unsafe output" }],
			api: "openai-completions",
			provider: "custom-compat",
			model: "model-1",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			rawStopReason: "content_filter",
			errorMessage: OPENAI_COMPLETIONS_CONTENT_FILTER_ERROR,
			timestamp: 0,
		}
		expect(isRefusalAssistantMessage(filterMsg)).toBe(true)
		const normalized = normalizeRefusalAssistantMessage(filterMsg)
		expect(normalized.stopReason).toBe("stop")
		expect(normalized.content).toEqual([{ type: "text", text: DEFAULT_REFUSAL_TEXT }])
		expect(normalized.errorMessage).toBeUndefined()
	})

	it("guards openai-completions streams against content_filter and delta.refusal", async () => {
		const customProvider = defineProvider({
			id: "compat",
			name: "Compat",
			source: "custom",
			defaultModel: "compat/test-model",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://compat.example/v1",
			auth: { kind: "bearer", env: "COMPAT_KEY", label: "Compat key" },
		})
		const models = createProviderModels({
			env: { COMPAT_KEY: "sk-compat" },
			customProviders: [customProvider],
		})
		const model = models.getModel("compat", "test-model")
		expect(model).toBeDefined()

		const contentFilterSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_1",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [
					{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null },
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_1",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const filterResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async () =>
					new Response(contentFilterSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(filterResult.stopReason).toBe("error")
		expect(filterResult.rawStopReason).toBe("content_filter")
		expect(isRefusalAssistantMessage(filterResult)).toBe(true)

		const deltaRefusalSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_2",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", refusal: "I cannot assist with that." },
						finish_reason: null,
					},
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_2",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const refusalResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async () =>
					new Response(deltaRefusalSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(refusalResult.stopReason).toBe("error")
		expect(refusalResult.rawStopReason).toBe("refusal")
		expect(refusalResult.content).toEqual([{ type: "text", text: "I cannot assist with that." }])
		const normalized = normalizeRefusalAssistantMessage(refusalResult)
		expect(normalized.content).toEqual([{ type: "text", text: "I cannot assist with that." }])

		const emptyRefusalDeltaSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_3",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "Normal answer", refusal: "" },
						finish_reason: null,
					},
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_3",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, delta: { refusal: "" }, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const normalResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async () =>
					new Response(emptyRefusalDeltaSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(normalResult.stopReason).toBe("stop")
		expect(normalResult.content).toEqual([{ type: "text", text: "Normal answer" }])
		expect(isRefusalAssistantMessage(normalResult)).toBe(false)

		const lengthRefusalSse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_4",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", refusal: "I cannot comply with " },
						finish_reason: null,
					},
				],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_4",
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, delta: { refusal: "that request." }, finish_reason: "length" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const lengthRefusalResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async () =>
					new Response(lengthRefusalSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(lengthRefusalResult.stopReason).toBe("error")
		expect(lengthRefusalResult.rawStopReason).toBe("refusal")
		expect(lengthRefusalResult.content).toEqual([
			{ type: "text", text: "I cannot comply with that request." },
		])
		expect(isRefusalAssistantMessage(lengthRefusalResult)).toBe(true)
		expect(normalizeRefusalAssistantMessage(lengthRefusalResult).content).toEqual([
			{ type: "text", text: "I cannot comply with that request." },
		])

		let pullCount = 0
		const brokenRefusalStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount += 1
				if (pullCount === 1) {
					controller.enqueue(
						new TextEncoder().encode(
							`data: ${JSON.stringify({
								id: "chatcmpl_5",
								object: "chat.completion.chunk",
								created: 1,
								model: "test-model",
								choices: [
									{
										index: 0,
										delta: { role: "assistant", refusal: "Partial refusal" },
										finish_reason: null,
									},
								],
							})}\n\n`,
						),
					)
					return
				}
				controller.error(new Error("socket reset"))
			},
		})
		let observedRefusalDelta = false
		const transportErrorResult = await models.complete(
			model!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				onProviderStreamEvent: (data) => {
					if (
						typeof data === "object" &&
						data !== null &&
						"choices" in data &&
						Array.isArray(data.choices)
					) {
						const first: unknown = data.choices[0]
						if (
							typeof first === "object" &&
							first !== null &&
							"delta" in first &&
							typeof first.delta === "object" &&
							first.delta !== null &&
							"refusal" in first.delta &&
							first.delta.refusal === "Partial refusal"
						) {
							observedRefusalDelta = true
						}
					}
				},
				fetch: async () =>
					new Response(brokenRefusalStream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			},
		)
		expect(observedRefusalDelta).toBe(true)
		expect(transportErrorResult.stopReason).toBe("error")
		expect(isRefusalAssistantMessage(transportErrorResult)).toBe(false)
	})

	it("blocks HTTP redirects and cross-origin requests", async () => {
		const guarded = createNoRedirectProviderFetch(
			"https://api.example.com/v1",
			async () =>
				new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
		)
		await expect(guarded("https://api.example.com/v1/responses")).rejects.toThrow(/redirect/i)
		await expect(guarded("https://other.example.com/v1/responses")).rejects.toThrow(
			/disallowed origin/i,
		)
	})

	it("applies dynamic lookup, context floor, listing, and provider removal consistently", async () => {
		const smallCustom = defineProvider({
			id: "small-custom",
			name: "Small Custom",
			source: "custom",
			defaultModel: "small-custom/tiny",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://small.example/v1",
			auth: { kind: "none" },
			modelDefaults: { contextWindow: 32_000 },
			models: {
				large: { contextWindow: 256_000 },
			},
		})

		expect(
			resolveModelSpecifier("openai/gpt-future-2027", { minContextWindow: 200_000 }),
		).toBeNull()
		expect(
			resolveModelSpecifier("small-custom/tiny", { customProviders: [smallCustom] }),
		).toBeNull()
		expect(
			resolveModelSpecifier("small-custom/large", {
				customProviders: [smallCustom],
				minContextWindow: 200_000,
			}),
		).toEqual({ provider: "small-custom", modelId: "large", cataloged: true })

		const lockedCustom = defineProvider({
			id: "locked-custom",
			name: "Locked Custom",
			source: "custom",
			defaultModel: "locked-custom/foo",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://locked.example/v1",
			auth: { kind: "none" },
			allowUnlistedModels: false,
			models: {
				foo: { contextWindow: 128_000, maxTokens: 8192 },
				tiny: { contextWindow: 32_000 },
			},
		})
		expect(resolveModelSpecifier("locked-custom/foo", { customProviders: [lockedCustom] })).toEqual(
			{ provider: "locked-custom", modelId: "foo", cataloged: true },
		)
		expect(
			resolveModelSpecifier("locked-custom/bar", { customProviders: [lockedCustom] }),
		).toBeNull()
		expect(
			resolveModelSpecifier("locked-custom/tiny", { customProviders: [lockedCustom] }),
		).toBeNull()
		expect(
			resolveModelSpecifier("locked-custom/constructor", { customProviders: [lockedCustom] }),
		).toBeNull()

		const lockedModels = createProviderModels({
			env: {},
			customProviders: [lockedCustom],
		})
		expect(lockedModels.getModel("locked-custom", "foo")).toMatchObject({
			id: "foo",
			contextWindow: 128_000,
			maxTokens: 8192,
		})
		expect(lockedModels.getModelOfType("chat", "locked-custom", "foo")?.id).toBe("foo")
		expect(lockedModels.getModel("locked-custom", "bar")).toBeUndefined()
		expect(lockedModels.getModel("locked-custom", "tiny")).toBeUndefined()
		expect(lockedModels.getModel("locked-custom", "constructor")).toBeUndefined()
		expect(lockedModels.getModels("locked-custom").map((model) => model.id)).toEqual(["foo"])
		expect((await lockedModels.getAvailable("locked-custom")).map((model) => model.id)).toEqual([
			"foo",
		])
		expect(lockedModels.getModels("openai").some((model) => model.id === "gpt-4")).toBe(false)
		expect(lockedModels.getModels("openai").some((model) => model.id === "gpt-4o-mini")).toBe(true)

		expect(resolveModelSpecifier("openai/ft:gpt-4:org:pilot:id")).toBeNull()
		expect(resolveModelSpecifier("openai/ft:gpt-4-0613:org:pilot:id")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-2024-04-09")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-0613")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-0314")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-32k")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-4-32k-0613")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-3.5-turbo")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-3.5-turbo-0125")).toBeNull()
		expect(resolveModelSpecifier("openai/gpt-3.5-turbo-0613")).toBeNull()
		for (const nonChat of [
			"openai/text-embedding-3-small",
			"openai/text-embedding-3-large",
			"openai/text-embedding-ada-002",
			"openai/whisper-1",
			"openai/gpt-4o-transcribe",
			"openai/tts-1",
			"openai/gpt-4o-mini-tts",
			"openai/gpt-4o-realtime-preview",
			"openai/dall-e-3",
			"openai/sora-2",
			"openai/omni-moderation-latest",
			"openai/babbage-002",
		]) {
			expect(resolveModelSpecifier(nonChat), nonChat).toBeNull()
			expect(
				lockedModels.getModel("openai", nonChat.slice("openai/".length)),
				nonChat,
			).toBeUndefined()
		}
		expect(resolveModelSpecifier("openai/ft:gpt-4o-mini:org:pilot:id")).toEqual({
			provider: "openai",
			modelId: "ft:gpt-4o-mini:org:pilot:id",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/gpt-4-turbo-2024-04-09")).toEqual({
			provider: "openai",
			modelId: "gpt-4-turbo-2024-04-09",
			cataloged: false,
		})
		expect(resolveModelSpecifier("openai/gpt-4-0125-preview")).toEqual({
			provider: "openai",
			modelId: "gpt-4-0125-preview",
			cataloged: false,
		})
		expect(resolveModelSpecifier("anthropic/claude-sonnet-4-6-20260301")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6-20260301",
			cataloged: false,
		})
		const openAIFineTune = lockedModels.getModel("openai", "ft:gpt-4o-mini:org:pilot:id")
		expect(openAIFineTune).toMatchObject({
			id: "ft:gpt-4o-mini:org:pilot:id",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 16_384,
		})
		expect(lockedModels.getModel("openai", "gpt-4-2024-04-09")).toBeUndefined()
		expect(lockedModels.getModel("openai", "gpt-4-0613")).toBeUndefined()
		expect(lockedModels.getModel("openai", "gpt-4-32k-0613")).toBeUndefined()
		expect(lockedModels.getModel("openai", "gpt-3.5-turbo-0125")).toBeUndefined()
		const gpt4TurboSnapshot = lockedModels.getModel("openai", "gpt-4-turbo-2024-04-09")
		expect(gpt4TurboSnapshot).toMatchObject({
			id: "gpt-4-turbo-2024-04-09",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 4096,
		})
		expect(lockedModels.getModel("openai", "gpt-4-0125-preview")).toMatchObject({
			id: "gpt-4-0125-preview",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 4096,
		})
		const sonnetBase = lockedModels.getModel("anthropic", "claude-sonnet-4-6")!
		const sonnetSnapshot = lockedModels.getModel("anthropic", "claude-sonnet-4-6-20260301")
		expect(sonnetSnapshot).toMatchObject({
			id: "claude-sonnet-4-6-20260301",
			contextWindow: sonnetBase.contextWindow,
			maxTokens: sonnetBase.maxTokens,
			reasoning: sonnetBase.reasoning,
		})

		let snapshotRequestBody: object | undefined
		const openAIModels = createProviderModels({ env: { OPENAI_API_KEY: "sk-test" } })
		const snapshotWireModel = openAIModels.getModel("openai", "gpt-4-turbo-2024-04-09")!
		await openAIModels.completeSimple(
			snapshotWireModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (_input, init) => {
					const parsed: unknown = JSON.parse(String(init?.body ?? "{}"))
					if (typeof parsed === "object" && parsed !== null) {
						snapshotRequestBody = parsed
					}
					return new Response(
						[
							`data: ${JSON.stringify({
								type: "response.completed",
								response: {
									id: "resp_snap",
									status: "completed",
									output: [
										{
											type: "message",
											role: "assistant",
											content: [{ type: "output_text", text: "ok" }],
										},
									],
									usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
								},
							})}\n\n`,
						].join(""),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					)
				},
			},
		)
		expect(snapshotRequestBody).toMatchObject({ model: "gpt-4-turbo-2024-04-09" })
		expect(snapshotRequestBody).not.toHaveProperty("reasoning")
		expect(
			snapshotRequestBody !== undefined &&
				"max_output_tokens" in snapshotRequestBody &&
				typeof snapshotRequestBody.max_output_tokens === "number" &&
				snapshotRequestBody.max_output_tokens <= 4096,
		).toBe(true)

		const protoNamed = defineProvider({
			id: "constructor",
			name: "Constructor Provider",
			source: "custom",
			defaultModel: "constructor/model-1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://ctor.example/v1",
			auth: { kind: "none" },
		})
		const protoModels = createProviderModels({
			env: { OPENAI_API_KEY: "sk-test" },
			baseUrlOverrides: { openai: null },
			customProviders: [protoNamed],
		})
		expect(protoModels.getModel("constructor", "model-1")).toMatchObject({
			id: "model-1",
			provider: "constructor",
			baseUrl: "https://ctor.example/v1",
		})
		expect(protoModels.getModel("openai", "gpt-4o-mini")?.id).toBe("gpt-4o-mini")

		const strictModels = createProviderModels({
			env: { OPENAI_API_KEY: "sk-test" },
			customProviders: [smallCustom],
			minContextWindow: 200_000,
		})
		expect(strictModels.getModel("openai", "gpt-future-2027")).toBeUndefined()
		expect(strictModels.getModelOfType("chat", "openai", "gpt-future-2027")).toBeUndefined()
		expect(strictModels.getModel("small-custom", "tiny")).toBeUndefined()
		expect(strictModels.getModel("small-custom", "large")?.contextWindow).toBe(256_000)
		expect(strictModels.getModelOfType("chat", "small-custom", "large")?.contextWindow).toBe(
			256_000,
		)

		const models = createProviderModels({
			env: { OPENAI_API_KEY: "sk-test" },
		})
		expect(models.getModel("openai", "gpt-4")).toBeUndefined()
		expect(models.getModelOfType("chat", "openai", "gpt-4")).toBeUndefined()
		expect(models.getModel("openai", "gpt-future-2027")?.id).toBe("gpt-future-2027")
		expect(models.getModelOfType("chat", "openai", "gpt-future-2027")?.id).toBe("gpt-future-2027")

		const replaceable = defineProvider({
			id: "acme",
			name: "Acme Old",
			source: "custom",
			defaultModel: "acme/old-model",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://old.acme.example/v1",
			auth: { kind: "bearer", env: "ACME_KEY", label: "Acme key" },
		})
		const replaceableModels = createProviderModels({
			env: { ACME_KEY: "old-secret" },
			customProviders: [replaceable],
		})
		expect(replaceableModels.getModel("acme", "unlisted-before")?.baseUrl).toBe(
			"https://old.acme.example/v1",
		)
		replaceableModels.setProvider(
			createProvider({
				id: "acme",
				name: "Acme New",
				baseUrl: "https://new.acme.example/v1",
				auth: {
					apiKey: {
						name: "Acme New Key",
						login: () => Promise.reject(new Error("unsupported")),
						resolve: () => Promise.resolve({ auth: { apiKey: "new-secret" }, source: "test" }),
					},
				},
				api: { "openai-completions": createOpenAICompletionsWire() },
				models: [
					{
						id: "new-model",
						name: "New Model",
						api: "openai-completions",
						provider: "acme",
						baseUrl: "https://new.acme.example/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8192,
					},
					{
						id: "too-small",
						name: "Too Small",
						api: "openai-completions",
						provider: "acme",
						baseUrl: "https://new.acme.example/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 2048,
					},
				],
			}),
		)
		expect(replaceableModels.getModel("acme", "new-model")?.baseUrl).toBe(
			"https://new.acme.example/v1",
		)
		expect(replaceableModels.getModel("acme", "too-small")).toBeUndefined()
		expect(replaceableModels.getModels("acme").map((model) => model.id)).toEqual(["new-model"])
		expect(replaceableModels.getModelsOfType("chat", "acme").map((model) => model.id)).toEqual([
			"new-model",
		])
		expect(replaceableModels.getAllModels("acme").map((model) => model.id)).toEqual(["new-model"])
		expect((await replaceableModels.getAvailable("acme")).map((model) => model.id)).toEqual([
			"new-model",
		])
		expect(
			(await replaceableModels.getAvailableOfType("chat", "acme")).map((model) => model.id),
		).toEqual(["new-model"])
		expect((await replaceableModels.getAllAvailable("acme")).map((model) => model.id)).toEqual([
			"new-model",
		])
		expect(replaceableModels.getModel("acme", "unlisted-after")).toBeUndefined()
		expect(replaceableModels.getModelOfType("chat", "acme", "unlisted-after")).toBeUndefined()

		const dupA = defineProvider({
			id: "dup",
			name: "Dup A",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://a.dup.example/v1",
			auth: { kind: "bearer", env: "DUP_A_KEY", label: "Dup A" },
		})
		const dupB = defineProvider({
			id: "dup",
			name: "Dup B",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://b.dup.example/v1",
			auth: { kind: "bearer", env: "DUP_B_KEY", label: "Dup B" },
		})
		const builtinCollision = defineProvider({
			id: "openai",
			name: "Fake OpenAI",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://fake.example/v1",
			auth: { kind: "none" },
		})
		expect(() =>
			createProviderModels({
				env: { DUP_A_KEY: "a", DUP_B_KEY: "b" },
				customProviders: [dupA, dupB],
			}),
		).toThrow(/Duplicate custom provider id "dup"/)
		expect(() =>
			createProviderModels({
				env: {},
				customProviders: [builtinCollision],
			}),
		).toThrow(/collides with a built-in provider/)
		expect(() => resolveModelSpecifier("dup/m1", { customProviders: [dupA, dupB] })).toThrow(
			/Duplicate custom provider id "dup"/,
		)

		models.deleteProvider("openai")
		expect(models.getModel("openai", "gpt-future-2027")).toBeUndefined()
		expect(models.getModelOfType("chat", "openai", "gpt-future-2027")).toBeUndefined()
		expect(models.getModel("anthropic", "claude-future-6")?.id).toBe("claude-future-6")
		models.clearProviders()
		expect(models.getModel("anthropic", "claude-future-6")).toBeUndefined()
		expect(models.getModelOfType("chat", "anthropic", "claude-future-6")).toBeUndefined()
	})

	it("preserves explicit Authorization and secondary secret headers without clobbering defaults", async () => {
		const authHeaderProvider = defineProvider({
			id: "auth-hdr",
			name: "Auth Header",
			source: "custom",
			defaultModel: "auth-hdr/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://auth-hdr.example/v1",
			auth: { kind: "api_key_header", header: "Authorization", env: "RAW_AUTH_KEY", label: "Key" },
			secretHeaders: { "x-api-key": "SECONDARY_KEY" },
		})
		const dualSecretProvider = defineProvider({
			id: "dual-hdr",
			name: "Dual Header",
			source: "custom",
			defaultModel: "dual-hdr/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://dual-hdr.example/v1",
			auth: { kind: "api_key_header", header: "x-corp-key", env: "CORP_KEY", label: "Corp Key" },
			secretHeaders: { authorization: "PROXY_BEARER" },
		})
		const noneWithAuthSecret = defineProvider({
			id: "none-proxy",
			name: "None Proxy",
			source: "custom",
			defaultModel: "none-proxy/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://none-proxy.example/v1",
			auth: { kind: "none" },
			secretHeaders: { authorization: "PROXY_BEARER" },
		})

		const models = createProviderModels({
			env: {
				RAW_AUTH_KEY: "ApiKey raw-secret",
				SECONDARY_KEY: "sec-x-api-key",
				CORP_KEY: "corp-secret",
				PROXY_BEARER: "Bearer proxy-tok",
			},
			customProviders: [authHeaderProvider, dualSecretProvider, noneWithAuthSecret],
		})

		const sse = [
			`data: ${JSON.stringify({
				id: "chatcmpl_auth",
				object: "chat.completion.chunk",
				created: 1,
				model: "m1",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_auth",
				object: "chat.completion.chunk",
				created: 1,
				model: "m1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("")

		const captureHeaders = async (providerId: string): Promise<Headers> => {
			let captured: Headers | undefined
			const model = models.getModel(providerId, "m1")!
			const result = await models.complete(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						captured = new Headers(init?.headers)
						return new Response(sse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(result.stopReason).toBe("stop")
			return captured!
		}

		const authHeaders = await captureHeaders("auth-hdr")
		expect(authHeaders.get("authorization")).toBe("ApiKey raw-secret")
		expect(authHeaders.get("x-api-key")).toBe("sec-x-api-key")

		const dualHeaders = await captureHeaders("dual-hdr")
		expect(dualHeaders.get("x-corp-key")).toBe("corp-secret")
		expect(dualHeaders.get("authorization")).toBe("Bearer proxy-tok")

		const noneHeaders = await captureHeaders("none-proxy")
		expect(noneHeaders.get("authorization")).toBe("Bearer proxy-tok")
		expect(noneHeaders.get("x-api-key")).toBeNull()

		const copilotAnthropic = defineProvider({
			id: "github-copilot",
			name: "Custom Copilot Proxy",
			source: "custom",
			defaultModel: "github-copilot/claude-custom",
			defaultFormat: "anthropic-messages",
			formats: ["anthropic-messages"],
			baseUrl: "https://copilot-proxy.example",
			auth: { kind: "api_key_header", header: "x-api-key", env: "COPILOT_PROXY_KEY", label: "Key" },
		})
		const oatTokenAnthropic = defineProvider({
			id: "oat-proxy",
			name: "OAT Proxy",
			source: "custom",
			defaultModel: "oat-proxy/claude-custom",
			defaultFormat: "anthropic-messages",
			formats: ["anthropic-messages"],
			baseUrl: "https://oat-proxy.example",
			auth: { kind: "api_key_header", header: "x-api-key", env: "OAT_PROXY_KEY", label: "Key" },
		})
		const anthModels = createProviderModels({
			env: {
				COPILOT_PROXY_KEY: "copilot-x-api-secret",
				OAT_PROXY_KEY: "sk-ant-oat01-proxy-secret",
			},
			customProviders: [copilotAnthropic, oatTokenAnthropic],
		})
		const anthSse = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-custom",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			})}\n\n`,
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			})}\n\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "ok" },
			})}\n\n`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			})}\n\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
		].join("")

		for (const [providerId, expectedKey] of [
			["github-copilot", "copilot-x-api-secret"],
			["oat-proxy", "sk-ant-oat01-proxy-secret"],
		] as const) {
			let captured: Headers | undefined
			const model = anthModels.getModel(providerId, "claude-custom")!
			const result = await anthModels.complete(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						captured = new Headers(init?.headers)
						return new Response(anthSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(result.stopReason).toBe("stop")
			expect(captured?.get("x-api-key")).toBe(expectedKey)
			expect(captured?.get("authorization")).toBeNull()
		}

		const bearerCustom = defineProvider({
			id: "bearer-override",
			name: "Bearer Override",
			source: "custom",
			defaultModel: "bearer-override/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://bearer-override.example/v1",
			auth: { kind: "bearer", env: "BEARER_OVERRIDE_KEY", label: "Key" },
			secretHeaders: { "x-gw-secret": "BEARER_GW_SECRET" },
		})
		const withEnvModels = createProviderModels({
			env: { BEARER_OVERRIDE_KEY: "env-key", BEARER_GW_SECRET: "gw-sec" },
			customProviders: [bearerCustom, copilotAnthropic],
		})
		const withoutEnvModels = createProviderModels({
			env: { BEARER_GW_SECRET: "gw-sec" },
			customProviders: [bearerCustom, copilotAnthropic],
		})
		for (const registry of [withEnvModels, withoutEnvModels]) {
			let capturedBearer: Headers | undefined
			const bModel = registry.getModel("bearer-override", "m1")!
			const bRes = await registry.completeSimple(
				bModel,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					apiKey: "request-replacement-bearer",
					fetch: async (_input, init) => {
						capturedBearer = new Headers(init?.headers)
						return new Response(sse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(bRes.stopReason).toBe("stop")
			expect(capturedBearer?.get("authorization")).toBe("Bearer request-replacement-bearer")
			expect(capturedBearer?.get("x-gw-secret")).toBe("gw-sec")

			let capturedAnth: Headers | undefined
			const aModel = registry.getModel("github-copilot", "claude-custom")!
			const aRes = await registry.completeSimple(
				aModel,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					apiKey: "sk-ant-oat01-request-override",
					fetch: async (_input, init) => {
						capturedAnth = new Headers(init?.headers)
						return new Response(anthSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(aRes.stopReason).toBe("stop")
			expect(capturedAnth?.get("x-api-key")).toBe("sk-ant-oat01-request-override")
			expect(capturedAnth?.get("authorization")).toBeNull()
		}

		const sessionA = createProviderModels({ env: { OPENAI_API_KEY: "sk-a" } })
		const sessionB = createProviderModels({ env: { OPENAI_API_KEY: "sk-b" } })
		expect(sessionA.getModels("openai")[0]).toBe(sessionB.getModels("openai")[0])

		const oldEndpointSpec = defineProvider({
			id: "acme-pin",
			name: "Acme Old",
			source: "custom",
			defaultModel: "acme-pin/chat",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://old.acme-pin.example/v1",
			auth: { kind: "bearer", env: "ACME_PIN_KEY", label: "Key" },
		})
		const newOriginSpec = defineProvider({
			...oldEndpointSpec,
			name: "Acme New",
			baseUrl: "https://new.acme-pin.example/v1",
		})
		const newPathSpec = defineProvider({
			...oldEndpointSpec,
			name: "Acme New Path",
			baseUrl: "https://old.acme-pin.example/tenant-b/v1",
		})
		const oldRegistry = createProviderModels({
			env: { ACME_PIN_KEY: "old-secret" },
			customProviders: [oldEndpointSpec],
		})
		const staleModel = oldRegistry.getModel("acme-pin", "chat")!

		const newOriginRegistry = createProviderModels({
			env: { ACME_PIN_KEY: "new-secret" },
			customProviders: [newOriginSpec],
		})
		let leakedFetchCalls = 0
		const originRejected = await newOriginRegistry.complete(
			staleModel,
			{ messages: [{ role: "user", content: "secret prompt", timestamp: 0 }] },
			{
				fetch: async () => {
					leakedFetchCalls += 1
					return new Response(sse, { status: 200 })
				},
			},
		)
		expect(originRejected.stopReason).toBe("error")
		expect(originRejected.errorMessage).toMatch(/disallowed origin/i)
		expect(leakedFetchCalls).toBe(0)

		oldRegistry.setProvider(
			buildPiProvider(newPathSpec, { env: { ACME_PIN_KEY: "new-path-secret" } }),
		)
		const pathRejected = await oldRegistry.complete(
			staleModel,
			{ messages: [{ role: "user", content: "secret prompt", timestamp: 0 }] },
			{
				fetch: async () => {
					leakedFetchCalls += 1
					return new Response(sse, { status: 200 })
				},
			},
		)
		expect(pathRejected.stopReason).toBe("error")
		expect(pathRejected.errorMessage).toMatch(/mismatched endpoint/i)
		expect(leakedFetchCalls).toBe(0)

		const openAiModel = sessionA.getModel("openai", "gpt-4o-mini")!
		sessionA.setProvider(
			createProvider({
				id: "openai-pinned",
				name: "OpenAI Pinned",
				baseUrl: "https://api.openai.com/v1",
				api: {
					"openai-responses": createOpenAIResponsesWire({
						allowedOrigins: ["https://api.openai.com"],
					}),
				},
				auth: {
					apiKey: {
						name: "OpenAI Pinned",
						login: () => Promise.reject(new Error("unsupported")),
						resolve: () => Promise.resolve({ auth: { apiKey: "sk-pinned" }, source: "test" }),
					},
				},
				models: [{ ...openAiModel, provider: "openai-pinned" }],
			}),
		)
		const forgedBuiltIn = await sessionA.complete(
			{ ...openAiModel, provider: "openai-pinned", baseUrl: "https://evil.example/v1" },
			{ messages: [{ role: "user", content: "secret prompt", timestamp: 0 }] },
			{
				fetch: async () => {
					leakedFetchCalls += 1
					return new Response("", { status: 200 })
				},
			},
		)
		expect(forgedBuiltIn.stopReason).toBe("error")
		expect(forgedBuiltIn.errorMessage).toMatch(/disallowed origin/i)
		expect(leakedFetchCalls).toBe(0)

		const tenantASpec = defineProvider({
			id: "acme-rot",
			name: "Acme Rot A",
			source: "custom",
			defaultModel: "acme-rot/chat",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://shared.acme-rot.example/v1",
			auth: { kind: "bearer", env: "ACME_ROT_KEY", label: "Key" },
			headers: { "x-tenant": "tenant-a", "x-legacy-flag": "enabled" },
			secretHeaders: { "x-gw-secret": "ACME_ROT_GW" },
		})
		const tenantBSpec = defineProvider({
			...tenantASpec,
			name: "Acme Rot B",
			headers: { "x-tenant": "tenant-b" },
		})
		const rotRegistry = createProviderModels({
			env: { ACME_ROT_KEY: "old-key", ACME_ROT_GW: "old-gw-secret" },
			customProviders: [tenantASpec],
		})
		const retainedSameUrlModel = rotRegistry.getModel("acme-rot", "chat")!
		expect(retainedSameUrlModel.headers).toBeUndefined()

		rotRegistry.setProvider(
			buildPiProvider(tenantBSpec, {
				env: { ACME_ROT_KEY: "new-key", ACME_ROT_GW: "new-gw-secret" },
			}),
		)
		const rotatedAuth = await rotRegistry.getAuth(retainedSameUrlModel)
		expect(rotatedAuth?.auth.headers).toMatchObject({
			Authorization: "Bearer new-key",
			"x-gw-secret": "new-gw-secret",
			"x-tenant": "tenant-b",
		})
		expect(rotatedAuth?.auth.headers).not.toHaveProperty("x-legacy-flag")

		const overrideAuth = await rotRegistry.getAuth(retainedSameUrlModel, {
			apiKey: "req-key",
			env: { ACME_ROT_GW: "req-gw-secret" },
		})
		expect(overrideAuth?.auth.headers).toMatchObject({
			Authorization: "Bearer req-key",
			"x-gw-secret": "req-gw-secret",
			"x-tenant": "tenant-b",
		})
		const envOnlyOverrideAuth = await rotRegistry.getAuth(retainedSameUrlModel, {
			env: { ACME_ROT_KEY: "req-env-key" },
		})
		expect(envOnlyOverrideAuth?.auth.headers).toMatchObject({
			Authorization: "Bearer req-env-key",
			"x-gw-secret": "new-gw-secret",
		})

		rotRegistry.setProvider(buildPiProvider(tenantBSpec, { env: {} }))
		expect(await rotRegistry.getAuth(retainedSameUrlModel)).toBeUndefined()
		expect(await rotRegistry.checkAuth("acme-rot")).toBeUndefined()

		const customReasoningSpec = defineProvider({
			id: "xai-custom",
			name: "xAI Custom",
			source: "custom",
			defaultModel: "xai-custom/grok-4.6",
			defaultFormat: "openai-responses",
			formats: ["openai-responses"],
			baseUrl: "https://api.xai-custom.example/v1",
			auth: { kind: "bearer", env: "XAI_CUSTOM_KEY", label: "Key" },
			modelDefaults: { reasoning: true },
		})
		const reasoningRegistry = createProviderModels({
			env: { XAI_CUSTOM_KEY: "xai-secret" },
			customProviders: [customReasoningSpec],
		})
		const reasoningModel = reasoningRegistry.getModel("xai-custom", "grok-4.6")!
		expect(reasoningModel.reasoning).toBe(true)
		expect(reasoningModel.thinkingLevelMap).toEqual({ off: null })

		const capturedBodies: Array<{ readonly reasoning?: { readonly effort?: string } }> = []
		const responsesSse = [
			`event: response.completed\ndata: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					output: [
						{
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "ok" }],
						},
					],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			})}\n\n`,
		].join("")
		const capturingFetch: typeof fetch = async (_input, init) => {
			if (typeof init?.body === "string") {
				capturedBodies.push(
					JSON.parse(init.body) as { readonly reasoning?: { readonly effort?: string } },
				)
			}
			return new Response(responsesSse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}
		await reasoningRegistry.completeSimple(
			reasoningModel,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ fetch: capturingFetch },
		)
		expect(capturedBodies[0]).not.toHaveProperty("reasoning")

		await reasoningRegistry.completeSimple(
			reasoningModel,
			{ messages: [{ role: "user", content: "think hard", timestamp: 0 }] },
			{ reasoning: "high", fetch: capturingFetch },
		)
		expect(capturedBodies[1]?.reasoning).toMatchObject({ effort: "high" })

		expect(sessionA.getModel("openai", "computer-use-preview")).toBeUndefined()
		expect(sessionA.getModel("openai", "computer-use-preview-2025-03-11")).toBeUndefined()
		const lowFloorOpenAI = createProviderModels({
			env: { OPENAI_API_KEY: "sk-a" },
			minContextWindow: 4096,
		})
		expect(lowFloorOpenAI.getModel("openai", "computer-use-preview-2025-03-11")).toMatchObject({
			id: "computer-use-preview-2025-03-11",
			contextWindow: 8192,
			maxTokens: 1024,
		})
		expect(lowFloorOpenAI.getModel("openai", "gpt-3.5-turbo-instruct")).toBeUndefined()
		expect(lowFloorOpenAI.getModel("openai", "gpt-3.5-turbo-instruct-0914")).toBeUndefined()
		expect(sessionA.getModel("openai", "ft:gpt-4o-mini:org:my-transcribe-helper:id")).toMatchObject(
			{
				id: "ft:gpt-4o-mini:org:my-transcribe-helper:id",
				contextWindow: 128_000,
			},
		)
		expect(
			sessionA.getModel("openai", "ft:gpt-4o-mini:org:my-search-preview-bot:id"),
		).toMatchObject({
			id: "ft:gpt-4o-mini:org:my-search-preview-bot:id",
			contextWindow: 128_000,
		})
		expect(sessionA.getModel("openai", "ft:gpt-4o-transcribe:org:chat-helper:id")).toBeUndefined()
		expect(
			sessionA.getModel("openai", "ft:gpt-4o-search-preview:org:chat-helper:id"),
		).toBeUndefined()
		expect(sessionA.getModel("openai", "gpt-audio-1.5")).toBeUndefined()
		expect(sessionA.getModel("openai", "a".repeat(MAX_MODEL_ID_LENGTH + 1))).toBeUndefined()

		const rotatedEndpointSpec = defineProvider({
			...tenantBSpec,
			baseUrl: "https://v2.acme-rot.example/v1",
		})
		rotRegistry.setProvider(
			buildPiProvider(rotatedEndpointSpec, {
				env: { ACME_ROT_KEY: "v2-key", ACME_ROT_GW: "v2-gw-secret" },
			}),
		)
		const unlistedAfterRotation = rotRegistry.getModel("acme-rot", "brand-new-unlisted-model")
		expect(unlistedAfterRotation).toMatchObject({
			id: "brand-new-unlisted-model",
			baseUrl: "https://v2.acme-rot.example/v1",
		})
		const lockedAfterRotationSpec = defineProvider({
			...rotatedEndpointSpec,
			allowUnlistedModels: false,
			models: { "allowed-only": { contextWindow: 128_000 } },
		})
		rotRegistry.setProvider(
			buildPiProvider(lockedAfterRotationSpec, {
				env: { ACME_ROT_KEY: "v3-key", ACME_ROT_GW: "v3-gw-secret" },
			}),
		)
		expect(rotRegistry.getModel("acme-rot", "brand-new-unlisted-model")).toBeUndefined()
		expect(rotRegistry.getModel("acme-rot", "allowed-only")?.baseUrl).toBe(
			"https://v2.acme-rot.example/v1",
		)

		const localNativeRegistry = createProviderModels({
			env: { OPENAI_API_KEY: "sk-local", ANTHROPIC_API_KEY: "sk-ant-local" },
			baseUrlOverrides: {
				openai: "http://127.0.0.1:18991/v1",
				anthropic: "http://127.0.0.1:18992",
			},
		})
		const retainedLocalOpenAI = localNativeRegistry.getModel("openai", "gpt-4o-mini")!
		const retainedLocalAnthropic = localNativeRegistry.getModel("anthropic", "claude-sonnet-4-5")!
		const prodNativeRegistry = createProviderModels({
			env: { OPENAI_API_KEY: "sk-prod", ANTHROPIC_API_KEY: "sk-ant-prod" },
		})
		let nativeLeaks = 0
		const nativeLeakFetch: typeof fetch = async () => {
			nativeLeaks += 1
			return new Response("", { status: 200 })
		}
		const rejectedNativeOpenAI = await prodNativeRegistry.complete(
			retainedLocalOpenAI,
			{ messages: [{ role: "user", content: "secret", timestamp: 0 }] },
			{ fetch: nativeLeakFetch },
		)
		expect(rejectedNativeOpenAI.stopReason).toBe("error")
		expect(rejectedNativeOpenAI.errorMessage).toMatch(/disallowed origin/i)
		const rejectedNativeAnthropic = await prodNativeRegistry.complete(
			retainedLocalAnthropic,
			{ messages: [{ role: "user", content: "secret", timestamp: 0 }] },
			{ fetch: nativeLeakFetch },
		)
		expect(rejectedNativeAnthropic.stopReason).toBe("error")
		expect(rejectedNativeAnthropic.errorMessage).toMatch(/disallowed origin/i)
		expect(nativeLeaks).toBe(0)

		const savedSdkEnv = {
			OPENAI_CUSTOM_HEADERS: process.env["OPENAI_CUSTOM_HEADERS"],
			OPENAI_ORG_ID: process.env["OPENAI_ORG_ID"],
			OPENAI_PROJECT_ID: process.env["OPENAI_PROJECT_ID"],
			ANTHROPIC_CUSTOM_HEADERS: process.env["ANTHROPIC_CUSTOM_HEADERS"],
		}
		process.env["OPENAI_CUSTOM_HEADERS"] =
			"X-Native-Proxy-Secret: openai-secret\nX-Shared-Header: from-openai-env"
		process.env["OPENAI_ORG_ID"] = "org-native-secret"
		process.env["OPENAI_PROJECT_ID"] = "proj-native-secret"
		process.env["ANTHROPIC_CUSTOM_HEADERS"] =
			"X-Anthropic-Proxy-Secret: anthropic-secret\nX-Shared-Header: from-anthropic-env"
		try {
			const thirdPartyNoneOai = defineProvider({
				id: "local-oai-none",
				name: "Local OAI None",
				source: "custom",
				defaultModel: "local-oai-none/llama",
				defaultFormat: "openai-completions",
				formats: ["openai-completions"],
				baseUrl: "https://local-oai.example/v1",
				auth: { kind: "none" },
				headers: { "x-shared-header": "from-custom-oai" },
			})
			const thirdPartyNoneAnth = defineProvider({
				id: "local-anth-none",
				name: "Local Anth None",
				source: "custom",
				defaultModel: "local-anth-none/claude-compat",
				defaultFormat: "anthropic-messages",
				formats: ["anthropic-messages"],
				baseUrl: "https://local-anth.example",
				auth: { kind: "none" },
				headers: { "x-shared-header": "from-custom-anth" },
			})
			const isolatedModels = createProviderModels({
				env: {},
				customProviders: [thirdPartyNoneOai, thirdPartyNoneAnth],
			})
			let capturedThirdPartyOai: Headers | undefined
			await isolatedModels.complete(
				isolatedModels.getModel("local-oai-none", "llama")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedThirdPartyOai = new Headers(init?.headers)
						return new Response(sse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedThirdPartyOai?.get("x-native-proxy-secret")).toBeNull()
			expect(capturedThirdPartyOai?.get("openai-organization")).toBeNull()
			expect(capturedThirdPartyOai?.get("openai-project")).toBeNull()
			expect(capturedThirdPartyOai?.get("x-shared-header")).toBe("from-custom-oai")

			let capturedThirdPartyAnth: Headers | undefined
			await isolatedModels.complete(
				isolatedModels.getModel("local-anth-none", "claude-compat")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedThirdPartyAnth = new Headers(init?.headers)
						return new Response(anthSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedThirdPartyAnth?.get("x-anthropic-proxy-secret")).toBeNull()
			expect(capturedThirdPartyAnth?.get("x-shared-header")).toBe("from-custom-anth")

			let capturedNativeOai: Headers | undefined
			await prodNativeRegistry.complete(
				prodNativeRegistry.getModel("openai", "gpt-4o-mini")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedNativeOai = new Headers(init?.headers)
						return new Response(responsesSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedNativeOai?.get("x-native-proxy-secret")).toBe("openai-secret")
			expect(capturedNativeOai?.get("openai-organization")).toBe("org-native-secret")
			expect(capturedNativeOai?.get("openai-project")).toBe("proj-native-secret")

			const openAiBuiltinSpec = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai")!
			const anthropicBuiltinSpec = BUILTIN_PROVIDERS.find(
				(provider) => provider.id === "anthropic",
			)!
			const proxiedVendors = createProviderModels({ env: {} })
			proxiedVendors.setProvider(
				buildPiProvider(
					{ ...openAiBuiltinSpec, baseUrl: "https://proxy-openai.example/v1" },
					{ env: { OPENAI_API_KEY: "sk-proxy" } },
				),
			)
			proxiedVendors.setProvider(
				buildPiProvider(
					{ ...anthropicBuiltinSpec, baseUrl: "https://proxy-anthropic.example" },
					{ env: { ANTHROPIC_API_KEY: "sk-ant-proxy" } },
				),
			)
			let capturedProxyOai: Headers | undefined
			await proxiedVendors.complete(
				proxiedVendors.getModel("openai", "gpt-4o-mini")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedProxyOai = new Headers(init?.headers)
						return new Response(responsesSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedProxyOai?.get("x-native-proxy-secret")).toBeNull()
			expect(capturedProxyOai?.get("openai-organization")).toBeNull()
			expect(capturedProxyOai?.get("openai-project")).toBeNull()

			let capturedProxyAnth: Headers | undefined
			await proxiedVendors.complete(
				proxiedVendors.getModel("anthropic", "claude-sonnet-4-5")!,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{
					fetch: async (_input, init) => {
						capturedProxyAnth = new Headers(init?.headers)
						return new Response(anthSse, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					},
				},
			)
			expect(capturedProxyAnth?.get("x-anthropic-proxy-secret")).toBeNull()
		} finally {
			for (const [key, value] of Object.entries(savedSdkEnv)) {
				if (value === undefined) {
					delete process.env[key]
				} else {
					process.env[key] = value
				}
			}
		}

		const missingBaseSpec = defineProvider({
			id: "acme-nobase",
			name: "Acme No Base",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			auth: { kind: "bearer", env: "ACME_PIN_KEY", label: "Key" },
		})
		const malformedBaseSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-badbase",
			baseUrl: "not a url",
		})
		const nonHttpBaseSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-filebase",
			baseUrl: "file:///etc/passwd",
		})
		const credInUrlSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-credbase",
			baseUrl: "https://user:pass@api.acme.example/v1",
		})
		const remoteCleartextSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-httpbase",
			baseUrl: "http://api.acme.example/v1",
		})
		const privateHttpsSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-ssrfbase",
			baseUrl: "https://169.254.169.254/latest",
		})
		for (const badSpec of [
			missingBaseSpec,
			malformedBaseSpec,
			nonHttpBaseSpec,
			credInUrlSpec,
			remoteCleartextSpec,
			privateHttpsSpec,
		]) {
			expect(() => buildPiProvider(badSpec, { env: { ACME_PIN_KEY: "new-secret" } })).toThrow(
				TypeError,
			)
			expect(() =>
				createProviderModels({ env: { ACME_PIN_KEY: "new-secret" }, customProviders: [badSpec] }),
			).toThrow(TypeError)
		}
		expect(() =>
			resolveModelSpecifier("acme-nobase/chat", { customProviders: [missingBaseSpec] }),
		).toThrow(TypeError)
		expect(() =>
			resolveModelSpecifier("acme-badbase/chat", { customProviders: [malformedBaseSpec] }),
		).toThrow(TypeError)
		expect(() =>
			resolveModelSpecifier("acme-httpbase/chat", { customProviders: [remoteCleartextSpec] }),
		).toThrow(TypeError)
		const slashIdSpec = defineProvider({
			id: "openai/team",
			name: "OpenAI Team",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://team.acme.example/v1",
			auth: { kind: "none" },
		})
		expect(() =>
			resolveModelSpecifier("openai/team/chat", { customProviders: [slashIdSpec] }),
		).toThrow(/must not contain "\/"/)
		expect(() => buildPiProvider(slashIdSpec, { env: {} })).toThrow(/must not contain "\/"/)
		expect(() => createProviderModels({ env: {}, customProviders: [slashIdSpec] })).toThrow(
			/must not contain "\/"/,
		)
		const loopbackDevSpec = defineProvider({
			...missingBaseSpec,
			id: "acme-loopback",
			baseUrl: "http://127.0.0.1:11434/v1",
			auth: { kind: "none" },
		})
		expect(
			createProviderModels({ env: {}, customProviders: [loopbackDevSpec] }).getModel(
				"acme-loopback",
				"chat",
			)?.baseUrl,
		).toBe("http://127.0.0.1:11434/v1")
		const rotationGuardRegistry = createProviderModels({
			env: { ACME_PIN_KEY: "old-secret" },
			customProviders: [oldEndpointSpec],
		})
		const retainedRotationModel = rotationGuardRegistry.getModel("acme-pin", "chat")!
		const { baseUrl: _omittedBaseUrl, ...oldEndpointWithoutBase } = oldEndpointSpec
		expect(() =>
			rotationGuardRegistry.setProvider(
				buildPiProvider(oldEndpointWithoutBase, { env: { ACME_PIN_KEY: "rotated-secret" } }),
			),
		).toThrow(TypeError)
		expect(
			(await rotationGuardRegistry.getAuth(retainedRotationModel))?.auth.headers,
		).toMatchObject({ Authorization: "Bearer old-secret" })

		const bareAliasCustom = defineProvider({
			id: "acme-bare",
			name: "Acme Bare",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://acme-bare.example/v1",
			auth: { kind: "none" },
			resolveBareModelIds: true,
			models: {
				"acme-fast": { contextWindow: 128_000 },
				"acme-tiny": { contextWindow: 8192 },
			},
		})
		expect(resolveModelSpecifier("acme-fast", { customProviders: [bareAliasCustom] })).toEqual({
			provider: "acme-bare",
			modelId: "acme-fast",
			cataloged: true,
		})
		expect(resolveModelSpecifier("acme-tiny", { customProviders: [bareAliasCustom] })).toBeNull()
		expect(
			resolveModelSpecifier("acme-unlisted", { customProviders: [bareAliasCustom] }),
		).toBeNull()
		expect(
			resolveModelSpecifier("acme-bare/acme-unlisted", { customProviders: [bareAliasCustom] }),
		).toEqual({
			provider: "acme-bare",
			modelId: "acme-unlisted",
			cataloged: false,
		})

		const blankAuthProvider = defineProvider({
			id: "blank-auth",
			name: "Blank Auth",
			source: "custom",
			defaultModel: "blank-auth/m1",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://blank-auth.example/v1",
			auth: { kind: "bearer", env: "BLANK_API_KEY", label: "Blank Key" },
			secretHeaders: { "x-gw-token": "BLANK_GW_TOKEN" },
		})
		const blankKeyEnv = { BLANK_API_KEY: "   \t  ", BLANK_GW_TOKEN: "valid-gw" }
		const blankSecretEnv = { BLANK_API_KEY: "valid-key", BLANK_GW_TOKEN: "  \n " }
		for (const blankEnv of [blankKeyEnv, blankSecretEnv]) {
			expect(checkProviderCredentials(blankAuthProvider, { env: blankEnv }).ok).toBe(false)
			const blankRegistry = createProviderModels({
				env: blankEnv,
				customProviders: [blankAuthProvider],
			})
			expect(await blankRegistry.checkAuth("blank-auth")).toBeUndefined()
			expect(
				await blankRegistry.getAuth(blankRegistry.getModel("blank-auth", "m1")!),
			).toBeUndefined()
			expect(await blankRegistry.getAvailable("blank-auth")).toEqual([])
		}

		const mismatchedFormatSpec = defineProvider({
			id: "bad-format",
			name: "Bad Format",
			source: "custom",
			defaultFormat: "openai-responses",
			formats: ["openai-completions"],
			baseUrl: "https://bad-format.example/v1",
			auth: { kind: "none" },
		})
		expect(() =>
			resolveModelSpecifier("bad-format/m1", { customProviders: [mismatchedFormatSpec] }),
		).toThrow(/defaultFormat "openai-responses" must be listed in formats/)
		expect(() => buildPiProvider(mismatchedFormatSpec, { env: {} })).toThrow(
			/defaultFormat "openai-responses" must be listed in formats/,
		)
		expect(() =>
			createProviderModels({ env: {}, customProviders: [mismatchedFormatSpec] }),
		).toThrow(/defaultFormat "openai-responses" must be listed in formats/)

		for (const unsupportedAuth of [
			{
				kind: "cloudflare_workers_ai",
				apiKeyEnv: "CLOUDFLARE_AI_API_KEY",
				accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
			},
			{
				kind: "cloudflare_ai_gateway",
				apiKeyEnv: "CLOUDFLARE_AI_API_KEY",
				accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
				gatewayIdEnv: "CLOUDFLARE_GATEWAY_ID",
			},
		]) {
			const unsupportedSpec = {
				id: `unsupported-${unsupportedAuth.kind}`,
				name: "Unsupported Auth",
				source: "custom" as const,
				defaultFormat: "openai-completions" as const,
				formats: ["openai-completions" as const],
				baseUrl: "https://unsupported.example/v1",
				auth: unsupportedAuth,
			} as unknown as (typeof BUILTIN_PROVIDERS)[number]
			expect(
				checkProviderCredentials(unsupportedSpec, {
					env: {
						CLOUDFLARE_AI_API_KEY: "tok",
						CLOUDFLARE_ACCOUNT_ID: "acct",
						CLOUDFLARE_GATEWAY_ID: "gw",
					},
					aiBinding: { fetch: async () => new Response("ok") },
				}),
			).toEqual({
				ok: false,
				missing: [],
				message: `Provider "${unsupportedSpec.id}" uses unsupported auth kind "${unsupportedAuth.kind}".`,
			})
			expect(() => buildPiProvider(unsupportedSpec, { env: {} })).toThrow(/unsupported auth kind/)
			expect(() => createProviderModels({ env: {}, customProviders: [unsupportedSpec] })).toThrow(
				/unsupported auth kind/,
			)
			expect(() =>
				resolveModelSpecifier(`${unsupportedSpec.id}/m1`, { customProviders: [unsupportedSpec] }),
			).toThrow(/unsupported auth kind/)
		}

		const openAiSpec = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai")!
		const proxyOpenAiSpec = defineProvider({
			...openAiSpec,
			baseUrl: "https://proxy-openai.example/v1",
		})
		const proxyOpenAiRegistry = createProviderModels({ env: { OPENAI_API_KEY: "sk-default" } })
		proxyOpenAiRegistry.setProvider(
			buildPiProvider(proxyOpenAiSpec, { env: { OPENAI_API_KEY: "sk-proxy" } }),
		)
		const proxyListed = proxyOpenAiRegistry.getModels("openai")
		const proxyAvailable = await proxyOpenAiRegistry.getAvailable("openai")
		expect(proxyListed.length).toBeGreaterThan(0)
		expect(proxyAvailable.length).toBe(proxyListed.length)
		expect(proxyListed.every((m) => m.baseUrl === "https://proxy-openai.example/v1")).toBe(true)
		expect(proxyAvailable.every((m) => m.baseUrl === "https://proxy-openai.example/v1")).toBe(true)
		expect(
			prodNativeRegistry
				.getModels("openai")
				.every((m) => m.baseUrl === "https://api.openai.com/v1"),
		).toBe(true)
		let proxyRequestedUrl = ""
		const proxyListedResult = await proxyOpenAiRegistry.complete(
			proxyListed[0]!,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (input) => {
					proxyRequestedUrl = String(input)
					return new Response(responsesSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				},
			},
		)
		expect(proxyListedResult.stopReason).toBe("stop")
		expect(proxyRequestedUrl).toBe("https://proxy-openai.example/v1/responses")

		const lowFloorRegistry = createProviderModels({ env: {}, minContextWindow: 4096 })
		const rotatedSmallSpec = defineProvider({
			id: "acme-floor",
			name: "Acme Floor",
			source: "custom",
			defaultFormat: "openai-completions",
			formats: ["openai-completions"],
			baseUrl: "https://acme-floor.example/v1",
			auth: { kind: "none" },
			models: {
				"model-8k": { contextWindow: 8192 },
				"model-2k": { contextWindow: 2048 },
			},
		})
		const replacementWithoutFloor = buildPiProvider(rotatedSmallSpec, { env: {} })
		lowFloorRegistry.setProvider(replacementWithoutFloor)
		expect(lowFloorRegistry.getModel("acme-floor", "model-8k")?.contextWindow).toBe(8192)
		expect(lowFloorRegistry.getModel("acme-floor", "model-2k")).toBeUndefined()
		expect(lowFloorRegistry.getModels("acme-floor").map((m) => m.id)).toEqual(["model-8k"])
		expect((await lowFloorRegistry.getAvailable("acme-floor")).map((m) => m.id)).toEqual([
			"model-8k",
		])
		lowFloorRegistry.setProvider(
			buildPiProvider(rotatedSmallSpec, { env: {}, minContextWindow: 32_768 }),
		)
		expect(lowFloorRegistry.getModel("acme-floor", "model-8k")).toBeUndefined()
		expect(lowFloorRegistry.getModels("acme-floor")).toEqual([])
		expect(await lowFloorRegistry.getAvailable("acme-floor")).toEqual([])
	})
})
