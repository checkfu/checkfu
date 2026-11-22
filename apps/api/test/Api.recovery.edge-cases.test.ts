import * as Domain from "@alchemy.run/domain"
import { AgentVersionByNumberView } from "@checkfu/agents/Agent/AgentVersionByNumberView.view"
import { EnvironmentView } from "@checkfu/environments/Environment/EnvironmentView.view"
import { ModelProvider } from "@checkfu/sessions/Session/ModelProvider.external"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { MAX_MESSAGE_TEXT_LENGTH } from "@checkfu/sessions/Session/SessionTypes"
import { SessionView } from "@checkfu/sessions/Session/SessionView.view"
import { SessionsHandlersLive } from "@checkfu/sessions/Sessions.model"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Checkfu } from "../src/Checkfu.model.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { SEED_MESSAGE_OVERHEAD_TOKENS, seedTokenBudget } from "../src/Pi/PiContextBudget.ts"
import {
	type PiTurnRequest,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../src/Pi/PiDurableEngine.ts"
import {
	AgentVersionLookupTimeout,
	HarnessLimits,
	PiDurableModelProviderLive,
	SeedMaxScanPages,
	conversationName,
	makePiTurnExecutorLayer,
} from "../src/Pi/PiDurableModelProvider.ts"
import { PROVIDER_FAILURE_MESSAGE } from "../src/Pi/PiRefusals.ts"
import {
	AUTH_HEADERS,
	TEST_API_KEY,
	createIdleSession,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	makeScriptedPiModels,
	providerError,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

describe("Pi history recovery edge cases and interrupt consistency", () => {
	it("bounds the number of event pages scanned during history recovery after many unanswered turns", async () => {
		let failTurns = false
		let listCalls = 0
		const backends = new Map<string, ReturnType<typeof createInMemoryPiDurableBackend>>()
		const models = makeScriptedPiModels(async (model, context) =>
			makeAssistantReply(model, null, `Echo: ${extractLastUserText(context)}`, 5, 3),
		)
		const getBackend = (conversation: string) => {
			let backend = backends.get(conversation)
			if (backend === undefined) {
				backend = createInMemoryPiDurableBackend(models)
				backends.set(conversation, backend)
			}
			return backend
		}
		const requests: Array<PiTurnRequest> = []
		const executorLayer = makePiTurnExecutorLayer({
			recoverTurn: (conversation, operationId) =>
				!backends.has(conversation)
					? Effect.succeed(null)
					: Effect.promise(async (signal) =>
							recoverPiDurableTurn(await getBackend(conversation), operationId, signal),
						),
			runTurn: (conversation, request) =>
				Effect.promise(async () => {
					requests.push(request)
					if (failTurns) {
						return {
							ok: false as const,
							error: {
								_tag: "ModelProviderError" as const,
								error_type: "model_request_failed_error",
								message: PROVIDER_FAILURE_MESSAGE,
								terminal: false,
							},
						}
					}
					return runPiDurableTurn(await getBackend(conversation), request)
				}),
			abortTurn: () => Effect.void,
		})
		const CountingSessionView = Layer.effect(
			SessionView,
			Effect.map(SessionView, (real) => ({
				...real,
				list: (ref, options) => {
					if (options?.order === "desc") {
						listCalls += 1
					}
					return real.list(ref, options)
				},
			})),
		)
		const CheckfuLive = Checkfu.layer(
			SessionsHandlersLive.pipe(
				Layer.provide(PiDurableModelProviderLive.pipe(Layer.provide(CountingSessionView))),
			),
		).pipe(Layer.provide(executorLayer))
		const PiProviderLive = PiDurableModelProviderLive.pipe(
			Layer.provide(CountingSessionView),
			Layer.provide(executorLayer),
			Layer.provide(CheckfuLive),
		)
		const layer = Layer.mergeAll(CheckfuLive, PiProviderLive).pipe(
			Layer.provide(Layer.succeed(SeedMaxScanPages, 2)),
			Layer.provide(
				Layer.succeed(HarnessLimits, {
					attempts: 1,
					baseDelayMs: 1,
					interruptTimeoutMs: 50,
					settleMarginMs: 50,
				}),
			),
			Layer.provide(Domain.InMemory),
			Layer.provideMerge(SecureRandom.layerWebCrypto),
			Layer.provideMerge(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						CHECKFU_API_KEY: TEST_API_KEY,
						OPENAI_API_KEY: "sk-test",
					}),
				),
			),
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					const waitIdle = (expectedTurn: number) =>
						Effect.gen(function* () {
							for (let attempt = 0; attempt < 400; attempt++) {
								const res = yield* sendRequest(apiFetch, {
									method: "GET",
									path: `/v1/sessions/${session.id}`,
									headers: AUTH_HEADERS,
								})
								const body = (yield* Effect.promise(() => res.json())) as {
									status: string
									turn: number
								}
								if (body.status === "idle" && body.turn >= expectedTurn) return
								yield* Effect.sleep("5 millis")
							}
							throw new Error(`Session did not become idle at turn ${expectedTurn}`)
						})

					// Turn 1 succeeds; then 40 consecutive failed turns write ~240 events (> 2 pages of 100).
					yield* sendAndSettle(apiFetch, session.id, ["ancient-turn"], 1)
					failTurns = true
					for (let turn = 2; turn <= 41; turn++) {
						yield* sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/sessions/${session.id}/events`,
							headers: AUTH_HEADERS,
							body: {
								events: [
									{ type: "user.message", content: [{ type: "text", text: `fail-${turn}` }] },
								],
							},
						})
						yield* waitIdle(turn)
					}

					// Lose Pi state and run Turn 42: recovery must stop at SeedMaxScanPages (2) instead of
					// scanning every historical page back to Turn 1.
					failTurns = false
					const existing = backends.get(conversationName(session.id, 0))
					backends.delete(conversationName(session.id, 0))
					if (existing !== undefined) yield* Effect.promise(async () => (await existing).close())
					listCalls = 0

					yield* sendAndSettle(apiFetch, session.id, ["fresh-after-failures"], 42)
					expect(listCalls).toBe(2)
					expect(requests.at(-1)?.seed?.messages).toEqual([])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			for (const b of backends.values()) {
				await (await b).close()
			}
		}
	})

	it("keeps interrupted prompts out of both retained Pi roots and rebuilt history", async () => {
		const textOf = (message: TranscriptContext["messages"][number]) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
		const contexts: Array<ReadonlyArray<{ readonly role: string; readonly text: string }>> = []

		let midStreamStartedResolve: (() => void) | undefined
		const midStreamStarted = new Promise<void>((resolve) => {
			midStreamStartedResolve = resolve
		})

		const { layer, closeAll, forgetPiState } = makePiDurableTestLayer(
			async (model, context, signal) => {
				const lastText = extractLastUserText(context)
				if (lastText === "mid-stream-interrupted") {
					midStreamStartedResolve?.()
					await new Promise<void>((resolve) => {
						if (signal?.aborted) {
							resolve()
							return
						}
						signal?.addEventListener("abort", () => resolve(), { once: true })
					})
					return {
						...makeAssistantReply(model, null, "", 0, 0),
						stopReason: "aborted" as const,
					}
				}
				contexts.push(
					context.messages
						.filter((message) => message.role === "user" || message.role === "assistant")
						.map((message) => ({ role: message.role, text: textOf(message) })),
				)
				return makeAssistantReply(model, null, `Echo: ${lastText}`, 5, 3)
			},
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					const waitIdle = (expectedTurn: number) =>
						Effect.gen(function* () {
							for (let attempt = 0; attempt < 400; attempt++) {
								const res = yield* sendRequest(apiFetch, {
									method: "GET",
									path: `/v1/sessions/${session.id}`,
									headers: AUTH_HEADERS,
								})
								const body = (yield* Effect.promise(() => res.json())) as {
									status: string
									turn: number
								}
								if (body.status === "idle" && body.turn >= expectedTurn) return
								yield* Effect.sleep("5 millis")
							}
							throw new Error(`Session did not become idle at turn ${expectedTurn}`)
						})

					// Turn 1 succeeds.
					yield* sendAndSettle(apiFetch, session.id, ["kept-1"], 1)

					// Turn 2 is interrupted AFTER Pi places the user entry (mid-stream abort).
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									type: "user.message",
									content: [{ type: "text", text: "mid-stream-interrupted" }],
								},
							],
						},
					})
					yield* Effect.promise(() => midStreamStarted)
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [{ type: "user.interrupt" }] },
					})
					yield* waitIdle(2)

					// Turn 3 runs against the RETAINED Pi root: must NOT contain the interrupted Turn 2 prompt.
					yield* sendAndSettle(apiFetch, session.id, ["kept-3"], 3)
					const turn3Retained = contexts.at(-1)
					expect(turn3Retained).toEqual([
						{ role: "user", text: "kept-1" },
						{ role: "assistant", text: "Echo: kept-1" },
						{ role: "user", text: "kept-3" },
					])

					// Lose Pi state and run Turn 4: REBUILT seed must match the same policy (no Turn 2 prompt).
					yield* Effect.promise(() => forgetPiState(conversationName(session.id, 0)))
					yield* sendAndSettle(apiFetch, session.id, ["kept-4"], 4)
					expect(contexts.at(-1)).toEqual([
						{ role: "user", text: "kept-1" },
						{ role: "assistant", text: "Echo: kept-1" },
						{ role: "user", text: "kept-3" },
						{ role: "assistant", text: "Echo: kept-3" },
						{ role: "user", text: "kept-4" },
					])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("matches pre-submit interrupted turns identically across retained root and rebuild", async () => {
		const textOf = (message: TranscriptContext["messages"][number]) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
		const contexts: Array<ReadonlyArray<{ readonly role: string; readonly text: string }>> = []

		const backends = new Map<string, ReturnType<typeof createInMemoryPiDurableBackend>>()
		const models = makeScriptedPiModels(async (model, context) => {
			contexts.push(
				context.messages
					.filter((message) => message.role === "user" || message.role === "assistant")
					.map((message) => ({ role: message.role, text: textOf(message) })),
			)
			return makeAssistantReply(model, null, `Echo: ${extractLastUserText(context)}`, 5, 3)
		})
		const getBackend = (conversation: string) => {
			let backend = backends.get(conversation)
			if (backend === undefined) {
				backend = createInMemoryPiDurableBackend(models)
				backends.set(conversation, backend)
			}
			return backend
		}
		let releaseTurn2Admit: (() => void) | undefined
		let reachedTurn2AdmitResolve: (() => void) | undefined
		let turn2AbortedResolve: (() => void) | undefined
		const reachedTurn2Admit = new Promise<void>((resolve) => {
			reachedTurn2AdmitResolve = resolve
		})
		const turn2AdmitGate = new Promise<void>((resolve) => {
			releaseTurn2Admit = resolve
		})
		const turn2Aborted = new Promise<void>((resolve) => {
			turn2AbortedResolve = resolve
		})

		const executorLayer = makePiTurnExecutorLayer({
			recoverTurn: (conversation, operationId) =>
				!backends.has(conversation)
					? Effect.succeed(null)
					: Effect.promise(async (signal) =>
							recoverPiDurableTurn(await getBackend(conversation), operationId, signal),
						),
			runTurn: (conversation, request) =>
				Effect.promise(async () => {
					const backend = await getBackend(conversation)
					if (request.turn === 2) {
						reachedTurn2AdmitResolve?.()
						await turn2AdmitGate
					}
					return runPiDurableTurn(backend, request)
				}),
			abortTurn: (conversation, operationId) =>
				Effect.promise(async () => {
					const backend = await getBackend(conversation)
					await backend.abort(operationId)
					if (operationId === "turn:2") {
						turn2AbortedResolve?.()
					}
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
			Layer.provideMerge(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						CHECKFU_API_KEY: TEST_API_KEY,
						OPENAI_API_KEY: "sk-test",
					}),
				),
			),
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["turn-1"], 1)

					// Turn 2 is interrupted BEFORE Pi admits/submits it.
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "before-submit-cut" }] },
							],
						},
					})
					yield* Effect.promise(() => reachedTurn2Admit)
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [{ type: "user.interrupt" }] },
					})
					// Wait deterministically for StopModelRequest to mark TurnFence cancelled before releasing Turn 2.
					yield* Effect.promise(() => turn2Aborted)
					releaseTurn2Admit?.()

					for (let attempt = 0; attempt < 400; attempt++) {
						const res = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/sessions/${session.id}`,
							headers: AUTH_HEADERS,
						})
						const body = (yield* Effect.promise(() => res.json())) as {
							status: string
							turn: number
						}
						if (body.status === "idle" && body.turn >= 2) break
						yield* Effect.sleep("5 millis")
					}

					// Turn 3 with retained root does not see "before-submit-cut".
					yield* sendAndSettle(apiFetch, session.id, ["turn-3"], 3)
					expect(contexts.at(-1)).toEqual([
						{ role: "user", text: "turn-1" },
						{ role: "assistant", text: "Echo: turn-1" },
						{ role: "user", text: "turn-3" },
					])

					// Rebuild after losing Pi state must produce the exact same prior history.
					const existing = backends.get(conversationName(session.id, 0))
					backends.delete(conversationName(session.id, 0))
					if (existing !== undefined) yield* Effect.promise(async () => (await existing).close())

					yield* sendAndSettle(apiFetch, session.id, ["turn-4"], 4)
					expect(contexts.at(-1)).toEqual([
						{ role: "user", text: "turn-1" },
						{ role: "assistant", text: "Echo: turn-1" },
						{ role: "user", text: "turn-3" },
						{ role: "assistant", text: "Echo: turn-3" },
						{ role: "user", text: "turn-4" },
					])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			for (const b of backends.values()) {
				await (await b).close()
			}
		}
	})

	it("still validates the recovery turn even when a large prompt exhausts the seed budget", async () => {
		let modelCalls = 0
		const { layer, closeAll, forgetPiState } = makePiDurableTestLayer(async (model) => {
			modelCalls += 1
			return makeAssistantReply(model, null, "ok", 5, 2)
		})
		const fastLookupLayer = Layer.succeed(AgentVersionLookupTimeout, "40 millis").pipe(
			Layer.provideMerge(layer),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const provider = yield* ModelProvider

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "GPT-4 Agent", model: "gpt-4" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }
					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					yield* sendAndSettle(apiFetch, session.id, ["turn-1"], 1)
					yield* sendAndSettle(apiFetch, session.id, ["turn-2"], 2)
					yield* sendAndSettle(apiFetch, session.id, ["turn-3"], 3)
					yield* Effect.promise(() => forgetPiState(conversationName(session.id, 0)))

					// Stale turn 2 recovery with a 16,384-char prompt (seed budget = 0 on gpt-4):
					// SessionView is already at turn 3, so this MUST fail with session_history_unavailable
					// instead of skipping turn validation and calling the model.
					const callsBefore = modelCalls
					const staleErr = yield* Effect.flip(
						provider.generate({
							session_id: SessionId.make(session.id),
							agent_id: agent.id,
							agent_version: 1,
							environment_id: env.id,
							turn: 2,
							generation: 0,
							input: ["x".repeat(MAX_MESSAGE_TEXT_LENGTH)],
						}),
					)
					expect(staleErr).toMatchObject({
						_tag: "ModelProviderError",
						error_type: "session_history_unavailable",
						terminal: false,
					})
					expect(modelCalls).toBe(callsBefore)

					// Unprojected future turn 99 with a 16,384-char prompt also fails turn validation.
					const futureErr = yield* Effect.flip(
						provider.generate({
							session_id: SessionId.make(session.id),
							agent_id: agent.id,
							agent_version: 1,
							environment_id: env.id,
							turn: 99,
							generation: 0,
							input: ["x".repeat(MAX_MESSAGE_TEXT_LENGTH)],
						}),
					)
					expect(futureErr).toMatchObject({
						_tag: "ModelProviderError",
						error_type: "session_history_unavailable",
						terminal: false,
					})
					expect(modelCalls).toBe(callsBefore)

					// Valid current turn 4 with a 16,384-char prompt (seed budget = 0) passes turn validation
					// and succeeds with an empty seed.
					yield* sendAndSettle(apiFetch, session.id, ["x".repeat(MAX_MESSAGE_TEXT_LENGTH)], 4)
					expect(modelCalls).toBe(callsBefore + 1)
				}).pipe(Effect.scoped, Effect.provide(fastLookupLayer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("reallocates pair seed budget for trailing multi-byte code points instead of dropping the newest exchange", async () => {
		const { layer, closeAll, requests, forgetPiState } = makePiDurableTestLayer(
			async (model, context) => {
				const last = extractLastUserText(context)
				if (last.endsWith("🚀")) {
					return makeAssistantReply(model, null, "abcdef", 5, 2)
				}
				return makeAssistantReply(model, null, "ok", 5, 2)
			},
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					// Size system + currentInput on gpt-4 (8,192 window, 2,048 reserve -> 6,144 available)
					// so exactly 22 bytes remain for the seed: 16 bytes for pair overhead + 6 bytes for text!
					// A 50/50 split gives 3 + 3 bytes and would drop the 4-byte trailing emoji `🚀`.
					const system = "s".repeat(4_000) // 4,000 + 8 = 4,008
					const currentInput = "c".repeat(2_106) // 2,106 + 8 = 2,114 -> total 6,122 -> 22 remaining -> 6 pair bytes!
					expect(
						seedTokenBudget({ contextWindow: 8_192, system, currentInput }) -
							2 * SEED_MESSAGE_OVERHEAD_TOKENS,
					).toBe(6)

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Tight Budget Agent", model: "gpt-4", system },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }
					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					yield* sendAndSettle(apiFetch, session.id, ["hi🚀"], 1)
					yield* Effect.promise(() => forgetPiState(conversationName(session.id, 0)))

					yield* sendAndSettle(apiFetch, session.id, [currentInput], 2)
					expect(requests.at(-1)?.seed?.messages).toEqual([
						{ role: "user", text: "🚀" },
						{ role: "assistant", text: "ef" },
					])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("replays a settled Pi turn before checking mutable policy, API key, or view prerequisites", async () => {
		let modelCalls = 0
		const backends = new Map<string, ReturnType<typeof createInMemoryPiDurableBackend>>()
		const models = makeScriptedPiModels(async (model, context) => {
			modelCalls += 1
			return makeAssistantReply(model, null, `Saved:${extractLastUserText(context)}`, 11, 5)
		})
		const getBackend = (conversation: string) => {
			let backend = backends.get(conversation)
			if (backend === undefined) {
				backend = createInMemoryPiDurableBackend(models)
				backends.set(conversation, backend)
			}
			return backend
		}
		const executorLayer = makePiTurnExecutorLayer({
			recoverTurn: (conversation, operationId) =>
				!backends.has(conversation)
					? Effect.succeed(null)
					: Effect.promise(async (signal) =>
							recoverPiDurableTurn(await getBackend(conversation), operationId, signal),
						),
			runTurn: (conversation, request) =>
				Effect.promise(async (signal) =>
					runPiDurableTurn(await getBackend(conversation), request, signal),
				),
			abortTurn: (conversation, operationId) =>
				Effect.promise(async () => {
					if (backends.has(conversation)) {
						await (await getBackend(conversation)).abort(operationId)
					}
				}),
		})

		let breakViews = false
		const BrokenVersionView = Layer.effect(
			AgentVersionByNumberView,
			Effect.map(AgentVersionByNumberView, (real) => ({
				...real,
				waitFor: (key, predicate, options) =>
					breakViews
						? Effect.fail(new Domain.WaitTimeout({ view: "AgentVersionByNumberView", key }))
						: real.waitFor(key, predicate, options),
			})),
		)
		const BrokenEnvView = Layer.effect(
			EnvironmentView,
			Effect.map(EnvironmentView, (real) => ({
				...real,
				get: (ref, options) =>
					breakViews
						? Effect.fail(
								new Domain.ConsistencyTimeout({
									view: "EnvironmentView",
									key: ref.id,
									stream: `Environment/${ref.id}`,
									version: 2,
								}),
							)
						: real.get(ref, options),
				waitFor: (ref, predicate, options) =>
					breakViews
						? Effect.fail(new Domain.WaitTimeout({ view: "EnvironmentView", key: ref.id }))
						: real.waitFor(ref, predicate, options),
			})),
		)

		const CheckfuLive = Checkfu.layer(
			SessionsHandlersLive.pipe(Layer.provide(PiDurableModelProviderLive)),
		).pipe(Layer.provide(executorLayer))
		const PiProviderLive = PiDurableModelProviderLive.pipe(
			Layer.provide(executorLayer),
			Layer.provide(CheckfuLive),
		)
		const layer = Layer.mergeAll(CheckfuLive, PiProviderLive).pipe(
			Layer.provide(Layer.succeed(AgentVersionLookupTimeout, "40 millis")),
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
			Layer.provideMerge(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						CHECKFU_API_KEY: TEST_API_KEY,
						OPENAI_API_KEY: "sk-openai-test",
					}),
				),
			),
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const provider = yield* ModelProvider

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Replay Agent", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Replay Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					// 1. Turn 1 runs and settles inside Pi.
					const initialReply = yield* provider.generate({
						session_id: SessionId.make(session.id),
						agent_id: agent.id,
						agent_version: 1,
						environment_id: env.id,
						turn: 1,
						generation: 0,
						input: ["before restart"],
					})
					expect(initialReply).toMatchObject({
						text: "Saved:before restart",
						input_tokens: 11,
						output_tokens: 5,
					})
					expect(modelCalls).toBe(1)

					// 2. Now tighten the environment to block OpenAI, delete/break views, and build a
					//    restarted provider with NO OPENAI_API_KEY configured.
					const tightenRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${env.id}`,
						headers: AUTH_HEADERS,
						body: {
							version: 1,
							config: {
								type: "cloud",
								networking: {
									type: "limited",
									allow_mcp_servers: false,
									allow_package_managers: false,
									allowed_hosts: ["api.anthropic.com"],
								},
							},
						},
					})
					expect(tightenRes.status).toBe(200)

					const restartedProviderLayer = Layer.fresh(PiDurableModelProviderLive).pipe(
						Layer.provide(BrokenVersionView),
						Layer.provide(BrokenEnvView),
						Layer.provide(executorLayer),
						Layer.provide(Layer.succeed(AgentVersionLookupTimeout, "40 millis")),
						Layer.provide(
							Layer.succeed(HarnessLimits, {
								attempts: 2,
								baseDelayMs: 1,
								interruptTimeoutMs: 50,
								settleMarginMs: 50,
							}),
						),
						Layer.provide(
							ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_API_KEY: TEST_API_KEY })),
						),
					)

					// 3. Replaying turn 1 recovers Pi's saved reply even with broken views, blocked
					//    environment policy, and missing OPENAI_API_KEY (and makes 0 new model calls).
					breakViews = true
					const replayed = yield* ModelProvider.pipe(
						Effect.flatMap((restarted) =>
							restarted.generate({
								session_id: SessionId.make(session.id),
								agent_id: agent.id,
								agent_version: 1,
								environment_id: env.id,
								turn: 1,
								generation: 0,
								input: ["before restart"],
							}),
						),
						Effect.provide(restartedProviderLayer),
					)
					expect(replayed).toEqual(initialReply)
					expect(modelCalls).toBe(1)

					// 4. An unsubmitted turn 2 on the same restarted provider hits the broken view,
					//    then (once views recover) enforces the tightened environment policy, and
					//    (once the environment allows OpenAI again) hits missing_api_key_error —
					//    proving every prerequisite check was genuinely bypassed ONLY by turn 1 replay.
					const brokenViewTurn2 = yield* Effect.flip(
						ModelProvider.pipe(
							Effect.flatMap((restarted) =>
								restarted.generate({
									session_id: SessionId.make(session.id),
									agent_id: agent.id,
									agent_version: 1,
									environment_id: env.id,
									turn: 2,
									generation: 0,
									input: ["unsubmitted while views broken"],
								}),
							),
							Effect.provide(restartedProviderLayer),
						),
					)
					expect(providerError(brokenViewTurn2).error_type).toBe("agent_version_not_found")

					breakViews = false
					const blockedTurn2 = yield* Effect.flip(
						ModelProvider.pipe(
							Effect.flatMap((restarted) =>
								restarted.generate({
									session_id: SessionId.make(session.id),
									agent_id: agent.id,
									agent_version: 1,
									environment_id: env.id,
									turn: 2,
									generation: 0,
									input: ["new turn after tighten"],
								}),
							),
							Effect.provide(restartedProviderLayer),
						),
					)
					expect(providerError(blockedTurn2).error_type).toBe("environment_network_blocked")

					const reopenRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${env.id}`,
						headers: AUTH_HEADERS,
						body: {
							version: 2,
							config: { type: "cloud", networking: { type: "unrestricted" } },
						},
					})
					expect(reopenRes.status).toBe(200)
					const missingKeyTurn2 = yield* Effect.flip(
						ModelProvider.pipe(
							Effect.flatMap((restarted) =>
								restarted.generate({
									session_id: SessionId.make(session.id),
									agent_id: agent.id,
									agent_version: 1,
									environment_id: env.id,
									turn: 2,
									generation: 0,
									input: ["new turn without api key"],
								}),
							),
							Effect.provide(restartedProviderLayer),
						),
					)
					expect(providerError(missingKeyTurn2).error_type).toBe("missing_api_key_error")
					expect(modelCalls).toBe(1)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			for (const b of backends.values()) {
				await (await b).close()
			}
		}
	})
})
