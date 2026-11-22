import * as Domain from "@alchemy.run/domain"
import { ModelProvider } from "@checkfu/sessions/Session/ModelProvider.external"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { SessionsHandlersLive } from "@checkfu/sessions/Sessions.model"
import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { Checkfu } from "../src/Checkfu.model.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { recoverPiDurableTurn, runPiDurableTurn } from "../src/Pi/PiDurableEngine.ts"
import {
	AgentVersionLookupTimeout,
	PiDurableModelProviderLive,
	makePiTurnExecutorLayer,
} from "../src/Pi/PiDurableModelProvider.ts"
import { createPiModels } from "../src/Pi/PiModels.ts"
import { PROVIDER_FAILURE_MESSAGE } from "../src/Pi/PiRefusals.ts"
import {
	AUTH_HEADERS,
	TEST_API_KEY,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	providerError,
	readSseUntil,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

describe("Provider refusals and OpenAI Responses codec", () => {
	it("preserves provider refusals without draining queued prompts and keeps the session alive after a provider error", async () => {
		// 2. End-to-end Anthropic refusal must NOT drain queued user prompts;
		//    and a rate-limit error mentioning "Requested 401 tokens" must NOT terminate the session.
		let turn1StartedResolve: (() => void) | undefined
		const turn1Started = new Promise<void>((resolve) => {
			turn1StartedResolve = resolve
		})
		let releaseTurn1: (() => void) | undefined
		const turn1Gate = new Promise<void>((resolve) => {
			releaseTurn1 = resolve
		})
		let refusalModelCalls = 0

		const { layer, closeAll } = makePiDurableTestLayer(async (model, context) => {
			const text = extractLastUserText(context)
			if (text === "trigger-refusal") {
				refusalModelCalls++
				turn1StartedResolve?.()
				await turn1Gate
				return {
					...makeAssistantReply(model, null, "", 12, 4),
					content: [],
					stopReason: "error",
					rawStopReason: "refusal",
					errorMessage: "The model refused to complete the request",
				}
			}
			if (text === "trigger-rate-limit-401") {
				return {
					...makeAssistantReply(model, null, "", 0, 0),
					stopReason: "error",
					errorMessage: "429 Rate limit exceeded: Requested 401 tokens",
				}
			}
			return makeAssistantReply(model, null, `OK: ${text}`, 8, 4)
		})

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					const anthropicAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Claude Safety", model: "claude-sonnet-4-6" },
					})
					const anthropicAgent = (yield* Effect.promise(() => anthropicAgentRes.json())) as {
						id: string
					}
					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Safety Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					// Session A: Anthropic refusal with a queued follow-up message
					const sessARes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: anthropicAgent.id, environment_id: env.id },
					})
					const sessA = (yield* Effect.promise(() => sessARes.json())) as { id: string }

					const streamA = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessA.id}/events/stream`,
						headers: AUTH_HEADERS,
					})

					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessA.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "trigger-refusal" }] },
							],
						},
					})
					yield* Effect.promise(() => turn1Started)

					// Queue a second user prompt while Turn 1 is running
					const queuedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessA.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									type: "user.message",
									content: [{ type: "text", text: "must-not-auto-drain" }],
								},
							],
						},
					})
					expect(queuedRes.status).toBe(200)

					releaseTurn1?.()

					const framesA = yield* Effect.promise(() =>
						readSseUntil(streamA, (evt) => evt.type === "session.status_idle"),
					)
					const idleFrameA = framesA.find((f) => f.event === "session.status_idle")
					expect(idleFrameA?.data.stop_reason).toEqual({ type: "refusal" })
					expect(framesA.some((f) => f.event === "session.error")).toBe(false)

					// Wait briefly and confirm queued prompt was NOT drained and session stays idle
					yield* Effect.sleep("80 millis")
					const getARes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessA.id}`,
						headers: AUTH_HEADERS,
					})
					const getA = (yield* Effect.promise(() => getARes.json())) as { status: string }
					expect(getA.status).toBe("idle")
					expect(refusalModelCalls).toBe(1)

					// Session B: Rate-limit error mentioning "Requested 401 tokens" must NOT terminate session
					const sessBRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: anthropicAgent.id, environment_id: env.id },
					})
					const sessB = (yield* Effect.promise(() => sessBRes.json())) as { id: string }
					const streamB = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessB.id}/events/stream`,
						headers: AUTH_HEADERS,
					})

					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessB.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									type: "user.message",
									content: [{ type: "text", text: "trigger-rate-limit-401" }],
								},
							],
						},
					})
					const framesB = yield* Effect.promise(() =>
						readSseUntil(streamB, (evt) => evt.type === "session.status_idle"),
					)
					const errFrameB = framesB.find((f) => f.event === "session.error")
					expect(errFrameB?.data.error).toMatchObject({
						type: "model_request_failed_error",
						retry_status: { type: "exhausted" },
					})

					// Session B is still active (idle, not terminated) and can complete another turn!
					const lastSeqB = framesB.at(-1)?.id
					const streamB2 = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessB.id}/events/stream`,
						headers: {
							...AUTH_HEADERS,
							...(lastSeqB === undefined ? {} : { "last-event-id": lastSeqB }),
						},
					})
					const followUpRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessB.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "after-429" }] }],
						},
					})
					expect(followUpRes.status).toBe(200)
					const framesB2 = yield* Effect.promise(() =>
						readSseUntil(streamB2, (evt) => evt.type === "agent.message"),
					)
					expect(framesB2.find((f) => f.event === "agent.message")?.data.content).toEqual([
						{ type: "text", text: "OK: after-429" },
					])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("preserves a completed OpenAI refusal without draining queued prompts through the real Responses codec", async () => {
		let fetchCalls = 0
		let requestStartedResolve: (() => void) | undefined
		const requestStarted = new Promise<void>((resolve) => {
			requestStartedResolve = resolve
		})
		let releaseResponse: (() => void) | undefined
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve
		})

		const originalFetch = globalThis.fetch
		globalThis.fetch = (async () => {
			fetchCalls += 1
			requestStartedResolve?.()
			await responseGate
			const sseFrames = [
				`event: response.created\ndata: ${JSON.stringify({
					type: "response.created",
					response: { id: "resp_refusal_1", status: "in_progress" },
				})}\n\n`,
				`event: response.output_item.added\ndata: ${JSON.stringify({
					type: "response.output_item.added",
					output_index: 0,
					item: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				})}\n\n`,
				`event: response.content_part.added\ndata: ${JSON.stringify({
					type: "response.content_part.added",
					output_index: 0,
					content_index: 0,
					part: { type: "refusal", refusal: "" },
				})}\n\n`,
				`event: response.refusal.delta\ndata: ${JSON.stringify({
					type: "response.refusal.delta",
					output_index: 0,
					content_index: 0,
					delta: "I cannot assist with that request.",
				})}\n\n`,
				`event: response.output_item.done\ndata: ${JSON.stringify({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "refusal", refusal: "I cannot assist with that request." }],
					},
				})}\n\n`,
				`event: response.completed\ndata: ${JSON.stringify({
					type: "response.completed",
					response: {
						id: "resp_refusal_1",
						status: "completed",
						output: [
							{
								id: "msg_1",
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "refusal", refusal: "I cannot assist with that request." }],
							},
						],
						usage: {
							input_tokens: 15,
							output_tokens: 7,
							total_tokens: 22,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}\n\n`,
			].join("")

			return new Response(sseFrames, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}) as unknown as typeof fetch

		const realOpenAIModels = createPiModels({
			openai: Redacted.make("sk-openai-test"),
			anthropic: null,
		})
		const backends = new Map<
			string,
			Promise<Awaited<ReturnType<typeof createInMemoryPiDurableBackend>>>
		>()
		const getBackend = (sessionId: string) => {
			let existing = backends.get(sessionId)
			if (existing === undefined) {
				existing = createInMemoryPiDurableBackend(realOpenAIModels)
				backends.set(sessionId, existing)
			}
			return existing
		}
		const executorLayer = makePiTurnExecutorLayer({
			recoverTurn: (sessionId, operationId) =>
				!backends.has(sessionId)
					? Effect.succeed(null)
					: Effect.promise(async (signal) =>
							recoverPiDurableTurn(await getBackend(sessionId), operationId, signal),
						),
			runTurn: (sessionId, request) =>
				Effect.promise(async (signal) =>
					runPiDurableTurn(await getBackend(sessionId), request, signal),
				),
			abortTurn: (sessionId, operationId) =>
				Effect.promise(async () => {
					const b = backends.get(sessionId)
					if (b !== undefined) await (await b).abort(operationId)
				}),
		})

		const CheckfuLive = Checkfu.layer(
			SessionsHandlersLive.pipe(Layer.provide(PiDurableModelProviderLive)),
		).pipe(Layer.provide(executorLayer))
		const layer = CheckfuLive.pipe(
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

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "OpenAI Refusal Test", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "OpenAI Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					const streamRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})

					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "refuse-me" }] }],
						},
					})
					yield* Effect.promise(() => requestStarted)

					// Queue a follow-up prompt while the OpenAI Responses request is in-flight
					const queuedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									type: "user.message",
									content: [{ type: "text", text: "queued-after-openai-refusal" }],
								},
							],
						},
					})
					expect(queuedRes.status).toBe(200)

					releaseResponse?.()

					const frames = yield* Effect.promise(() =>
						readSseUntil(streamRes, (evt) => evt.type === "session.status_idle"),
					)
					expect(frames.find((f) => f.event === "agent.message")?.data.content).toEqual([
						{ type: "text", text: "I cannot assist with that request." },
					])
					expect(frames.find((f) => f.event === "session.status_idle")?.data.stop_reason).toEqual({
						type: "refusal",
					})
					expect(frames.some((f) => f.event === "session.error")).toBe(false)

					// Give any unintended auto-drain a chance to fire; queued prompt must stay paused.
					yield* Effect.sleep("100 millis")
					expect(fetchCalls).toBe(1)
					const sessAfter = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}`,
						headers: AUTH_HEADERS,
					})
					const sessBody = (yield* Effect.promise(() => sessAfter.json())) as { status: string }
					expect(sessBody.status).toBe("idle")
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			globalThis.fetch = originalFetch
			for (const b of backends.values()) {
				await (await b).close()
			}
		}
	})

	it("preserves stream errors after a partial OpenAI refusal, and handles lagging version views non-terminally", async () => {
		// 1. Interrupted/errored OpenAI Responses stream after a partial refusal delta MUST fail (never commit as refusal)
		const originalFetch = globalThis.fetch
		globalThis.fetch = (async () => {
			// Stream sends a refusal delta and then terminates prematurely without `response.completed`
			const partialRefusalSse = [
				`event: response.created\ndata: ${JSON.stringify({
					type: "response.created",
					response: { id: "resp_partial_refusal", status: "in_progress" },
				})}\n\n`,
				`event: response.output_item.added\ndata: ${JSON.stringify({
					type: "response.output_item.added",
					output_index: 0,
					item: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				})}\n\n`,
				`event: response.content_part.added\ndata: ${JSON.stringify({
					type: "response.content_part.added",
					output_index: 0,
					content_index: 0,
					part: { type: "refusal", refusal: "" },
				})}\n\n`,
				`event: response.refusal.delta\ndata: ${JSON.stringify({
					type: "response.refusal.delta",
					output_index: 0,
					content_index: 0,
					delta: "I cannot",
				})}\n\n`,
			].join("")
			return new Response(partialRefusalSse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}) as unknown as typeof fetch

		const realOpenAIModels = createPiModels({
			openai: Redacted.make("sk-openai-test"),
			anthropic: null,
		})
		const partialBackend = await createInMemoryPiDurableBackend(realOpenAIModels)
		try {
			const outcome = await runPiDurableTurn(partialBackend, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "trigger-partial-refusal-disconnect",
			})
			expect(outcome).toMatchObject({
				ok: false,
				error: {
					error_type: "model_request_failed_error",
					terminal: false,
				},
			})
		} finally {
			globalThis.fetch = originalFetch
			await partialBackend.close()
		}

		// 2. Lagging AgentVersionByNumberView + missing version -> non-terminal (never terminates session)
		const { layer: baseLayer, closeAll } = makePiDurableTestLayer(async (model, context) =>
			makeAssistantReply(model, null, `Reply ${extractLastUserText(context)}`, 5, 3),
		)
		const fastLookupLayer = Layer.succeed(AgentVersionLookupTimeout, "60 millis").pipe(
			Layer.provideMerge(baseLayer),
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const provider = yield* ModelProvider

					// Missing/lagging version lookup must fail NON-TERMINALLY so lagging views never kill a valid session
					const missingVersionErr = yield* Effect.flip(
						provider.generate({
							session_id: SessionId.make("sess_lagging_agent"),
							agent_id: "agent_not_projected_yet",
							agent_version: 1,
							environment_id: "env_1",
							turn: 1,
							generation: 0,
							input: ["Hello"],
						}),
					)
					expect(providerError(missingVersionErr).error_type).toBe("agent_version_not_found")
					expect(providerError(missingVersionErr).terminal).toBe(false)
				}).pipe(Effect.provide(fastLookupLayer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("persists fallback refusal text into Pi context for completed textless OpenAI refusals", async () => {
		const originalFetch = globalThis.fetch
		const sentInputs: Array<unknown> = []
		let callCount = 0
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			callCount += 1
			if (typeof init?.body === "string") {
				sentInputs.push(JSON.parse(init.body))
			}
			const sse =
				callCount === 1
					? [
							`event: response.created\ndata: ${JSON.stringify({
								type: "response.created",
								response: { id: "resp_empty_refusal", status: "in_progress" },
							})}\n\n`,
							`event: response.output_item.added\ndata: ${JSON.stringify({
								type: "response.output_item.added",
								output_index: 0,
								item: {
									id: "msg_1",
									type: "message",
									role: "assistant",
									status: "in_progress",
									content: [],
								},
							})}\n\n`,
							`event: response.content_part.added\ndata: ${JSON.stringify({
								type: "response.content_part.added",
								output_index: 0,
								content_index: 0,
								part: { type: "refusal", refusal: "" },
							})}\n\n`,
							`event: response.output_item.done\ndata: ${JSON.stringify({
								type: "response.output_item.done",
								output_index: 0,
								item: {
									id: "msg_1",
									type: "message",
									role: "assistant",
									status: "completed",
									content: [{ type: "refusal", refusal: "" }],
								},
							})}\n\n`,
							`event: response.completed\ndata: ${JSON.stringify({
								type: "response.completed",
								response: {
									id: "resp_empty_refusal",
									status: "completed",
									output: [
										{
											id: "msg_1",
											type: "message",
											role: "assistant",
											status: "completed",
											content: [{ type: "refusal", refusal: "" }],
										},
									],
									usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
								},
							})}\n\n`,
						].join("")
					: [
							`event: response.created\ndata: ${JSON.stringify({
								type: "response.created",
								response: { id: "resp_turn2", status: "in_progress" },
							})}\n\n`,
							`event: response.output_item.added\ndata: ${JSON.stringify({
								type: "response.output_item.added",
								output_index: 0,
								item: {
									id: "msg_2",
									type: "message",
									role: "assistant",
									status: "in_progress",
									content: [],
								},
							})}\n\n`,
							`event: response.content_part.added\ndata: ${JSON.stringify({
								type: "response.content_part.added",
								output_index: 0,
								content_index: 0,
								part: { type: "output_text", text: "" },
							})}\n\n`,
							`event: response.output_text.delta\ndata: ${JSON.stringify({
								type: "response.output_text.delta",
								output_index: 0,
								content_index: 0,
								delta: "Follow-up answer",
							})}\n\n`,
							`event: response.output_item.done\ndata: ${JSON.stringify({
								type: "response.output_item.done",
								output_index: 0,
								item: {
									id: "msg_2",
									type: "message",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "Follow-up answer" }],
								},
							})}\n\n`,
							`event: response.completed\ndata: ${JSON.stringify({
								type: "response.completed",
								response: {
									id: "resp_turn2",
									status: "completed",
									output: [
										{
											id: "msg_2",
											type: "message",
											role: "assistant",
											status: "completed",
											content: [{ type: "output_text", text: "Follow-up answer" }],
										},
									],
									usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
								},
							})}\n\n`,
						].join("")
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}) as unknown as typeof fetch

		const realModels = createPiModels({
			openai: Redacted.make("sk-openai-test"),
			anthropic: null,
		})
		const backend = await createInMemoryPiDurableBackend(realModels)
		try {
			const turn1 = await runPiDurableTurn(backend, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "Please do disallowed thing",
			})
			expect(turn1).toMatchObject({
				ok: true,
				reply: {
					text: "The model refused to complete the request.",
					stop_reason: { type: "refusal" },
				},
			})

			const turn2 = await runPiDurableTurn(backend, {
				operationId: "turn:2",
				turn: 2,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "Why did you refuse?",
			})
			expect(turn2).toMatchObject({ ok: true, reply: { text: "Follow-up answer" } })

			expect(sentInputs).toHaveLength(2)
			expect(JSON.stringify(sentInputs[1])).toContain("The model refused to complete the request.")
		} finally {
			globalThis.fetch = originalFetch
			await backend.close()
		}
	})

	it("keeps OpenAI stream errors after response.incomplete(content_filter) or refusal on the error path", async () => {
		const originalFetch = globalThis.fetch
		const realModels = createPiModels({
			openai: Redacted.make("sk-openai-test"),
			anthropic: null,
		})

		const sentBodies: Array<unknown> = []
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null
			sentBodies.push(body)
			const isFailingTurn = JSON.stringify(body).includes(
				"trigger incomplete content_filter then sse error",
			)
			const sse = isFailingTurn
				? [
						`event: response.created\ndata: ${JSON.stringify({
							type: "response.created",
							response: { id: "resp_incomplete_err", status: "in_progress", output: [] },
						})}\n\n`,
						`event: response.incomplete\ndata: ${JSON.stringify({
							type: "response.incomplete",
							response: {
								id: "resp_incomplete_err",
								status: "incomplete",
								incomplete_details: { reason: "content_filter" },
								output: [],
								usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
							},
						})}\n\n`,
						`event: error\ndata: ${JSON.stringify({
							type: "error",
							code: "server_error",
							message: "Upstream stream failed after incomplete",
						})}\n\n`,
					].join("")
				: [
						`event: response.created\ndata: ${JSON.stringify({
							type: "response.created",
							response: { id: "resp_clean_2", status: "in_progress", output: [] },
						})}\n\n`,
						`event: response.output_item.added\ndata: ${JSON.stringify({
							type: "response.output_item.added",
							output_index: 0,
							item: { id: "msg_clean", type: "message", role: "assistant", content: [] },
						})}\n\n`,
						`event: response.content_part.added\ndata: ${JSON.stringify({
							type: "response.content_part.added",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "" },
						})}\n\n`,
						`event: response.output_text.delta\ndata: ${JSON.stringify({
							type: "response.output_text.delta",
							output_index: 0,
							content_index: 0,
							delta: "Clean OpenAI follow-up",
						})}\n\n`,
						`event: response.output_item.done\ndata: ${JSON.stringify({
							type: "response.output_item.done",
							output_index: 0,
							item: {
								id: "msg_clean",
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "Clean OpenAI follow-up" }],
							},
						})}\n\n`,
						`event: response.completed\ndata: ${JSON.stringify({
							type: "response.completed",
							response: {
								id: "resp_clean_2",
								status: "completed",
								output: [
									{
										id: "msg_clean",
										type: "message",
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: "Clean OpenAI follow-up" }],
									},
								],
								usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
							},
						})}\n\n`,
					].join("")
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}) as unknown as typeof fetch

		const backend = await createInMemoryPiDurableBackend(realModels)
		try {
			const turn1 = await runPiDurableTurn(backend, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "trigger incomplete content_filter then sse error",
			})
			expect(turn1).toMatchObject({
				ok: false,
				error: {
					error_type: "model_request_failed_error",
					message: PROVIDER_FAILURE_MESSAGE,
					terminal: false,
				},
			})

			const turn2 = await runPiDurableTurn(backend, {
				operationId: "turn:2",
				turn: 2,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "next clean prompt",
			})
			expect(turn2).toMatchObject({ ok: true, reply: { text: "Clean OpenAI follow-up" } })
			const lastRequest = sentBodies.at(-1)
			expect(JSON.stringify(lastRequest)).not.toContain("Upstream stream failed after incomplete")
			expect(JSON.stringify(lastRequest)).not.toContain(
				"trigger incomplete content_filter then sse error",
			)
		} finally {
			globalThis.fetch = originalFetch
			await backend.close()
		}

		// Clean response.incomplete(content_filter) without a trailing stream error still normalizes as a refusal.
		globalThis.fetch = (async () =>
			new Response(
				[
					`event: response.created\ndata: ${JSON.stringify({
						type: "response.created",
						response: { id: "resp_incomplete_ok", status: "in_progress", output: [] },
					})}\n\n`,
					`event: response.incomplete\ndata: ${JSON.stringify({
						type: "response.incomplete",
						response: {
							id: "resp_incomplete_ok",
							status: "incomplete",
							incomplete_details: { reason: "content_filter" },
							output: [],
							usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
						},
					})}\n\n`,
				].join(""),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			)) as unknown as typeof fetch
		const backend2 = await createInMemoryPiDurableBackend(realModels)
		try {
			const cleanRefusal = await runPiDurableTurn(backend2, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "trigger clean incomplete content_filter",
			})
			expect(cleanRefusal).toMatchObject({
				ok: true,
				reply: {
					stop_reason: { type: "refusal" },
				},
			})
		} finally {
			globalThis.fetch = originalFetch
			await backend2.close()
		}
	})

	it("rejects a completed OpenAI refusal during compaction instead of replacing conversation history with refusal text", async () => {
		const originalFetch = globalThis.fetch
		const refusalSummary = "I cannot summarize this conversation."
		let compactionCalls = 0
		const compactionInputs: Array<string> = []

		const makeOpenAITextResponse = (
			id: string,
			text: string,
			inputTokens: number,
			outputTokens: number,
		) =>
			[
				`event: response.created\ndata: ${JSON.stringify({
					type: "response.created",
					response: { id, status: "in_progress", output: [] },
				})}\n\n`,
				`event: response.output_item.added\ndata: ${JSON.stringify({
					type: "response.output_item.added",
					output_index: 0,
					item: { id: `${id}_msg`, type: "message", role: "assistant", content: [] },
				})}\n\n`,
				`event: response.content_part.added\ndata: ${JSON.stringify({
					type: "response.content_part.added",
					output_index: 0,
					content_index: 0,
					part: { type: "output_text", text: "" },
				})}\n\n`,
				`event: response.output_text.delta\ndata: ${JSON.stringify({
					type: "response.output_text.delta",
					output_index: 0,
					content_index: 0,
					delta: text,
				})}\n\n`,
				`event: response.output_item.done\ndata: ${JSON.stringify({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						id: `${id}_msg`,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text }],
					},
				})}\n\n`,
				`event: response.completed\ndata: ${JSON.stringify({
					type: "response.completed",
					response: {
						id,
						status: "completed",
						output: [
							{
								id: `${id}_msg`,
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text }],
							},
						],
						usage: {
							input_tokens: inputTokens,
							output_tokens: outputTokens,
							total_tokens: inputTokens + outputTokens,
						},
					},
				})}\n\n`,
			].join("")

		const makeOpenAIRefusalResponse = (id: string, text: string) =>
			[
				`event: response.created\ndata: ${JSON.stringify({
					type: "response.created",
					response: { id, status: "in_progress", output: [] },
				})}\n\n`,
				`event: response.output_item.added\ndata: ${JSON.stringify({
					type: "response.output_item.added",
					output_index: 0,
					item: { id: `${id}_msg`, type: "message", role: "assistant", content: [] },
				})}\n\n`,
				`event: response.content_part.added\ndata: ${JSON.stringify({
					type: "response.content_part.added",
					output_index: 0,
					content_index: 0,
					part: { type: "refusal", refusal: "" },
				})}\n\n`,
				`event: response.refusal.delta\ndata: ${JSON.stringify({
					type: "response.refusal.delta",
					output_index: 0,
					content_index: 0,
					delta: text,
				})}\n\n`,
				`event: response.output_item.done\ndata: ${JSON.stringify({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						id: `${id}_msg`,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "refusal", refusal: text }],
					},
				})}\n\n`,
				`event: response.completed\ndata: ${JSON.stringify({
					type: "response.completed",
					response: {
						id,
						status: "completed",
						output: [
							{
								id: `${id}_msg`,
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "refusal", refusal: text }],
							},
						],
						usage: { input_tokens: 200, output_tokens: 12, total_tokens: 212 },
					},
				})}\n\n`,
			].join("")

		let responseSeq = 0
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			responseSeq += 1
			const rawBody = typeof init?.body === "string" ? init.body : ""
			if (rawBody.includes("<conversation>")) {
				compactionCalls += 1
				compactionInputs.push(rawBody)
				// First compaction is refused by OpenAI; second succeeds so we can verify
				// the original turns survived intact instead of being replaced by the refusal.
				const sse =
					compactionCalls === 1
						? makeOpenAIRefusalResponse(`resp_compact_${responseSeq}`, refusalSummary)
						: makeOpenAITextResponse(
								`resp_compact_${responseSeq}`,
								"Real summary of preserved history.",
								200,
								20,
							)
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})
			}
			const estimatedInput = Math.ceil(rawBody.length / 4)
			return new Response(
				makeOpenAITextResponse(
					`resp_turn_${responseSeq}`,
					"r".repeat(6_000),
					estimatedInput,
					1_500,
				),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			)
		}) as unknown as typeof fetch

		const realModels = createPiModels({
			openai: Redacted.make("sk-openai-test"),
			anthropic: null,
		})
		const backend = await createInMemoryPiDurableBackend(realModels)
		try {
			// Run turns on gpt-4 (8,192 context window) until blocking compaction triggers.
			let failedTurn: Awaited<ReturnType<typeof runPiDurableTurn>> | undefined
			for (let turn = 1; turn <= 4; turn++) {
				const result = await runPiDurableTurn(backend, {
					operationId: `turn:${turn}`,
					turn,
					provider: "openai",
					modelId: "gpt-4",
					system: null,
					text: `preserved-turn-${turn}: ${"u".repeat(6_000)}`,
				})
				if (result !== "history_required" && !result.ok) {
					failedTurn = result
					break
				}
			}
			expect(compactionCalls).toBe(1)
			// The refused compaction must fail the turn instead of accepting the refusal as a summary.
			expect(failedTurn).toMatchObject({
				ok: false,
				error: {
					error_type: "model_request_failed_error",
					message: PROVIDER_FAILURE_MESSAGE,
					terminal: false,
				},
			})

			// On the next turn, compaction runs again over the original preserved history — NOT refusal text.
			const recovered = await runPiDurableTurn(backend, {
				operationId: "turn:5",
				turn: 5,
				provider: "openai",
				modelId: "gpt-4",
				system: null,
				text: `recovery-turn: ${"u".repeat(6_000)}`,
			})
			expect(recovered).toMatchObject({ ok: true })
			expect(compactionCalls).toBe(2)
			expect(compactionInputs[1]).toContain("preserved-turn-1")
			expect(compactionInputs[1]).not.toContain(refusalSummary)
		} finally {
			globalThis.fetch = originalFetch
			await backend.close()
		}
	})

	it("discards partial output when OpenAI stops with incomplete.content_filter or mixes output_text with a refusal part", async () => {
		const originalFetch = globalThis.fetch
		const realModels = createPiModels({
			openai: Redacted.make("sk-openai-test"),
			anthropic: null,
		})

		// 1. OpenAI emits ordinary text deltas then stops with response.incomplete(content_filter):
		//    partial text MUST be discarded from both the published reply and Turn 2's model context.
		const filteredSentBodies: Array<unknown> = []
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null
			filteredSentBodies.push(body)
			const serialized = JSON.stringify(body)
			const isFilteredTurn =
				serialized.includes("trigger-partial-content-filter") &&
				!serialized.includes("next safe question")
			const sse = isFilteredTurn
				? [
						`event: response.created\ndata: ${JSON.stringify({
							type: "response.created",
							response: { id: "resp_partial_filter", status: "in_progress", output: [] },
						})}\n\n`,
						`event: response.output_item.added\ndata: ${JSON.stringify({
							type: "response.output_item.added",
							output_index: 0,
							item: { id: "msg_pf", type: "message", role: "assistant", content: [] },
						})}\n\n`,
						`event: response.content_part.added\ndata: ${JSON.stringify({
							type: "response.content_part.added",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "" },
						})}\n\n`,
						`event: response.output_text.delta\ndata: ${JSON.stringify({
							type: "response.output_text.delta",
							output_index: 0,
							content_index: 0,
							delta: "PARTIAL_FILTERED_LEAK_SHOULD_NOT_PUBLISH",
						})}\n\n`,
						`event: response.incomplete\ndata: ${JSON.stringify({
							type: "response.incomplete",
							response: {
								id: "resp_partial_filter",
								status: "incomplete",
								incomplete_details: { reason: "content_filter" },
								output: [
									{
										id: "msg_pf",
										type: "message",
										role: "assistant",
										status: "incomplete",
										content: [
											{ type: "output_text", text: "PARTIAL_FILTERED_LEAK_SHOULD_NOT_PUBLISH" },
										],
									},
								],
								usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
							},
						})}\n\n`,
					].join("")
				: [
						`event: response.created\ndata: ${JSON.stringify({
							type: "response.created",
							response: { id: "resp_after_filter", status: "in_progress", output: [] },
						})}\n\n`,
						`event: response.output_item.added\ndata: ${JSON.stringify({
							type: "response.output_item.added",
							output_index: 0,
							item: { id: "msg_ok", type: "message", role: "assistant", content: [] },
						})}\n\n`,
						`event: response.content_part.added\ndata: ${JSON.stringify({
							type: "response.content_part.added",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "" },
						})}\n\n`,
						`event: response.output_text.delta\ndata: ${JSON.stringify({
							type: "response.output_text.delta",
							output_index: 0,
							content_index: 0,
							delta: "Safe follow-up",
						})}\n\n`,
						`event: response.output_item.done\ndata: ${JSON.stringify({
							type: "response.output_item.done",
							output_index: 0,
							item: {
								id: "msg_ok",
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "Safe follow-up" }],
							},
						})}\n\n`,
						`event: response.completed\ndata: ${JSON.stringify({
							type: "response.completed",
							response: {
								id: "resp_after_filter",
								status: "completed",
								output: [
									{
										id: "msg_ok",
										type: "message",
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: "Safe follow-up" }],
									},
								],
								usage: { input_tokens: 16, output_tokens: 4, total_tokens: 20 },
							},
						})}\n\n`,
					].join("")
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}) as unknown as typeof fetch

		const filterBackend = await createInMemoryPiDurableBackend(realModels)
		try {
			const turn1 = await runPiDurableTurn(filterBackend, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "trigger-partial-content-filter",
			})
			expect(turn1).toMatchObject({
				ok: true,
				reply: {
					thinking: null,
					text: "Response incomplete: content_filter",
					stop_reason: { type: "refusal" },
				},
			})

			const turn2 = await runPiDurableTurn(filterBackend, {
				operationId: "turn:2",
				turn: 2,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "next safe question",
			})
			expect(turn2).toMatchObject({ ok: true, reply: { text: "Safe follow-up" } })
			const turn2Payload = JSON.stringify(filteredSentBodies.at(-1))
			expect(turn2Payload).toContain("Response incomplete: content_filter")
			expect(turn2Payload).not.toContain("PARTIAL_FILTERED_LEAK_SHOULD_NOT_PUBLISH")
		} finally {
			globalThis.fetch = originalFetch
			await filterBackend.close()
		}

		// 2. OpenAI completed response mixing output_text and explicit refusal part:
		//    preserve ONLY the provider-authored refusal part text, discarding mixed output_text.
		const mixedSentBodies: Array<unknown> = []
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null
			mixedSentBodies.push(body)
			const serialized = JSON.stringify(body)
			const isMixedTurn =
				serialized.includes("trigger-mixed-refusal") && !serialized.includes("follow-up")
			const sse = isMixedTurn
				? [
						`event: response.created\ndata: ${JSON.stringify({
							type: "response.created",
							response: { id: "resp_mixed", status: "in_progress", output: [] },
						})}\n\n`,
						`event: response.output_item.added\ndata: ${JSON.stringify({
							type: "response.output_item.added",
							output_index: 0,
							item: { id: "msg_mix", type: "message", role: "assistant", content: [] },
						})}\n\n`,
						`event: response.content_part.added\ndata: ${JSON.stringify({
							type: "response.content_part.added",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "" },
						})}\n\n`,
						`event: response.output_text.delta\ndata: ${JSON.stringify({
							type: "response.output_text.delta",
							output_index: 0,
							content_index: 0,
							delta: "MIXED_PREAMBLE_LEAK",
						})}\n\n`,
						`event: response.output_item.done\ndata: ${JSON.stringify({
							type: "response.output_item.done",
							output_index: 0,
							item: {
								id: "msg_mix",
								type: "message",
								role: "assistant",
								status: "completed",
								content: [
									{ type: "output_text", text: "MIXED_PREAMBLE_LEAK" },
									{ type: "refusal", refusal: "I cannot assist with that." },
								],
							},
						})}\n\n`,
						`event: response.completed\ndata: ${JSON.stringify({
							type: "response.completed",
							response: {
								id: "resp_mixed",
								status: "completed",
								output: [
									{
										id: "msg_mix",
										type: "message",
										role: "assistant",
										status: "completed",
										content: [
											{ type: "output_text", text: "MIXED_PREAMBLE_LEAK" },
											{ type: "refusal", refusal: "I cannot assist with that." },
										],
									},
								],
								usage: { input_tokens: 14, output_tokens: 6, total_tokens: 20 },
							},
						})}\n\n`,
					].join("")
				: [
						`event: response.created\ndata: ${JSON.stringify({
							type: "response.created",
							response: { id: "resp_after_mixed", status: "in_progress", output: [] },
						})}\n\n`,
						`event: response.output_item.added\ndata: ${JSON.stringify({
							type: "response.output_item.added",
							output_index: 0,
							item: { id: "msg_ok2", type: "message", role: "assistant", content: [] },
						})}\n\n`,
						`event: response.content_part.added\ndata: ${JSON.stringify({
							type: "response.content_part.added",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "" },
						})}\n\n`,
						`event: response.output_text.delta\ndata: ${JSON.stringify({
							type: "response.output_text.delta",
							output_index: 0,
							content_index: 0,
							delta: "Next answer",
						})}\n\n`,
						`event: response.output_item.done\ndata: ${JSON.stringify({
							type: "response.output_item.done",
							output_index: 0,
							item: {
								id: "msg_ok2",
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "Next answer" }],
							},
						})}\n\n`,
						`event: response.completed\ndata: ${JSON.stringify({
							type: "response.completed",
							response: {
								id: "resp_after_mixed",
								status: "completed",
								output: [
									{
										id: "msg_ok2",
										type: "message",
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: "Next answer" }],
									},
								],
								usage: { input_tokens: 15, output_tokens: 3, total_tokens: 18 },
							},
						})}\n\n`,
					].join("")
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}) as unknown as typeof fetch

		const mixedBackend = await createInMemoryPiDurableBackend(realModels)
		try {
			const turn1 = await runPiDurableTurn(mixedBackend, {
				operationId: "turn:1",
				turn: 1,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "trigger-mixed-refusal",
			})
			expect(turn1).toMatchObject({
				ok: true,
				reply: {
					thinking: null,
					text: "I cannot assist with that.",
					stop_reason: { type: "refusal" },
				},
			})

			const turn2 = await runPiDurableTurn(mixedBackend, {
				operationId: "turn:2",
				turn: 2,
				provider: "openai",
				modelId: "gpt-4o-mini",
				system: null,
				text: "follow-up",
			})
			expect(turn2).toMatchObject({ ok: true, reply: { text: "Next answer" } })
			const turn2Payload = JSON.stringify(mixedSentBodies.at(-1))
			expect(turn2Payload).toContain("I cannot assist with that.")
			expect(turn2Payload).not.toContain("MIXED_PREAMBLE_LEAK")
		} finally {
			globalThis.fetch = originalFetch
			await mixedBackend.close()
		}
	})
})
