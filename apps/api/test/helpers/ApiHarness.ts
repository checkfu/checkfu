import * as Domain from "@alchemy.run/domain"
import type { ModelProviderError } from "@checkfu/sessions/Session/ModelProvider.external"
import { SessionsHandlersLive } from "@checkfu/sessions/Sessions.model"
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { createModels, createProvider } from "@earendil-works/pi-ai/models"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { expect } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import { Checkfu } from "../../src/Checkfu.model.ts"
import {
	type PiTurnRequest,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../../src/Pi/PiDurableEngine.ts"
import {
	HarnessCallFailed,
	HarnessLimits,
	PiDurableModelProviderLive,
	makePiTurnExecutorLayer,
} from "../../src/Pi/PiDurableModelProvider.ts"
import { createInMemoryPiDurableBackend } from "./InMemoryPiBackend.ts"

export const TEST_API_KEY = "ck_test_secret_token"

export const AUTH_HEADERS = {
	authorization: `Bearer ${TEST_API_KEY}`,
}

export interface RecordedModelCall {
	readonly provider: string
	readonly modelId: string
	readonly systemPrompt: string | undefined
	readonly messageCount: number
	readonly lastUserText: string
}

export const extractSystemText = (context: TranscriptContext): string =>
	context.messages
		.filter((msg) => msg.role === "system")
		.map((msg) => {
			const base = typeof msg.content === "string" ? msg.content : ""
			const sections =
				"sections" in msg && typeof msg.sections === "object" && msg.sections !== null
					? Object.values(msg.sections as Record<string, string>).join("\n")
					: ""
			return [base, sections].filter((s) => s.length > 0).join("\n")
		})
		.join("\n")

export const extractConversationMessageCount = (context: TranscriptContext): number =>
	context.messages.filter((msg) => msg.role === "user" || msg.role === "assistant").length

export const extractLastUserText = (context: TranscriptContext): string => {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i]
		if (msg?.role === "user") {
			if (typeof msg.content === "string") return msg.content
			return msg.content.map((part) => (part.type === "text" ? part.text : "")).join("")
		}
	}
	return ""
}

export const makeScriptedPiModels = (
	handler: (
		model: Model<Api>,
		context: TranscriptContext,
		signal?: AbortSignal,
	) => Promise<AssistantMessage>,
) => {
	const models = createModels({
		authContext: {
			env: () => Promise.resolve("sk-scripted-test"),
			fileExists: () => Promise.resolve(false),
		},
	})

	const streamImpl = (
		model: Model<Api>,
		context: TranscriptContext,
		options?: { readonly signal?: AbortSignal },
	) => {
		const stream = createAssistantMessageEventStream()
		void handler(model, context, options?.signal)
			.then((message) => {
				stream.push({ type: "start", partial: message })
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message })
				} else {
					stream.push({
						type: "done",
						reason: message.stopReason === "length" ? "length" : "stop",
						message,
					})
				}
			})
			.catch((err: unknown) => {
				const errorMsg: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: err instanceof Error ? err.message : String(err),
					timestamp: 0,
				}
				stream.push({ type: "error", reason: "error", error: errorMsg })
			})
		return stream
	}

	const testAuth = {
		apiKey: {
			name: "Test API key",
			login: () => Promise.reject(new Error("unused")),
			resolve: () => Promise.resolve({ auth: { apiKey: "sk-test" }, source: "test" }),
		},
	}

	models.setProvider(
		createProvider({
			id: "openai",
			name: "OpenAI",
			baseUrl: "https://api.openai.com/v1",
			auth: testAuth,
			models: Object.values(OPENAI_MODELS),
			api: { stream: streamImpl, streamSimple: streamImpl },
		}),
	)
	models.setProvider(
		createProvider({
			id: "anthropic",
			name: "Anthropic",
			baseUrl: "https://api.anthropic.com",
			auth: testAuth,
			models: Object.values(ANTHROPIC_MODELS),
			api: { stream: streamImpl, streamSimple: streamImpl },
		}),
	)
	return models
}

export const makePiDurableTestLayer = (
	handler: (
		model: Model<Api>,
		context: TranscriptContext,
		signal?: AbortSignal,
	) => Promise<AssistantMessage>,
	envOverrides: Record<string, string> = {
		CHECKFU_API_KEY: TEST_API_KEY,
		OPENAI_API_KEY: "sk-openai-test",
		ANTHROPIC_API_KEY: "sk-anthropic-test",
	},
) => {
	const backends = new Map<
		string,
		Promise<Awaited<ReturnType<typeof createInMemoryPiDurableBackend>>>
	>()
	const getBackend = (sessionId: string) => {
		let existing = backends.get(sessionId)
		if (existing === undefined) {
			existing = createInMemoryPiDurableBackend(makeScriptedPiModels(handler))
			backends.set(sessionId, existing)
		}
		return existing
	}

	const requests: Array<PiTurnRequest> = []
	const forgetPiState = async (sessionId: string) => {
		const existing = backends.get(sessionId)
		backends.delete(sessionId)
		await (await existing)?.close()
	}

	const unreachable = new Set<string>()
	const conversations: Array<string> = []
	const executorLayer = makePiTurnExecutorLayer({
		recoverTurn: (conversation, operationId) =>
			unreachable.has(conversation)
				? Effect.fail(new HarnessCallFailed({ cause: "unreachable in test" }))
				: !backends.has(conversation)
					? Effect.succeed(null)
					: Effect.promise(async (signal) =>
							recoverPiDurableTurn(await getBackend(conversation), operationId, signal),
						),
		runTurn: (conversation, request) =>
			unreachable.has(conversation)
				? Effect.fail(new HarnessCallFailed({ cause: "unreachable in test" }))
				: Effect.promise(async (signal) => {
						requests.push(request)
						conversations.push(conversation)
						return runPiDurableTurn(await getBackend(conversation), request, signal)
					}),
		abortTurn: (conversation, operationId) =>
			unreachable.has(conversation)
				? Effect.never
				: Effect.promise(async () => {
						await (await getBackend(conversation)).abort(operationId)
					}),
	})

	const CheckfuLive = Checkfu.layer(
		SessionsHandlersLive.pipe(Layer.provide(PiDurableModelProviderLive)),
	).pipe(Layer.provide(executorLayer))
	const PiProviderLive = PiDurableModelProviderLive.pipe(
		Layer.provide(executorLayer),
		Layer.provide(CheckfuLive),
	)

	const layer = Layer.mergeAll(CheckfuLive, PiProviderLive).pipe(
		Layer.provide(
			Layer.succeed(HarnessLimits, {
				attempts: 2,
				baseDelayMs: 1,
				interruptTimeoutMs: 50,
				settleMarginMs: 50,
			}),
		),
		Layer.provide(Domain.InMemory),
		Layer.provideMerge(SecureRandom.layerWebCrypto),
		Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(envOverrides))),
	)

	const closeAll = async () => {
		for (const backendPromise of backends.values()) {
			const backend = await backendPromise
			await backend.close()
		}
	}

	return { layer, closeAll, requests, forgetPiState, unreachable, conversations }
}

export const sendRequest = (
	fetchEffect: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest
	>,
	input: {
		readonly method: string
		readonly path: string
		readonly body?: unknown
		readonly headers?: Record<string, string>
	},
) =>
	Effect.gen(function* () {
		const init: RequestInit = {
			method: input.method,
			headers: {
				...(input.body === undefined ? {} : { "content-type": "application/json" }),
				...input.headers,
			},
			...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
		}
		const webRequest = new Request(`http://localhost${input.path}`, init)
		const response = yield* fetchEffect.pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(webRequest),
			),
		)
		return HttpServerResponse.toWeb(response)
	})

export const readSseUntil = async (
	response: Response,
	predicate: (event: { readonly type: string } & Record<string, unknown>) => boolean,
): Promise<
	Array<{ readonly id: string; readonly event: string; readonly data: Record<string, unknown> }>
> => {
	const reader = response.body?.getReader()
	if (!reader) throw new Error("Expected SSE response body stream")
	const decoder = new TextDecoder()
	let buffer = ""
	const collected: Array<{
		readonly id: string
		readonly event: string
		readonly data: Record<string, unknown>
	}> = []

	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			buffer += decoder.decode(chunk.value, { stream: true })
			let boundary = buffer.indexOf("\n\n")
			while (boundary !== -1) {
				const frame = buffer.slice(0, boundary)
				buffer = buffer.slice(boundary + 2)
				let id = ""
				let event = ""
				let dataRaw = ""
				for (const line of frame.split("\n")) {
					if (line.startsWith("id: ")) id = line.slice(4)
					else if (line.startsWith("event: ")) event = line.slice(7)
					else if (line.startsWith("data: ")) dataRaw += line.slice(6)
				}
				if (dataRaw.length > 0) {
					const data = JSON.parse(dataRaw) as { readonly type: string } & Record<string, unknown>
					collected.push({ id, event, data })
					if (predicate(data)) {
						await reader.cancel()
						return collected
					}
				}
				boundary = buffer.indexOf("\n\n")
			}
		}
	} finally {
		reader.releaseLock()
	}
	return collected
}

export const makeAssistantReply = (
	model: Model<Api>,
	thinking: string | null,
	text: string,
	inputTokens: number,
	outputTokens: number,
): AssistantMessage => ({
	role: "assistant",
	content: [
		...(thinking === null ? [] : [{ type: "thinking" as const, thinking }]),
		{ type: "text" as const, text },
	],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: inputTokens,
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
})

export const createIdleSession = (
	apiFetch: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest
	>,
) =>
	Effect.gen(function* () {
		const agentRes = yield* sendRequest(apiFetch, {
			method: "POST",
			path: "/v1/agents",
			headers: AUTH_HEADERS,
			body: { name: "Agent", model: "gpt-4o-mini" },
		})
		const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
		const envRes = yield* sendRequest(apiFetch, {
			method: "POST",
			path: "/v1/environments",
			headers: AUTH_HEADERS,
			body: { name: "Env" },
		})
		const env = (yield* Effect.promise(() => envRes.json())) as { id: string }
		const sessionRes = yield* sendRequest(apiFetch, {
			method: "POST",
			path: "/v1/sessions",
			headers: AUTH_HEADERS,
			body: { agent: agent.id, environment_id: env.id },
		})
		return (yield* Effect.promise(() => sessionRes.json())) as {
			id: string
			environment_id: string
		}
	})

export const providerError = (error: { readonly _tag: string }): ModelProviderError => {
	if (error._tag !== "ModelProviderError")
		throw new Error(`expected a provider error, got ${error._tag}`)
	return error as ModelProviderError
}

export const sendAndSettle = (
	apiFetch: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest
	>,
	sessionId: string,
	texts: ReadonlyArray<string>,
	turn: number,
) =>
	Effect.gen(function* () {
		const sent = yield* sendRequest(apiFetch, {
			method: "POST",
			path: `/v1/sessions/${sessionId}/events`,
			headers: AUTH_HEADERS,
			body: {
				events: texts.map((text) => ({
					type: "user.message",
					content: [{ type: "text", text }],
				})),
			},
		})
		expect(sent.status).toBe(200)
		for (let attempt = 0; attempt < 400; attempt++) {
			const res = yield* sendRequest(apiFetch, {
				method: "GET",
				path: `/v1/sessions/${sessionId}`,
				headers: AUTH_HEADERS,
			})
			const current = (yield* Effect.promise(() => res.json())) as {
				status: string
				turn: number
			}
			if (current.status === "idle" && current.turn === turn) return
			yield* Effect.sleep("5 millis")
		}
		return yield* Effect.die(new Error(`turn ${turn} did not settle`))
	})
