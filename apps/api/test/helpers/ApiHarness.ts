import * as Domain from "@alchemy.run/domain"
import type { TurnFailed } from "@checkfu/domain/Session/Harness.external"
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { createModels, createProvider } from "@earendil-works/pi-ai/models"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import type { JsonObject, Registry } from "@earendil-works/pi-durable"
import { expect } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Sse from "effect/encoding/Sse"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { ToolConfirmation } from "@checkfu/domain/Session/ToolConfirmation.aggregate"
import { makeCheckfuClientWith } from "../../src/Http/Api.ts"
import { PROVIDER_API_KEY_ENV } from "../../src/Pi/PiCatalog.ts"
import {
	AbortGrace,
	abortPiDurableTurn,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../../src/Pi/PiDurableEngine.ts"
import { PiApprovalStore, makeToolGate } from "../../src/Pi/PiApprovals.ts"
import type { ToolGateOptions } from "../../src/Pi/PiApprovals.ts"
import { PiCustomToolStore, isCheckableInputSchema } from "../../src/Pi/PiCustomTools.ts"
import type { PiTurnRequest } from "../../src/Pi/PiTurn.ts"
import {
	HarnessCallFailed,
	HarnessLimits,
	PiDurableHarnessLive,
	harnessCall,
	makePiTurnExecutorLayer,
} from "../../src/Pi/PiDurableHarness.ts"
import { createCheckfuRegistry } from "../../src/Pi/PiRefusals.ts"
import { makePiTurns } from "../../src/Pi/PiTurns.ts"
import { createInMemoryPiDurableBackend } from "./InMemoryPiBackend.ts"
import type { InMemoryPiDurableBackend } from "./InMemoryPiBackend.ts"
import { memorySql } from "./SqliteExecutor.ts"
import { VaultsTestLive } from "./VaultsHarness.ts"
import { ToolSchemaCheck } from "../../src/Pi/PiToolSchemaCheck.ts"

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
			if (typeof msg.content === "string") {
				return msg.content
			}
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
			.catch((error: unknown) => {
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
					errorMessage: error instanceof Error ? error.message : String(error),
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

const notOpen = () => Promise.resolve("not_found" as const)

/** Pi's own check, run in process as the harness Worker runs it. */
export const LocalToolSchemaCheck = Layer.succeed(ToolSchemaCheck, {
	checkable: (schemas) => Effect.sync(() => schemas.map(isCheckableInputSchema)),
})

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
	platform = Domain.InMemory,
	registry?: () => Registry,
	vaults: typeof VaultsTestLive = VaultsTestLive,
	/** Which tools ask a person first. With it, a session's Pi pauses and resumes as the session object's does. */
	asks?: ToolGateOptions["permission"],
	/** Wraps the waiting-call records the harness adapter reads, to make a race happen on cue. */
	confirmationsSeen?: (client: ToolConfirmation["Service"]) => ToolConfirmation["Service"],
) => {
	interface SessionObject {
		readonly backend: InMemoryPiDurableBackend
		/** Fails every call still running against this object once it is reset. */
		readonly gone: Deferred.Deferred<never, HarnessCallFailed>
		/** The session's turns when its tools can ask a person first. */
		readonly turns?: ReturnType<typeof makePiTurns>
	}
	const hasApiKey = (provider: keyof typeof PROVIDER_API_KEY_ENV) =>
		(envOverrides[PROVIDER_API_KEY_ENV[provider]] ?? "").length > 0
	const objects = new Map<string, Promise<SessionObject>>()
	// A session object's own tables outlive its isolate, as Durable Object storage does.
	const sqls = new Map<string, ReturnType<typeof memorySql>>()
	const resets: Array<string> = []
	const open = async (
		sessionId: string,
		storage?: InMemoryPiDurableBackend["storage"],
	): Promise<SessionObject> => {
		const gone = Deferred.makeUnsafe<never, HarnessCallFailed>()
		const reset = Effect.andThen(
			Effect.promise(async () => {
				// Only the object currently serving the session is replaced.
				const serving = await objects.get(sessionId)
				if (serving?.gone === gone) {
					resets.push(sessionId)
					serving.backend.retire()
					objects.set(sessionId, open(sessionId, serving.backend.storage))
				}
			}),
			Effect.andThen(
				Deferred.fail(gone, new HarnessCallFailed({ cause: "object reset in test" })),
				Effect.never,
			),
		)
		if (asks === undefined) {
			const backend = await createInMemoryPiDurableBackend(
				makeScriptedPiModels(handler),
				undefined,
				registry?.(),
				hasApiKey,
				{ ...(storage === undefined ? {} : { storage }), reset },
			)
			return { backend, gone }
		}
		const sql = sqls.get(sessionId) ?? memorySql()
		sqls.set(sessionId, sql)
		const approvals = new PiApprovalStore(sql)
		const customTools = new PiCustomToolStore(sql)
		let signal: ToolGateOptions["signal"] = notOpen
		let signalResult: ToolGateOptions["signalResult"] = notOpen
		const gate = makeToolGate({
			store: approvals,
			permission: asks,
			ledger: { began: () => undefined, ended: () => undefined },
			signal: (taskId, value) => signal(taskId, value),
			signalResult: (taskId, value) => signalResult(taskId, value),
		})
		const opened = registry?.() ?? createCheckfuRegistry()
		opened.install(gate.extension)
		// As the session object does: what it remembers is offered again when it opens.
		opened.install(customTools.extension(gate.park))
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(handler),
			undefined,
			opened,
			hasApiKey,
			{
				...(storage === undefined ? {} : { storage }),
				reset,
				gate,
				served: () => customTools.served(),
			},
		)
		signal = backend.signalTool
		signalResult = backend.signalToolResult
		const turns = makePiTurns({
			backend,
			approvals,
			gate,
			prepare: (request) => {
				if (customTools.bind(request.custom_tools ?? [])) {
					opened.install(customTools.extension(gate.park))
				}
				return Promise.resolve()
			},
			begin: () => customTools.forgetRequests(),
		})
		return { backend, gone, turns }
	}
	const getObject = (sessionId: string) => {
		let existing = objects.get(sessionId)
		if (existing === undefined) {
			existing = open(sessionId)
			objects.set(sessionId, existing)
		}
		return existing
	}
	/**
	 * Opens a session's Pi again over what it stored, as an evicted session
	 * object does. The Pi it replaces is dropped unclosed, like a process that died.
	 */
	const restartPi = async (sessionId: string) => {
		const serving = await objects.get(sessionId)
		if (serving === undefined) {
			return
		}
		serving.backend.retire()
		objects.set(sessionId, open(sessionId, serving.backend.storage))
		await objects.get(sessionId)
	}
	const onObject = <A>(
		sessionId: string,
		call: (object: SessionObject) => Effect.Effect<A>,
	): Effect.Effect<A, HarnessCallFailed> =>
		Effect.gen(function* () {
			const object = yield* Effect.promise(() => getObject(sessionId))
			// Parts of a call cannot be interrupted, so it runs detached and the caller
			// stops waiting when the object goes away.
			const running = yield* Effect.forkDetach(harnessCall(call(object)))
			return yield* Effect.raceFirst(Fiber.join(running), Deferred.await(object.gone))
		}).pipe(Effect.provideService(AbortGrace, "30 millis"))

	const requests: Array<PiTurnRequest> = []
	const forgetPiState = async (sessionId: string) => {
		const existing = objects.get(sessionId)
		objects.delete(sessionId)
		await (await existing)?.backend.close()
	}

	const unreachable = new Set<string>()
	const conversations: Array<string> = []
	const discardedWorkspaces: Array<string> = []
	const executorLayer = makePiTurnExecutorLayer(
		{
			recoverTurn: (conversation, operationId) =>
				Effect.suspend(() =>
					unreachable.has(conversation)
						? Effect.fail(new HarnessCallFailed({ cause: "unreachable in test" }))
						: !objects.has(conversation)
							? Effect.succeed(null)
							: onObject(conversation, ({ backend, turns }) =>
									turns === undefined
										? recoverPiDurableTurn(backend, operationId)
										: turns.recoverTurn(operationId),
								),
				),
			runTurn: (conversation, request) =>
				Effect.suspend(() => {
					if (unreachable.has(conversation)) {
						return Effect.fail(new HarnessCallFailed({ cause: "unreachable in test" }))
					}
					requests.push(request)
					conversations.push(conversation)
					return onObject(conversation, ({ backend, turns }) =>
						turns === undefined ? runPiDurableTurn(backend, request) : turns.runTurn(request),
					)
				}),
			resumeTurn: (conversation, operationId, decisions) =>
				onObject(conversation, ({ turns }) =>
					turns === undefined ? Effect.succeed(null) : turns.resumeTurn(operationId, decisions),
				),
			waitingCalls: (conversation) =>
				onObject(conversation, ({ turns }) =>
					turns === undefined ? Effect.succeed([]) : turns.waitingCalls(),
				),
			cancelWaiting: (conversation, operationId) =>
				onObject(conversation, ({ turns }) =>
					turns === undefined ? Effect.void : turns.cancelWaiting(operationId),
				),
			abortTurn: (conversation, operationId) =>
				Effect.suspend(() =>
					unreachable.has(conversation)
						? Effect.never
						: onObject(conversation, ({ backend, turns }) =>
								Effect.asVoid(
									turns === undefined
										? abortPiDurableTurn(backend, operationId)
										: turns.abortTurn(operationId),
								),
							),
				),
		},
		{
			discardWorkspace: (sessionId) =>
				Effect.sync(() => {
					discardedWorkspaces.push(sessionId)
				}),
		},
	)

	const HarnessLive =
		confirmationsSeen === undefined
			? PiDurableHarnessLive
			: PiDurableHarnessLive.pipe(
					Layer.provide(
						Layer.effect(ToolConfirmation, Effect.map(ToolConfirmation, confirmationsSeen)),
					),
				)
	const CheckfuLive = Checkfu.layer(CheckfuHandlersLive.pipe(Layer.provide(HarnessLive))).pipe(
		Layer.provide(executorLayer),
	)
	const PiProviderLive = HarnessLive.pipe(Layer.provide(executorLayer), Layer.provide(CheckfuLive))

	const closeAll = async () => {
		const pending = [...objects.values()]
		objects.clear()
		const results = await Promise.allSettled(
			pending.map(async (object) => {
				await (await object).backend.close()
			}),
		)
		const firstFailure = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		)
		if (firstFailure !== undefined) {
			throw firstFailure.reason
		}
	}

	const layer = Layer.mergeAll(CheckfuLive, PiProviderLive).pipe(
		Layer.provideMerge(
			Layer.succeed(HarnessLimits, {
				attempts: 2,
				baseDelay: "1 millis",
				interruptTimeout: "50 millis",
				settleMargin: "50 millis",
			}),
		),
		Layer.provide(platform),
		Layer.provide(Layer.effectDiscard(Effect.addFinalizer(() => Effect.promise(closeAll)))),
		Layer.provideMerge(vaults),
		Layer.provideMerge(LocalToolSchemaCheck),
		Layer.provideMerge(Digest.layerWebCrypto),
		Layer.provideMerge(SecureRandom.layerWebCrypto),
		Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(envOverrides))),
	)

	return {
		layer,
		closeAll,
		requests,
		forgetPiState,
		restartPi,
		unreachable,
		conversations,
		resets,
		discardedWorkspaces,
	}
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

export const makeApiTestClient = (
	fetchEffect: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest
	>,
) =>
	makeCheckfuClientWith({
		baseUrl: "http://localhost",
		httpClient: makeApiTestHttpClient(fetchEffect),
	})

export const makeApiTestHttpClient = (
	fetchEffect: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest
	>,
) =>
	HttpClient.make((request, url) =>
		Effect.gen(function* () {
			const headers = new Headers(request.headers)
			if (!headers.has("authorization") && !headers.has("x-api-key")) {
				headers.set("authorization", `Bearer ${TEST_API_KEY}`)
			}
			const body =
				request.body._tag === "Uint8Array" ? new Uint8Array(request.body.body) : undefined
			const webRequest = new Request(url.toString(), {
				method: request.method,
				headers,
				...(body === undefined ? {} : { body }),
			})
			const response = yield* fetchEffect.pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(webRequest),
				),
			)
			return HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(response))
		}),
	)

export type SseEventData = JsonObject & { readonly type: string }

export interface SseFrame {
	readonly id: string
	readonly event: string
	readonly data: SseEventData
}

export const readSseUntil = async (
	response: Response,
	predicate: (event: SseEventData) => boolean,
): Promise<Array<SseFrame>> => {
	const reader = response.body?.getReader()
	if (!reader) {
		throw new Error("Expected SSE response body stream")
	}
	const decoder = new TextDecoder()
	const collected: Array<SseFrame> = []
	let done = false
	const parser = Sse.makeParser((parsed) => {
		if (done || parsed._tag !== "Event") {
			return
		}
		const data = JSON.parse(parsed.data) as SseEventData
		collected.push({ id: parsed.id ?? "", event: parsed.event, data })
		if (predicate(data)) {
			done = true
			parser.reset()
		}
	})

	try {
		while (!done) {
			const chunk = await reader.read()
			if (chunk.done) {
				break
			}
			const error = parser.feed(decoder.decode(chunk.value, { stream: true }))
			if (error !== undefined) {
				throw error
			}
		}
		if (done) {
			await reader.cancel()
		} else {
			const tailError = parser.feed(decoder.decode())
			if (tailError !== undefined) {
				throw tailError
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

export const providerError = (error: { readonly _tag: string }): TurnFailed => {
	if (error._tag !== "TurnFailed") {
		throw new Error(`expected a provider error, got ${error._tag}`)
	}
	return error as TurnFailed
}

export const waitForSession = (
	apiFetch: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest
	>,
	sessionId: string,
	predicate: (session: { readonly status: string; readonly turn: number }) => boolean,
	description = "session did not reach expected state",
) =>
	Effect.gen(function* () {
		const poll = Effect.gen(function* () {
			const res = yield* sendRequest(apiFetch, {
				method: "GET",
				path: `/v1/sessions/${sessionId}`,
				headers: AUTH_HEADERS,
			})
			return (yield* Effect.promise(() => res.json())) as {
				readonly status: string
				readonly turn: number
			}
		})
		const current = yield* poll.pipe(
			Effect.repeat({
				schedule: Schedule.spaced("5 millis"),
				times: 400,
				until: predicate,
			}),
		)
		if (!predicate(current)) {
			return yield* Effect.die(new Error(description))
		}
		return current
	})

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
		yield* waitForSession(
			apiFetch,
			sessionId,
			(current) => current.status === "idle" && current.turn === turn,
			`turn ${turn} did not settle`,
		)
	})
