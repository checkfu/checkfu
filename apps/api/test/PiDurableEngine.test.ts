import { createServer } from "node:http"
import { PassThrough } from "node:stream"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/domain/Agent/AgentVersion.id"
import { CreateAgent } from "@checkfu/domain/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/domain/Agent/CreateAgent.decision"
import { Harness } from "@checkfu/domain/Session/Harness.external"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai"
import { describe, expect, it } from "@effect/vitest"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { RuntimeContext } from "alchemy/RuntimeContext"
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
import { resolveCatalogModel } from "../src/Pi/PiCatalog.ts"
import {
	AbortGrace,
	abortPiDurableTurn,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../src/Pi/PiDurableEngine.ts"
import type { PiDurableBackend } from "../src/Pi/PiDurableEngine.ts"
import type { PiTurnRequest } from "../src/Pi/PiTurn.ts"
import {
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_OPENAI_BASE_URL,
	LOCAL_DEV_SIGNAL_ENV,
	LOCAL_DEV_SIGNAL_VALUE,
	OPENAI_BASE_URL_ENV,
	createNoRedirectProviderFetch,
	createPiModels,
	parseLoopbackBaseUrl,
	providerBaseUrls,
} from "../src/Pi/PiModels.ts"
import {
	PROVIDER_FAILURE_MESSAGE,
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

describe("PiDurableEngine storage, compaction, and provider error classification", () => {
	it("supports OpenAI + Anthropic only and surfaces missing_api_key_error / unknown_model_error", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(
			async (model) => makeAssistantReply(model, null, "unused", 1, 1),
			{ CHECKFU_API_KEY: TEST_API_KEY },
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
							session_id: SessionId.make("sess_test"),
							agent_id: openaiAgent.id,
							agent_version: 1,
							environment_id: env.id,
							turn: 1,
							generation: 0,
							input: ["Hi"],
						}),
					)
					expect(providerError(missingKeyErr).error_type).toBe("missing_api_key_error")
					expect(providerError(missingKeyErr).terminal).toBe(false)

					const unsupportedModelErr = yield* Effect.flip(
						provider.runTurn({
							session_id: SessionId.make("sess_test"),
							agent_id: geminiAgent.id,
							agent_version: 1,
							environment_id: "env_1",
							turn: 1,
							generation: 0,
							input: ["Hi"],
						}),
					)
					expect(providerError(unsupportedModelErr).error_type).toBe("unknown_model_error")
					expect(providerError(unsupportedModelErr).terminal).toBe(true)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
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
		const models = createPiModels({ openai: null, anthropic: null }).getModels()
		const small = models.filter(
			(model) => model.contextWindow < PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW,
		)
		expect(small.map((model) => `${model.provider}/${model.id}`)).toContain("openai/gpt-4")
		for (const model of small) {
			expect(resolveCatalogModel(`${model.provider}/${model.id}`)).toBeNull()
		}
		expect(resolveCatalogModel("gpt-4")).toBeNull()
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
					// Enough history for Pi to select a cut and exceed its blocking threshold.
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

		// 1. Dropped waiter whose turn settles with a provider error: successor must NOT see Turn 1's prompt.
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

					// Re-entering Turn 1 still returns its sealed usage and failure outcome.
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

		// 2. Dropped waiter whose turn is subsequently aborted: successor must NOT see Turn 1's prompt.
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
					expect(yield* Effect.promise(() => backend.hasSubmission("turn:1"))).toBe(false)
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
			const models = createPiModels({
				openai: Redacted.make("sk-openai-test"),
				anthropic: Redacted.make("sk-ant-test"),
			})

			// 1. Real OpenAI provider stream refuses a 302 redirect at transport; redirect target gets 0 hits.
			const openaiBase = models.getModel("openai", "gpt-4o-mini")
			if (openaiBase === undefined) {
				throw new Error("expected gpt-4o-mini")
			}
			const openaiStream = models.streamSimple(
				{ ...openaiBase, baseUrl: `http://127.0.0.1:${redirectorPort}/v1` },
				{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
				{ apiKey: "sk-openai-test", maxRetries: 0 },
			)
			const openaiResult = await openaiStream.result()
			expect(openaiResult.stopReason).toBe("error")
			expect(redirectorHits).toBeGreaterThanOrEqual(1)
			expect(targetHits).toBe(0)

			// 2. Real Anthropic provider stream refuses a 302 redirect at transport; redirect target gets 0 hits.
			const hitsBeforeAnthropic = redirectorHits
			const anthropicBase = models.getModel("anthropic", "claude-sonnet-4-5")
			if (anthropicBase === undefined) {
				throw new Error("expected claude-sonnet-4-5")
			}
			const anthropicStream = models.streamSimple(
				{ ...anthropicBase, baseUrl: `http://127.0.0.1:${redirectorPort}` },
				{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
				{ apiKey: "sk-ant-test", maxRetries: 0 },
			)
			const anthropicResult = await anthropicStream.result()
			expect(anthropicResult.stopReason).toBe("error")
			expect(redirectorHits).toBeGreaterThan(hitsBeforeAnthropic)
			expect(targetHits).toBe(0)

			// 3. Transport fetch wrapper sets redirect: "manual" (workerd-compatible), rejects raw 3xx
			//    responses, and blocks requests whose origin does not match the provider baseUrl.
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

			// 4. A URL instance carrying an extra `url` property must still be validated and
			//    dispatched using its real destination, never the unrelated `url` property.
			const spoofedUrl = Object.assign(new URL("https://evil.example/steal"), {
				url: "https://api.openai.com/v1/responses",
			})
			await expect(guardedFetch(spoofedUrl)).rejects.toThrow(/disallowed origin/i)
			expect(seenInits).toHaveLength(1)

			// 5. Redirect responses marked `redirected: true` or `type: "opaqueredirect"` must also
			//    be rejected and have their response body cancelled.
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

			// 6. Request objects (native, subclassed, or plain request-like objects) are rejected
			//    fail-closed without calling upstream fetch or consuming the request body.
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

			// 7. Allowed URL instances are pinned as normalized immutable URL strings before dispatch,
			//    so post-call URL mutation while awaiting credentials cannot change the destination.
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

			// 8. Init options (including runtime transport fields and getter-backed fields) are
			//    evaluated once, forwarded intact without mutating caller init, and keep manual redirects.
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

			// 8b. Copying `init` must not invoke prototype setters when `init` carries an own
			//     enumerable `__proto__` key, so inherited transport options cannot be injected.
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

			// 9. When `upstreamFetch` is omitted, `globalThis.fetch` is resolved lazily at call time.
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

				// 1. Custom `dispatcher` in `init` routes through that transport instead of direct origin,
				//    and still refuses 3xx redirects returned by the dispatcher.
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

				// 2. Direct-vs-guarded parity for buffered `keepalive: true` POSTs, empty headers, and FormData.
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

				// 3. Request objects (including subclasses with default Authorization headers or
				//    inherited/explicit keepalive: true) are rejected fail-closed without contacting
				//    the server or consuming the request body.
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

				// 4. Node upload streams in `init.body` are forwarded untouched to the transport:
				//    the guard installs no wrapper or error listener, so destroying an upload stream
				//    with an error and rejecting delivers the transport rejection to the caller and
				//    emits the stream `error` event once to a listener attached before emission.
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
						// Listener attached synchronously between `destroy(error)` and Node's async
						// `error` event emission must receive the error exactly once.
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

				// 1. Proxy routing and redirect refusal through configured Bun proxy.
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

				// An own enumerable `__proto__` property on `init` must not become the prototype of
				// the forwarded options object and inject `proxy` or `headers` into Bun's fetch.
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

				// 2. Connection reuse: `{ keepalive: false }` opens fresh connections vs default reuse.
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

				// 3. Known-length POST preserves Content-Length, empty POST sends 0 bytes, and streaming
				//    uploads cancel cleanly on abort.
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

				// 4. Request objects are rejected fail-closed without contacting the server.
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
			// Original runTurn enters admitPiTurn, acquires withLock, and pauses before submit().
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

			// Retry's recovery probe starts while admitPiTurn still holds the lock before submit().
			// It MUST wait for admission to finish instead of returning null.
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
			expect(recoveredResult?.ok ? recoveredResult.reply.text : null).toBe(
				"Committed after disconnect",
			)
		} finally {
			releaseLockStep()
			await rawBackend.close()
		}
	})

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

						// Interrupting the holder while its async critical section is still running
						// must NOT release the semaphore permit before the critical section finishes.
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
			{} as unknown as Parameters<typeof makePiHarnessBackend>[2],
			{ openai: Redacted.make("sk-test"), anthropic: null },
			() => undefined,
		)
		expect(backend.hasApiKey("openai")).toBe(true)
		expect(backend.hasApiKey("anthropic")).toBe(false)
	})

	it("keeps a queued abort alive when interrupted while submit holds the permit", async () => {
		// 1. Directly exercise `PiSession.do.ts`'s `makePiHarnessBackend` abort path.
		const cancelled = new Set<string>()
		const harnessAborts: Array<string> = []
		const harnessBackend = makePiHarnessBackend(
			{ start: async () => undefined } as unknown as Parameters<typeof makePiHarnessBackend>[0],
			{
				abort: async ({ operationId }: { readonly operationId: string }) => {
					harnessAborts.push(operationId)
				},
			} as unknown as Parameters<typeof makePiHarnessBackend>[1],
			{
				markCancelled: (operationId: string) => {
					cancelled.add(operationId)
				},
				isCancelled: (operationId: string) => cancelled.has(operationId),
			} as unknown as Parameters<typeof makePiHarnessBackend>[2],
			{ openai: null, anthropic: null },
			() => undefined,
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

					// Interrupting the queued abort while `submit` holds the permit must NOT
					// drop the waiter before `harness.abort` executes.
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

		// 2. End-to-end against `InMemoryPiDurableBackend`: interrupt abort while `admitPiTurn`
		// is paused inside `submit()` (after the final fence check) and verify recovery sees
		// `TurnInterrupted` instead of a completed reply.
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
		expect(readKeys).toEqual([OPENAI_BASE_URL_ENV])
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
				? new Promise<AssistantMessage>(() => {
						// Never settles and ignores its abort signal.
					})
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

		// The abandoned turn never stops, so the next turn's abort runs out of grace and resets.
		expect(Exit.isFailure(await runNext())).toBe(true)
		expect(resets).toBe(1)

		// Reopened over the same storage, Pi has the abort on record: it settles the stuck
		// turn without calling the model again, and the next turn runs.
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
			// Turn 1 never reached Pi; the session moved on and turn 2 is running.
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

			// The same late turn after turn 2 settled is still refused, and never reaches the model.
			expect(await Effect.runPromise(runPiDurableTurn(backend, turn(1, "late")))).toMatchObject(
				interrupted,
			)
			expect(prompts).toEqual(["second"])
		} finally {
			releaseSecond()
			await backend.close()
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
			await expect(first.hasSubmission("turn:1")).rejects.toThrow("This session object was reset")
			expect(() => first.isCancelled("turn:1")).toThrow("This session object was reset")
			expect(await second.hasSubmission("turn:1")).toBe(true)
			expect(await second.hasSubmission("turn:9")).toBe(false)
			expect(await Effect.runPromise(runPiDurableTurn(second, turn(2, "after")))).toMatchObject({
				ok: true,
				reply: { text: "Echo after" },
			})
		} finally {
			await second.close()
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
			// Pi answers turns 1 and 2, but the domain had already abandoned both, so neither reply
			// reached the session.
			await Effect.runPromise(runPiDurableTurn(backend, turn(1, "lost")))
			await Effect.runPromise(runPiDurableTurn(backend, turn(2, "also lost", [1])))
			await Effect.runPromise(runPiDurableTurn(backend, turn(3, "kept", [1, 2])))
			await Effect.runPromise(runPiDurableTurn(backend, turn(4, "next")))
			expect(contexts).toEqual(["lost", "also lost", "kept", "kept | Echo kept | next"])
		} finally {
			await backend.close()
		}
	})
})
