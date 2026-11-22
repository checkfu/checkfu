import { createServer } from "node:http"
import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/agents/Agent/AgentVersion.id"
import { CreateAgent } from "@checkfu/agents/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/agents/Agent/CreateAgent.decision"
import { ModelProvider } from "@checkfu/sessions/Session/ModelProvider.external"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai"
import { createRegistry } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { makeApiHandler } from "../src/Http/Router.ts"
import { createPiHarnessSettings } from "../src/Pi/PiContextBudget.ts"
import {
	type PiDurableBackend,
	type PiTurnRequest,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../src/Pi/PiDurableEngine.ts"
import { createNoRedirectProviderFetch, createPiModels } from "../src/Pi/PiModels.ts"
import {
	PROVIDER_FAILURE_MESSAGE,
	classifyUnansweredCategory,
	isProviderRefusalStopReason,
	isRefusalAssistantMessage,
	mapAssistantMessageToOutcome,
} from "../src/Pi/PiRefusals.ts"
import {
	AUTH_HEADERS,
	TEST_API_KEY,
	extractConversationMessageCount,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	makeScriptedPiModels,
	providerError,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

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
					const provider = yield* ModelProvider

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
						provider.generate({
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
						provider.generate({
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
				_tag: "ModelProviderError",
				error_type: "model_request_failed_error",
				message: PROVIDER_FAILURE_MESSAGE,
				terminal: false,
				model_usage: usage,
			},
		})
	})

	it("reads failure details from the settled submission record even after a later turn runs", async () => {
		let callIndex = 0
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model) => {
				callIndex++
				if (callIndex === 1) {
					return {
						...makeAssistantReply(model, null, "", 5, 1),
						stopReason: "error",
						errorMessage: "401 Unauthorized: invalid_api_key",
					}
				}
				return makeAssistantReply(model, null, "Turn 2 succeeded", 5, 3)
			}),
		)

		try {
			const turn1 = await runPiDurableTurn(backend, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "Bad key turn",
			})
			expect(turn1).toEqual({
				ok: false,
				error: {
					_tag: "ModelProviderError",
					error_type: "model_request_failed_error",
					message: PROVIDER_FAILURE_MESSAGE,
					terminal: false,
					model_usage: { input_tokens: 5, output_tokens: 1 },
				},
			})

			// Turn 2 runs and succeeds (mutating LiveDoc); re-reading Turn 1's settled submission
			// still returns Turn 1's own auth error.
			const turn2 = await runPiDurableTurn(backend, {
				operationId: "turn:2",
				turn: 2,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "Good turn",
			})
			expect(turn2).toMatchObject({ ok: true })

			const replayedTurn1 = await backend.readUnansweredSubmission("turn:1")
			expect(replayedTurn1).toMatchObject({
				reason: "model_error",
				detail: "401 Unauthorized: invalid_api_key",
				assistantMessage: {
					stopReason: "error",
					errorMessage: "401 Unauthorized: invalid_api_key",
				},
			})
		} finally {
			await backend.close()
		}
	})

	it("stops failed-turn lookup at the next turn boundary", async () => {
		// 2. Ascending failed-turn lookup stops at Turn 2's boundary without scanning later turns
		let callCount = 0
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context) => {
				callCount++
				if (callCount === 1) {
					return {
						...makeAssistantReply(model, null, "", 0, 0),
						stopReason: "error",
						errorMessage: "Temporary failure on turn 1",
					}
				}
				return makeAssistantReply(model, null, `Reply ${extractLastUserText(context)}`, 4, 2)
			}),
		)
		try {
			const turn1 = await runPiDurableTurn(backend, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "Failed turn 1",
			})
			expect(turn1).toMatchObject({ ok: false })

			const history: Array<{ readonly role: "user" | "assistant"; readonly text: string }> = [
				{ role: "user", text: "Failed turn 1" },
			]
			for (let t = 2; t <= 22; t++) {
				const text = `Later turn ${t}`
				const res = await runPiDurableTurn(backend, {
					operationId: `turn:${t}`,
					turn: t,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text,
				})
				expect(res).toMatchObject({ ok: true })
				history.push({ role: "user", text })
				history.push({ role: "assistant", text: `Reply ${text}` })
			}

			backend.clearScanEntryCalls()
			const recovered = await backend.readUnansweredSubmission("turn:1")
			expect(recovered?.assistantMessage?.errorMessage).toBe("Temporary failure on turn 1")

			const scans = backend.getScanEntryCalls()
			expect(scans.length).toBe(1)
			expect(scans[0]?.order).toBe("ascending")
			expect(scans[0]?.limit).toBe(32)
		} finally {
			await backend.close()
		}
	})

	it("sizes compaction thresholds below small-context models like gpt-4 and compacts instead of overflowing", async () => {
		const catalog = createPiModels({ openai: null, anthropic: null })
		const settings = createPiHarnessSettings(catalog)
		const gpt4Policy = settings.compaction.modelOverrides?.["openai/gpt-4"]
		expect(gpt4Policy).toBeDefined()
		expect(gpt4Policy?.backgroundTokens).toBe(0)
		expect(gpt4Policy?.reserveTokens).toBeLessThan(8_192)
		expect(gpt4Policy?.keepRecentTokens).toBeLessThan(8_192 - (gpt4Policy?.reserveTokens ?? 0))

		let compactionCalls = 0
		const turnMessageCounts: Array<number> = []
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model, context) => {
				const lastText = extractLastUserText(context)
				if (lastText.startsWith("<conversation>")) {
					compactionCalls += 1
					return makeAssistantReply(model, null, "Compact summary of earlier turns.", 200, 40)
				}
				turnMessageCounts.push(extractConversationMessageCount(context))
				const estimatedInput = Math.ceil(JSON.stringify(context.messages).length / 4)
				return makeAssistantReply(model, null, "r".repeat(6_000), estimatedInput, 1_500)
			}),
		)
		try {
			// Each turn adds ~3,000 tokens (user + assistant); by turn 4 history exceeds
			// gpt-4's 6,144-token blocking compaction threshold while staying well below Pi's 20,000-token default.
			for (let turn = 1; turn <= 4; turn++) {
				const result = await runPiDurableTurn(backend, {
					operationId: `turn:${turn}`,
					turn,
					provider: "openai",
					modelId: "gpt-4",
					system: null,
					text: `turn-${turn}: ${"u".repeat(6_000)}`,
				})
				expect(result).toMatchObject({ ok: true })
			}
			expect(compactionCalls).toBeGreaterThanOrEqual(1)
			// After compaction, the active message list shrinks rather than growing monotonically.
			expect(turnMessageCounts.at(-1)).toBeLessThan(7)
		} finally {
			await backend.close()
		}
	})

	it("logs a bounded error category without echoing raw provider error bodies", async () => {
		const secretBody = "SECRET_ECHOED_PAYLOAD_98765"
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(async (model) => ({
				...makeAssistantReply(model, null, "", 4, 0),
				stopReason: "error",
				errorMessage: `400 invalid_request: ${secretBody}`,
			})),
		)
		const warnCalls: Array<ReadonlyArray<unknown>> = []
		const originalWarn = console.warn
		console.warn = (...args: ReadonlyArray<unknown>) => {
			warnCalls.push(args)
		}
		try {
			const result = await runPiDurableTurn(backend, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "trigger error",
			})
			expect(result).toMatchObject({
				ok: false,
				error: { error_type: "model_request_failed_error", message: PROVIDER_FAILURE_MESSAGE },
			})
			expect(warnCalls.length).toBeGreaterThanOrEqual(1)
			const serialized = JSON.stringify(warnCalls)
			expect(serialized).not.toContain(secretBody)
			expect(warnCalls).toContainEqual([
				"pi turn unanswered",
				{ operationId: "turn:1", provider: "openai", category: "invalid_request" },
			])
		} finally {
			console.warn = originalWarn
			await backend.close()
		}
	})

	it("classifies provider errors by status or error code instead of incidental numbers", () => {
		expect(
			classifyUnansweredCategory("model_error", {
				reason: "model_error",
				detail: "429 Rate limit exceeded: Requested 401 tokens",
			}),
		).toBe("rate_limit")
		expect(
			classifyUnansweredCategory("model_error", {
				reason: "model_error",
				detail: "Rate limit exceeded: Requested 401 tokens",
			}),
		).toBe("rate_limit")
		expect(
			classifyUnansweredCategory("model_error", {
				reason: "model_error",
				detail: "Requested 401 tokens exceeds limit of 400",
			}),
		).toBe("model_error")
		expect(
			classifyUnansweredCategory("model_error", {
				reason: "model_error",
				detail:
					'400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens 500 > 401"}}',
			}),
		).toBe("invalid_request")
		expect(
			classifyUnansweredCategory("model_error", {
				reason: "model_error",
				detail: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			}),
		).toBe("provider_5xx")
		expect(
			classifyUnansweredCategory("model_error", {
				reason: "model_error",
				detail: "Error Code rate_limit_exceeded: Requested 401 tokens",
			}),
		).toBe("rate_limit")
		expect(
			classifyUnansweredCategory("model_error", {
				reason: "model_error",
				detail: "401 Incorrect API key provided",
			}),
		).toBe("auth_error")
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
			const first = await runPiDurableTurn(backend, turnRequest(1, "First"))
			expect(first).toMatchObject({ ok: true, reply: { input_tokens: 120_000, output_tokens: 1 } })
			const second = await runPiDurableTurn(backend, turnRequest(2, "Second"))
			expect(summaries).toBe(1)
			expect(attempts).toBe(2)
			expect(second).toMatchObject({ ok: true, reply: { input_tokens: 29, output_tokens: 6 } })
			expect(await runPiDurableTurn(backend, turnRequest(3, "Third"))).toMatchObject({
				ok: true,
				reply: { input_tokens: 6, output_tokens: 2 },
			})
			expect(await runPiDurableTurn(backend, turnRequest(2, "Second"))).toEqual(second)
			expect(await runPiDurableTurn(backend, turnRequest(1, "First"))).toEqual(first)
			expect(attempts).toBe(2)
		} finally {
			await backend.close()
		}
	})

	it("reports a turn cancelled before it reached Pi as interrupted, without calling the model", async () => {
		const { backend, calls } = await blockingBackend()
		try {
			await backend.abort("turn:1")
			expect(await runPiDurableTurn(backend, turnRequest(1, "never sent"))).toMatchObject({
				ok: false,
				error: { _tag: "ModelRequestInterrupted" },
			})
			expect(calls()).toBe(0)
		} finally {
			await backend.close()
		}
	})

	it("reports an aborted running turn as interrupted", async () => {
		const { backend, started } = await blockingBackend()
		try {
			const running = runPiDurableTurn(backend, turnRequest(1, "stop me"))
			await started
			await backend.abort("turn:1")
			expect(await running).toMatchObject({ ok: false, error: { _tag: "ModelRequestInterrupted" } })
		} finally {
			await backend.close()
		}
	})

	it("replays a saved reply when a late abort arrives", async () => {
		const { backend, release } = await blockingBackend()
		try {
			release()
			expect(await runPiDurableTurn(backend, turnRequest(1, "done first"))).toMatchObject({
				ok: true,
				reply: { text: "re: done first" },
			})
			await backend.abort("turn:1")
			expect(await runPiDurableTurn(backend, turnRequest(1, "done first"))).toMatchObject({
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
			const connection = new AbortController()
			const dropped = runPiDurableTurn(backend, turnRequest(1, "keep going"), connection.signal)
			await started
			connection.abort()
			await expect(dropped).rejects.toBeDefined()
			const next = runPiDurableTurn(backend, turnRequest(2, "next"))
			release()
			expect(await next).toMatchObject({ ok: true, reply: { input_tokens: 3, output_tokens: 2 } })
			expect(await runPiDurableTurn(backend, turnRequest(1, "keep going"))).toMatchObject({
				ok: true,
				reply: { text: "re: keep going", input_tokens: 3, output_tokens: 2 },
			})
			expect(calls()).toBe(2)
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
			const conn = new AbortController()
			const dropped = runPiDurableTurn(failedBackend, turnRequest(1, "doomed-turn-1"), conn.signal)
			await failedStarted
			conn.abort()
			await expect(dropped).rejects.toBeDefined()

			const successor = runPiDurableTurn(failedBackend, turnRequest(2, "clean-turn-2"))
			releaseFailed()
			expect(await successor).toMatchObject({
				ok: true,
				reply: { text: "re: clean-turn-2", input_tokens: 4, output_tokens: 2 },
			})
			expect(failedContexts.at(-1)).toEqual(["user:clean-turn-2"])

			// Re-entering Turn 1 still returns its sealed usage and failure outcome.
			expect(await runPiDurableTurn(failedBackend, turnRequest(1, "doomed-turn-1"))).toMatchObject({
				ok: false,
				error: {
					error_type: "model_request_failed_error",
					model_usage: { input_tokens: 7, output_tokens: 1 },
				},
			})
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
			const conn = new AbortController()
			const dropped = runPiDurableTurn(
				abortedBackend,
				turnRequest(1, "aborted-after-drop"),
				conn.signal,
			)
			await abortStarted
			conn.abort()
			await expect(dropped).rejects.toBeDefined()

			const successor = runPiDurableTurn(abortedBackend, turnRequest(2, "successor-after-abort"))
			await abortedBackend.abort("turn:1")
			expect(await successor).toMatchObject({
				ok: true,
				reply: { text: "re: successor-after-abort", input_tokens: 3, output_tokens: 2 },
			})
			expect(abortContexts.at(-1)).toEqual(["user:successor-after-abort"])
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
				ensureRoot: async (agent, create) => {
					admitting()
					await gate
					return backend.ensureRoot(agent, create)
				},
			}
			const running = runPiDurableTurn(slowRoot, turnRequest(1, "cancel me"))
			await reachedRoot
			const aborting = backend.abort("turn:1")
			proceed()
			expect(await running).toMatchObject({ ok: false, error: { _tag: "ModelRequestInterrupted" } })
			await aborting
			expect(await backend.hasSubmission("turn:1")).toBe(false)
			expect(calls()).toBe(0)
		} finally {
			await backend.close()
		}
	})

	it("restores a recovered error-stopped refusal into live Pi context across both replay and dropped-waiter finalization", async () => {
		const textOf = (message: TranscriptContext["messages"][number]) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")

		const runScenario = async (mode: "replay" | "finalize") => {
			const seenContexts: Array<ReadonlyArray<{ readonly role: string; readonly text: string }>> =
				[]
			// Use an empty registry so Pi persists the refusal as an unanswered `stopReason: "error"`
			// AssistantEntry, exercising the recovered-refusal path in runPiDurableTurn / finalizeSettledTurnFromStorage.
			const backend = await createInMemoryPiDurableBackend(
				makeScriptedPiModels(async (model, context) => {
					seenContexts.push(
						context.messages
							.filter((message) => message.role === "user" || message.role === "assistant")
							.map((message) => ({ role: message.role, text: textOf(message) })),
					)
					if (extractLastUserText(context) === "disallowed request") {
						return {
							...makeAssistantReply(model, null, "", 10, 2),
							content: [],
							stopReason: "error",
							rawStopReason: "refusal",
							errorMessage: "Refused for safety reasons.",
						}
					}
					return makeAssistantReply(model, null, "Follow-up acknowledged.", 12, 4)
				}),
				1,
				createRegistry(),
			)
			try {
				let turn1: Awaited<ReturnType<typeof runPiDurableTurn>> | undefined
				let turn1Replay: Awaited<ReturnType<typeof runPiDurableTurn>> | undefined
				if (mode === "replay") {
					turn1 = await runPiDurableTurn(backend, turnRequest(1, "disallowed request"))
					// Replaying the recovered refusal must be idempotent.
					turn1Replay = await runPiDurableTurn(backend, turnRequest(1, "disallowed request"))
				} else {
					// Simulate waiter disconnect before post-settlement recovery runs.
					const disconnect = new AbortController()
					const running = runPiDurableTurn(
						backend,
						turnRequest(1, "disallowed request"),
						disconnect.signal,
					)
					disconnect.abort()
					await running.catch(() => undefined)
					// Wait until turn:1 settles in Pi storage as unanswered.
					await backend.wait("turn:1")
				}

				const turn2 = await runPiDurableTurn(backend, turnRequest(2, "why did you refuse?"))
				return { turn1, turn1Replay, turn2, lastContext: seenContexts.at(-1) }
			} finally {
				await backend.close()
			}
		}

		const expectedContext = [
			{ role: "user", text: "disallowed request" },
			{ role: "assistant", text: "Refused for safety reasons." },
			{ role: "user", text: "why did you refuse?" },
		]
		const expectedRefusal = {
			ok: true,
			reply: {
				text: "Refused for safety reasons.",
				stop_reason: { type: "refusal" },
			},
		}

		const replayResult = await runScenario("replay")
		expect(replayResult.turn1).toMatchObject(expectedRefusal)
		expect(replayResult.turn1Replay).toMatchObject(expectedRefusal)
		expect(replayResult.turn2).toMatchObject({
			ok: true,
			reply: { text: "Follow-up acknowledged." },
		})
		expect(replayResult.lastContext).toEqual(expectedContext)

		const finalizeResult = await runScenario("finalize")
		expect(finalizeResult.turn2).toMatchObject({
			ok: true,
			reply: { text: "Follow-up acknowledged." },
		})
		expect(finalizeResult.lastContext).toEqual(expectedContext)
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

	it("discards partial output when restoring a stored content_filter refusal across replay and finalization", async () => {
		const textOf = (message: TranscriptContext["messages"][number]) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")

		const runScenario = async (mode: "replay" | "finalize") => {
			const seenContexts: Array<ReadonlyArray<{ readonly role: string; readonly text: string }>> =
				[]
			const backend = await createInMemoryPiDurableBackend(
				makeScriptedPiModels(async (model, context) => {
					seenContexts.push(
						context.messages
							.filter((message) => message.role === "user" || message.role === "assistant")
							.map((message) => ({ role: message.role, text: textOf(message) })),
					)
					if (extractLastUserText(context) === "filtered prompt") {
						return {
							...makeAssistantReply(
								model,
								"SECRET_PARTIAL_THINKING",
								"PARTIAL_FILTERED_BODY",
								10,
								4,
							),
							stopReason: "error",
							rawStopReason: "incomplete.content_filter",
							errorMessage: "Response incomplete: content_filter",
						}
					}
					return makeAssistantReply(model, null, "Follow-up ok.", 12, 4)
				}),
				1,
				createRegistry(),
			)
			try {
				let turn1: Awaited<ReturnType<typeof runPiDurableTurn>> | undefined
				if (mode === "replay") {
					turn1 = await runPiDurableTurn(backend, turnRequest(1, "filtered prompt"))
				} else {
					const disconnect = new AbortController()
					const running = runPiDurableTurn(
						backend,
						turnRequest(1, "filtered prompt"),
						disconnect.signal,
					)
					disconnect.abort()
					await running.catch(() => undefined)
					await backend.wait("turn:1")
				}
				const turn2 = await runPiDurableTurn(backend, turnRequest(2, "after filter"))
				return { turn1, turn2, lastContext: seenContexts.at(-1) }
			} finally {
				await backend.close()
			}
		}

		const expectedContext = [
			{ role: "user", text: "filtered prompt" },
			{ role: "assistant", text: "Response incomplete: content_filter" },
			{ role: "user", text: "after filter" },
		]

		const replayResult = await runScenario("replay")
		expect(replayResult.turn1).toMatchObject({
			ok: true,
			reply: {
				thinking: null,
				text: "Response incomplete: content_filter",
				stop_reason: { type: "refusal" },
			},
		})
		expect(replayResult.lastContext).toEqual(expectedContext)

		const finalizeResult = await runScenario("finalize")
		expect(finalizeResult.turn2).toMatchObject({ ok: true, reply: { text: "Follow-up ok." } })
		expect(finalizeResult.lastContext).toEqual(expectedContext)
	})

	it("refuses HTTP redirects and cross-origin requests at the provider fetch transport", async () => {
		let targetHits = 0
		const targetServer = createServer((_req, res) => {
			targetHits += 1
			res.writeHead(200, { "content-type": "text/plain" })
			res.end("SHOULD_NOT_BE_REACHED")
		})
		await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", () => resolve()))
		const targetPort = (targetServer.address() as { port: number }).port

		let redirectorHits = 0
		const redirectorServer = createServer((_req, res) => {
			redirectorHits += 1
			res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/steal` })
			res.end()
		})
		await new Promise<void>((resolve) => redirectorServer.listen(0, "127.0.0.1", () => resolve()))
		const redirectorPort = (redirectorServer.address() as { port: number }).port

		try {
			const models = createPiModels({
				openai: Redacted.make("sk-openai-test"),
				anthropic: Redacted.make("sk-ant-test"),
			})

			// 1. Real OpenAI provider stream refuses a 302 redirect at transport; redirect target gets 0 hits.
			const openaiBase = models.getModel("openai", "gpt-4o-mini")
			if (openaiBase === undefined) throw new Error("expected gpt-4o-mini")
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
			if (anthropicBase === undefined) throw new Error("expected claude-sonnet-4-5")
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
		} finally {
			redirectorServer.close()
			targetServer.close()
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
			ensureRoot: async (
				agent: Parameters<typeof rawBackend.ensureRoot>[0],
				create: Parameters<typeof rawBackend.ensureRoot>[1],
			) => {
				markEnteredEnsureRoot()
				await holdLockStep
				return rawBackend.ensureRoot(agent, create)
			},
		}

		try {
			// Original runTurn enters admitPiTurn, acquires withLock, and pauses before submit().
			const originalTurn = runPiDurableTurn(backend, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "hello",
			})
			await enteredEnsureRoot

			// Retry's recovery probe starts while admitPiTurn still holds the lock before submit().
			// It MUST wait for admission to finish instead of returning null.
			let recoverySettled = false
			const recovery = recoverPiDurableTurn(backend, "turn:1").then((outcome) => {
				recoverySettled = true
				return outcome
			})
			await new Promise((resolve) => setTimeout(resolve, 15))
			expect(recoverySettled).toBe(false)

			releaseLockStep()
			const [originalResult, recoveredResult] = await Promise.all([originalTurn, recovery])
			expect(originalResult).not.toBe("history_required")
			expect(recoveredResult).not.toBeNull()
			expect(recoveredResult?.ok ? recoveredResult.reply.text : null).toBe(
				"Committed after disconnect",
			)
		} finally {
			releaseLockStep()
			await rawBackend.close()
		}
	})
})
