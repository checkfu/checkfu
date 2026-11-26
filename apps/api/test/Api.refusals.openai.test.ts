import * as Domain from "@alchemy.run/domain"
import { ArtifactBytesKept } from "@checkfu/domain/Artifact/ArtifactBytes.external"
import { SessionOutputsUnpublished } from "@checkfu/domain/Session/SessionOutputs.external"
import { Harness } from "@checkfu/domain/Session/Harness.external"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { createRegistry } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import { makeApiHandler } from "../src/Http/Router.ts"
import { recoverPiDurableTurn, runPiDurableTurn } from "../src/Pi/PiDurableEngine.ts"
import type { PiTurnOutcome } from "../src/Pi/PiTurn.ts"
import {
	AgentVersionLookupTimeout,
	PiDurableHarnessLive,
	makePiTurnExecutorLayer,
} from "../src/Pi/PiDurableHarness.ts"
import { createPiModels } from "../src/Pi/PiModels.ts"
import { DEFAULT_REFUSAL_TEXT, PROVIDER_FAILURE_MESSAGE } from "../src/Pi/PiRefusals.ts"
import {
	AUTH_HEADERS,
	TEST_API_KEY,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	makeScriptedPiModels,
	providerError,
	readSseUntil,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { makeArtifactStoreMemory } from "../src/Artifacts/ArtifactStoreMemory.ts"
import { ArtifactLinksTest } from "../src/Content/ArtifactLinks.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

describe("Provider refusals and OpenAI Responses codec", () => {
	it("preserves provider refusals without draining queued prompts and keeps the session alive after a provider error", async () => {
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

					yield* Effect.sleep("80 millis")
					const getARes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessA.id}`,
						headers: AUTH_HEADERS,
					})
					const getA = (yield* Effect.promise(() => getARes.json())) as { status: string }
					expect(getA.status).toBe("idle")
					expect(refusalModelCalls).toBe(1)

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
		globalThis.fetch = async () => {
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
		}

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
					: Effect.flatMap(
							Effect.promise(() => getBackend(sessionId)),
							(backend) => recoverPiDurableTurn(backend, operationId),
						),
			runTurn: (sessionId, request) =>
				Effect.flatMap(
					Effect.promise(() => getBackend(sessionId)),
					(backend) => runPiDurableTurn(backend, request),
				),
			abortTurn: (sessionId, operationId) =>
				Effect.suspend(() => {
					const b = backends.get(sessionId)
					return b === undefined
						? Effect.void
						: Effect.flatMap(
								Effect.promise(() => b),
								(backend) => Effect.asVoid(backend.abort(operationId)),
							)
				}),
		})

		const CheckfuLive = Checkfu.layer(
			CheckfuHandlersLive.pipe(
				Layer.provide(ArtifactBytesKept),
				Layer.provide(SessionOutputsUnpublished),
				Layer.provide(ListingStore.memory),
				Layer.provide(PiDurableHarnessLive),
			),
		).pipe(Layer.provide(executorLayer))
		const layer = CheckfuLive.pipe(
			Layer.provide(Domain.InMemory),
			Layer.provideMerge(makeArtifactStoreMemory().layer),
			Layer.provideMerge(ArtifactLinksTest),
			Layer.provideMerge(Digest.layerWebCrypto),
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
		const originalFetch = globalThis.fetch
		globalThis.fetch = async () => {
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
		}

		const realOpenAIModels = createPiModels({
			openai: Redacted.make("sk-openai-test"),
			anthropic: null,
		})
		const partialBackend = await createInMemoryPiDurableBackend(realOpenAIModels)
		try {
			const outcome = await Effect.runPromise(
				runPiDurableTurn(partialBackend, {
					operationId: "turn:1",
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "trigger-partial-refusal-disconnect",
				}),
			)
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

		const { layer: baseLayer, closeAll } = makePiDurableTestLayer(async (model, context) =>
			makeAssistantReply(model, null, `Reply ${extractLastUserText(context)}`, 5, 3),
		)
		const fastLookupLayer = Layer.succeed(AgentVersionLookupTimeout, "60 millis").pipe(
			Layer.provideMerge(baseLayer),
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const provider = yield* Harness

					const missingVersionErr = yield* Effect.flip(
						provider.runTurn({
							session_id: SessionId.make("sess_lagging_agent"),
							agent_id: "agent_not_projected_yet",
							agent_version: 1,
							environment_id: "env_1",
							turn: 1,
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
		globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
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
		}

		const realModels = createPiModels({
			openai: Redacted.make("sk-openai-test"),
			anthropic: null,
		})
		const backend = await createInMemoryPiDurableBackend(realModels)
		try {
			const turn1 = await Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:1",
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "Please do disallowed thing",
				}),
			)
			expect(turn1).toMatchObject({
				ok: true,
				reply: {
					text: "The model refused to complete the request.",
					stop_reason: { type: "refusal" },
				},
			})

			const turn2 = await Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:2",
					turn: 2,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "Why did you refuse?",
				}),
			)
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
		globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
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
		}

		const backend = await createInMemoryPiDurableBackend(realModels)
		try {
			const turn1 = await Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:1",
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "trigger incomplete content_filter then sse error",
				}),
			)
			expect(turn1).toMatchObject({
				ok: false,
				error: {
					error_type: "model_request_failed_error",
					message: PROVIDER_FAILURE_MESSAGE,
					terminal: false,
				},
			})

			const turn2 = await Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:2",
					turn: 2,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "next clean prompt",
				}),
			)
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

		globalThis.fetch = async () =>
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
			)
		const backend2 = await createInMemoryPiDurableBackend(realModels)
		try {
			const cleanRefusal = await Effect.runPromise(
				runPiDurableTurn(backend2, {
					operationId: "turn:1",
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "trigger clean incomplete content_filter",
				}),
			)
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
		let turnResponses = 0
		globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
			responseSeq += 1
			const rawBody = typeof init?.body === "string" ? init.body : ""
			if (rawBody.includes("<conversation>")) {
				compactionCalls += 1
				compactionInputs.push(rawBody)
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
			turnResponses += 1
			const reportedInput = turnResponses === 2 ? 115_000 : Math.ceil(rawBody.length / 4)
			return new Response(
				makeOpenAITextResponse(`resp_turn_${responseSeq}`, "r".repeat(40_000), reportedInput, 1500),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			)
		}

		const realModels = createPiModels({
			openai: Redacted.make("sk-openai-test"),
			anthropic: null,
		})
		const backend = await createInMemoryPiDurableBackend(realModels)
		try {
			let failedTurn: PiTurnOutcome | undefined
			for (let turn = 1; turn <= 4; turn++) {
				const result = await Effect.runPromise(
					runPiDurableTurn(backend, {
						operationId: `turn:${turn}`,
						turn,
						provider: "openai",
						modelId: "gpt-4o-mini",
						system: null,
						text: `preserved-turn-${turn}: ${"u".repeat(40_000)}`,
					}),
				)
				if (!result.ok) {
					failedTurn = result
					break
				}
			}
			expect(compactionCalls).toBe(1)
			expect(failedTurn).toMatchObject({
				ok: false,
				error: {
					error_type: "model_request_failed_error",
					message: PROVIDER_FAILURE_MESSAGE,
					terminal: false,
				},
			})

			const recovered = await Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:5",
					turn: 5,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: `recovery-turn: ${"u".repeat(40_000)}`,
				}),
			)
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

		const filteredSentBodies: Array<unknown> = []
		globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
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
		}

		const filterBackend = await createInMemoryPiDurableBackend(realModels)
		try {
			const turn1 = await Effect.runPromise(
				runPiDurableTurn(filterBackend, {
					operationId: "turn:1",
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "trigger-partial-content-filter",
				}),
			)
			expect(turn1).toMatchObject({
				ok: true,
				reply: {
					thinking: null,
					text: DEFAULT_REFUSAL_TEXT,
					stop_reason: { type: "refusal" },
				},
			})

			const turn2 = await Effect.runPromise(
				runPiDurableTurn(filterBackend, {
					operationId: "turn:2",
					turn: 2,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "next safe question",
				}),
			)
			expect(turn2).toMatchObject({ ok: true, reply: { text: "Safe follow-up" } })
			const turn2Payload = JSON.stringify(filteredSentBodies.at(-1))
			expect(turn2Payload).toContain(DEFAULT_REFUSAL_TEXT)
			expect(turn2Payload).not.toContain("Response incomplete: content_filter")
			expect(turn2Payload).not.toContain("PARTIAL_FILTERED_LEAK_SHOULD_NOT_PUBLISH")
		} finally {
			globalThis.fetch = originalFetch
			await filterBackend.close()
		}

		const mixedSentBodies: Array<unknown> = []
		globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
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
		}

		const mixedBackend = await createInMemoryPiDurableBackend(realModels)
		try {
			const turn1 = await Effect.runPromise(
				runPiDurableTurn(mixedBackend, {
					operationId: "turn:1",
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "trigger-mixed-refusal",
				}),
			)
			expect(turn1).toMatchObject({
				ok: true,
				reply: {
					thinking: null,
					text: "I cannot assist with that.",
					stop_reason: { type: "refusal" },
				},
			})

			const turn2 = await Effect.runPromise(
				runPiDurableTurn(mixedBackend, {
					operationId: "turn:2",
					turn: 2,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "follow-up",
				}),
			)
			expect(turn2).toMatchObject({ ok: true, reply: { text: "Next answer" } })
			const turn2Payload = JSON.stringify(mixedSentBodies.at(-1))
			expect(turn2Payload).toContain("I cannot assist with that.")
			expect(turn2Payload).not.toContain("MIXED_PREAMBLE_LEAK")
		} finally {
			globalThis.fetch = originalFetch
			await mixedBackend.close()
		}
	})

	it("keeps provider errorMessage out of session events for all three OpenAI refusal fallback paths", async () => {
		const secretDetail = "secret upstream detail"
		const warnCalls: Array<ReadonlyArray<unknown>> = []
		const originalWarn = console.warn
		console.warn = (...args: ReadonlyArray<unknown>) => {
			warnCalls.push(args)
		}

		const closeables: Array<() => Promise<void>> = []

		try {
			const normalizedHarness = makePiDurableTestLayer(async (model, context) => {
				const text = extractLastUserText(context)
				return {
					...makeAssistantReply(model, null, "", 12, 4),
					content: [],
					stopReason: "error",
					rawStopReason: text === "filter" ? "incomplete.content_filter" : "refusal",
					errorMessage: secretDetail,
				}
			})
			closeables.push(normalizedHarness.closeAll)

			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "OpenAI Fallback 1", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env 1" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					for (const prompt of ["refusal", "filter"]) {
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
								events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
							},
						})
						const frames = yield* Effect.promise(() =>
							readSseUntil(streamRes, (evt) => evt.type === "session.status_idle"),
						)
						const listedRes = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/sessions/${session.id}/events`,
							headers: AUTH_HEADERS,
						})
						const listed = (yield* Effect.promise(() => listedRes.json())) as {
							data: ReadonlyArray<{ type: string; content?: unknown; stop_reason?: unknown }>
						}
						expect(listed.data.find((e) => e.type === "agent.message")?.content).toEqual([
							{ type: "text", text: DEFAULT_REFUSAL_TEXT },
						])
						expect(listed.data.at(-1)).toMatchObject({
							type: "session.status_idle",
							stop_reason: { type: "refusal" },
						})
						expect(JSON.stringify(frames)).not.toContain(secretDetail)
						expect(JSON.stringify(listed.data)).not.toContain(secretDetail)
					}
				}).pipe(Effect.scoped, Effect.provide(normalizedHarness.layer)),
			)
			expect(warnCalls).toContainEqual([
				"pi refusal fallback",
				{ provider: "openai", model: "gpt-4o-mini", rawStopReason: "refusal" },
			])
			expect(warnCalls).toContainEqual([
				"pi refusal fallback",
				{ provider: "openai", model: "gpt-4o-mini", rawStopReason: "incomplete.content_filter" },
			])
			expect(JSON.stringify(warnCalls)).not.toContain(secretDetail)

			warnCalls.length = 0
			let compactionCalls = 0
			let normalTurns = 0
			const compactionHarness = makePiDurableTestLayer(async (model, context) => {
				const lastText = extractLastUserText(context)
				if (lastText.startsWith("<conversation>")) {
					compactionCalls += 1
					return {
						...makeAssistantReply(model, null, "", 200, 12),
						content: [],
						stopReason: "stop",
						rawStopReason: "refusal",
						errorMessage: secretDetail,
					}
				}
				normalTurns += 1
				return makeAssistantReply(
					model,
					null,
					"r".repeat(40_000),
					normalTurns === 2 ? 115_000 : 2000,
					1500,
				)
			})
			closeables.push(compactionHarness.closeAll)

			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "OpenAI Fallback 2", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env 2" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }
					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					for (let turn = 1; turn <= 2; turn++) {
						const part = "u".repeat(14_000)
						yield* sendAndSettle(apiFetch, session.id, [`turn-${turn}:${part}`, part, part], turn)
					}
					yield* sendAndSettle(apiFetch, session.id, ["trigger-compaction-refusal"], 3)

					const listedRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
					})
					const listed = (yield* Effect.promise(() => listedRes.json())) as {
						data: ReadonlyArray<{ type: string; error?: { message: string } }>
					}
					expect(compactionCalls).toBe(1)
					expect(listed.data.find((e) => e.type === "session.error")?.error?.message).toBe(
						PROVIDER_FAILURE_MESSAGE,
					)
					expect(JSON.stringify(listed.data)).not.toContain(secretDetail)
				}).pipe(Effect.scoped, Effect.provide(compactionHarness.layer)),
			)
			expect(JSON.stringify(warnCalls)).not.toContain(secretDetail)

			warnCalls.length = 0
			const unnormalizedBackends = new Map<
				string,
				Promise<Awaited<ReturnType<typeof createInMemoryPiDurableBackend>>>
			>()
			const getUnnormalizedBackend = (conversation: string) => {
				let existing = unnormalizedBackends.get(conversation)
				if (existing === undefined) {
					existing = createInMemoryPiDurableBackend(
						makeScriptedPiModels(async (model) => ({
							...makeAssistantReply(model, null, "", 10, 2),
							content: [],
							stopReason: "stop",
							rawStopReason: "refusal",
							errorMessage: secretDetail,
						})),
						1,
						createRegistry(),
					)
					unnormalizedBackends.set(conversation, existing)
				}
				return existing
			}
			closeables.push(async () => {
				for (const backend of unnormalizedBackends.values()) {
					await (await backend).close()
				}
			})
			const unnormalizedExecutor = makePiTurnExecutorLayer({
				recoverTurn: (conversation, operationId) =>
					!unnormalizedBackends.has(conversation)
						? Effect.succeed(null)
						: Effect.flatMap(
								Effect.promise(() => getUnnormalizedBackend(conversation)),
								(backend) => recoverPiDurableTurn(backend, operationId),
							),
				runTurn: (conversation, request) =>
					Effect.flatMap(
						Effect.promise(() => getUnnormalizedBackend(conversation)),
						(backend) => runPiDurableTurn(backend, request),
					),
				abortTurn: (conversation, operationId) =>
					Effect.suspend(() => {
						const backend = unnormalizedBackends.get(conversation)
						return backend === undefined
							? Effect.void
							: Effect.flatMap(
									Effect.promise(() => backend),
									(resolved) => Effect.asVoid(resolved.abort(operationId)),
								)
					}),
			})
			const unnormalizedLayer = Checkfu.layer(
				CheckfuHandlersLive.pipe(
					Layer.provide(ArtifactBytesKept),
					Layer.provide(SessionOutputsUnpublished),
					Layer.provide(ListingStore.memory),
					Layer.provide(PiDurableHarnessLive),
				),
			).pipe(
				Layer.provide(unnormalizedExecutor),
				Layer.provide(Domain.InMemory),
				Layer.provideMerge(makeArtifactStoreMemory().layer),
				Layer.provideMerge(ArtifactLinksTest),
				Layer.provideMerge(Digest.layerWebCrypto),
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

			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "OpenAI Fallback 3", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env 3" },
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
							events: [{ type: "user.message", content: [{ type: "text", text: "refuse-stop" }] }],
						},
					})
					const frames = yield* Effect.promise(() =>
						readSseUntil(streamRes, (evt) => evt.type === "session.status_idle"),
					)
					const listedRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
					})
					const listed = (yield* Effect.promise(() => listedRes.json())) as {
						data: ReadonlyArray<{ type: string; content?: unknown; stop_reason?: unknown }>
					}
					expect(listed.data.find((e) => e.type === "agent.message")?.content).toEqual([
						{ type: "text", text: DEFAULT_REFUSAL_TEXT },
					])
					expect(listed.data.at(-1)).toMatchObject({
						type: "session.status_idle",
						stop_reason: { type: "refusal" },
					})
					expect(JSON.stringify(frames)).not.toContain(secretDetail)
					expect(JSON.stringify(listed.data)).not.toContain(secretDetail)
				}).pipe(Effect.scoped, Effect.provide(unnormalizedLayer)),
			)
			expect(warnCalls).toContainEqual([
				"pi refusal fallback",
				{ provider: "openai", model: "gpt-4o-mini", rawStopReason: "refusal" },
			])
			expect(JSON.stringify(warnCalls)).not.toContain(secretDetail)
		} finally {
			console.warn = originalWarn
			for (const close of closeables) {
				await close()
			}
		}
	})
})
