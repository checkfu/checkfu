import * as Domain from "@alchemy.run/domain"
import { ArtifactBytesKept } from "@checkfu/domain/Artifact/ArtifactBytes.external"
import { SessionOutputsUnpublished } from "@checkfu/domain/Session/SessionOutputs.external"
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry"
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
import {
	HarnessLimits,
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
	readSseUntil,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { makeArtifactStoreMemory } from "../src/Artifacts/ArtifactStoreMemory.ts"
import { ArtifactLinksTest } from "../src/Content/ArtifactLinks.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

describe("Anthropic Messages refusals and stream errors", () => {
	it("keeps a published Anthropic refusal in the next turn's model context through the real Messages codec", async () => {
		let fetchCalls = 0
		const sentRequests: Array<{
			readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
		}> = []
		let turn1StartedResolve: (() => void) | undefined
		const turn1Started = new Promise<void>((resolve) => {
			turn1StartedResolve = resolve
		})
		let releaseTurn1: (() => void) | undefined
		const turn1Gate = new Promise<void>((resolve) => {
			releaseTurn1 = resolve
		})

		const originalFetch = globalThis.fetch
		globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
			fetchCalls += 1
			if (typeof init?.body === "string") {
				sentRequests.push(
					JSON.parse(init.body) as {
						readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
					},
				)
			}
			if (fetchCalls === 1) {
				turn1StartedResolve?.()
				await turn1Gate
				const refusalSse = [
					`event: message_start\ndata: ${JSON.stringify({
						type: "message_start",
						message: {
							id: "msg_refusal_1",
							type: "message",
							role: "assistant",
							model: "claude-sonnet-4-6",
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: {
								input_tokens: 14,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					})}\n\n`,
					`event: message_delta\ndata: ${JSON.stringify({
						type: "message_delta",
						delta: {
							stop_reason: "refusal",
							stop_sequence: null,
							stop_details: { explanation: "Safety policy refusal." },
						},
						usage: { input_tokens: 14, output_tokens: 5 },
					})}\n\n`,
					`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
				].join("")
				return new Response(refusalSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})
			}

			const turn2Sse = [
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_turn_2",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-6",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 30,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
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
					delta: { type: "text_delta", text: "Acknowledged." },
				})}\n\n`,
				`event: content_block_stop\ndata: ${JSON.stringify({
					type: "content_block_stop",
					index: 0,
				})}\n\n`,
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { input_tokens: 30, output_tokens: 4 },
				})}\n\n`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
			].join("")
			return new Response(turn2Sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}

		const realAnthropicModels = createPiModels({
			openai: null,
			anthropic: Redacted.make("sk-ant-test"),
		})
		const backends = new Map<
			string,
			Promise<Awaited<ReturnType<typeof createInMemoryPiDurableBackend>>>
		>()
		const getBackend = (sessionId: string) => {
			let existing = backends.get(sessionId)
			if (existing === undefined) {
				existing = createInMemoryPiDurableBackend(realAnthropicModels)
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
						ANTHROPIC_API_KEY: "sk-ant-test",
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
						body: { name: "Anthropic Refusal Context", model: "claude-sonnet-4-6" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Anthropic Env" },
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
							events: [
								{ type: "user.message", content: [{ type: "text", text: "disallowed request" }] },
							],
						},
					})
					yield* Effect.promise(() => turn1Started)

					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "queued-before-idle" }] },
							],
						},
					})
					releaseTurn1?.()

					const turn1Frames = yield* Effect.promise(() =>
						readSseUntil(streamRes, (evt) => evt.type === "session.status_idle"),
					)
					expect(turn1Frames.find((f) => f.event === "agent.message")?.data.content).toEqual([
						{ type: "text", text: DEFAULT_REFUSAL_TEXT },
					])
					expect(JSON.stringify(turn1Frames)).not.toContain("Safety policy refusal.")
					expect(
						turn1Frames.find((f) => f.event === "session.status_idle")?.data.stop_reason,
					).toEqual({ type: "refusal" })
					expect(fetchCalls).toBe(1)

					const stream2Res = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: {
							...AUTH_HEADERS,
							"last-event-id": turn1Frames.at(-1)?.id ?? "0",
						},
					})
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "safe follow-up" }] },
							],
						},
					})
					const turn2Frames = yield* Effect.promise(() =>
						readSseUntil(stream2Res, (evt) => evt.type === "session.status_idle"),
					)
					expect(turn2Frames.find((f) => f.event === "agent.message")?.data.content).toEqual([
						{ type: "text", text: "Acknowledged." },
					])
					expect(fetchCalls).toBe(2)

					const turn2Messages = sentRequests[1]?.messages ?? []
					const assistantTurn1 = turn2Messages.find((m) => m.role === "assistant")
					expect(assistantTurn1).toBeDefined()
					expect(JSON.stringify(assistantTurn1?.content)).toContain(DEFAULT_REFUSAL_TEXT)
					expect(JSON.stringify(assistantTurn1?.content)).not.toContain("Safety policy refusal.")
					expect(turn2Messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			globalThis.fetch = originalFetch
			for (const b of backends.values()) {
				await (await b).close()
			}
		}
	})

	it("treats Anthropic's sensitive stop_reason as a refusal without draining queued messages", async () => {
		const originalFetch = globalThis.fetch
		let turn1StartedResolve: (() => void) | undefined
		const turn1Started = new Promise<void>((resolve) => {
			turn1StartedResolve = resolve
		})
		let releaseTurn1: (() => void) | undefined
		const turn1Gate = new Promise<void>((resolve) => {
			releaseTurn1 = resolve
		})
		let fetchCalls = 0
		const sentRequests: Array<{
			readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
		}> = []

		globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
			fetchCalls += 1
			if (typeof init?.body === "string") {
				sentRequests.push(JSON.parse(init.body))
			}
			if (fetchCalls === 1) {
				turn1StartedResolve?.()
				await turn1Gate
				const sensitiveSse = [
					`event: message_start\ndata: ${JSON.stringify({
						type: "message_start",
						message: {
							id: "msg_sensitive_1",
							type: "message",
							role: "assistant",
							model: "claude-sonnet-4-5",
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 10, output_tokens: 0 },
						},
					})}\n\n`,
					`event: message_delta\ndata: ${JSON.stringify({
						type: "message_delta",
						delta: { stop_reason: "sensitive", stop_sequence: null },
						usage: { output_tokens: 1 },
					})}\n\n`,
					`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
				].join("")
				return new Response(sensitiveSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})
			}
			const okSse = [
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_ok_2",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-5",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 20, output_tokens: 0 },
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
					delta: { type: "text_delta", text: "Handled safely." },
				})}\n\n`,
				`event: content_block_stop\ndata: ${JSON.stringify({
					type: "content_block_stop",
					index: 0,
				})}\n\n`,
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 3 },
				})}\n\n`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
			].join("")
			return new Response(okSse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}

		const realModels = createPiModels({
			openai: null,
			anthropic: Redacted.make("sk-ant-test"),
		})
		const backends = new Map<string, ReturnType<typeof createInMemoryPiDurableBackend>>()
		const getBackend = (conversation: string) => {
			let backend = backends.get(conversation)
			if (backend === undefined) {
				backend = createInMemoryPiDurableBackend(realModels)
				backends.set(conversation, backend)
			}
			return backend
		}
		const executorLayer = makePiTurnExecutorLayer({
			recoverTurn: (conversation, operationId) =>
				!backends.has(conversation)
					? Effect.succeed(null)
					: Effect.flatMap(
							Effect.promise(() => getBackend(conversation)),
							(backend) => recoverPiDurableTurn(backend, operationId),
						),
			runTurn: (conversation, request) =>
				Effect.flatMap(
					Effect.promise(() => getBackend(conversation)),
					(backend) => runPiDurableTurn(backend, request),
				),
			abortTurn: (conversation, operationId) =>
				Effect.flatMap(
					Effect.promise(() => getBackend(conversation)),
					(backend) => Effect.asVoid(backend.abort(operationId)),
				),
		})
		const CheckfuLive = Checkfu.layer(
			CheckfuHandlersLive.pipe(
				Layer.provide(ArtifactBytesKept),
				Layer.provide(SessionOutputsUnpublished),
				Layer.provide(ListingStore.memory),
				Layer.provide(PiDurableHarnessLive),
			),
		).pipe(Layer.provide(executorLayer))
		const PiProviderLive = PiDurableHarnessLive.pipe(
			Layer.provide(executorLayer),
			Layer.provide(CheckfuLive),
		)
		const layer = Layer.mergeAll(CheckfuLive, PiProviderLive).pipe(
			Layer.provideMerge(
				Layer.succeed(HarnessLimits, {
					attempts: 2,
					baseDelay: "1 millis",
					interruptTimeout: "50 millis",
					settleMargin: "50 millis",
				}),
			),
			Layer.provide(Domain.InMemory),
			Layer.provideMerge(makeArtifactStoreMemory().layer),
			Layer.provideMerge(ArtifactLinksTest),
			Layer.provideMerge(Digest.layerWebCrypto),
			Layer.provideMerge(SecureRandom.layerWebCrypto),
			Layer.provideMerge(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						CHECKFU_API_KEY: TEST_API_KEY,
						ANTHROPIC_API_KEY: "sk-ant-test",
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
						body: { name: "Claude Agent", model: "claude-sonnet-4-5" },
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

					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "sensitive prompt" }] },
							],
						},
					})
					yield* Effect.promise(() => turn1Started)
					const queuedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "queued follow-up" }] },
							],
						},
					})
					expect(queuedRes.status).toBe(200)
					releaseTurn1?.()

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
						if (body.status === "idle" && body.turn === 1) {
							break
						}
						yield* Effect.sleep("5 millis")
					}
					yield* Effect.sleep("40 millis")
					expect(fetchCalls).toBe(1)

					const listed = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
					})
					const events = (
						(yield* Effect.promise(() => listed.json())) as {
							data: ReadonlyArray<{ type: string; stop_reason?: { type: string } }>
						}
					).data
					expect(events.map((e) => e.type)).toContain("agent.message")
					expect(events.at(-1)).toMatchObject({
						type: "session.status_idle",
						stop_reason: { type: "refusal" },
					})

					yield* sendAndSettle(apiFetch, session.id, ["follow up after sensitive"], 2)
					expect(fetchCalls).toBe(2)
					const turn2Messages = sentRequests[1]?.messages ?? []
					expect(turn2Messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
					expect(JSON.stringify(turn2Messages[1]?.content)).toContain(DEFAULT_REFUSAL_TEXT)
					expect(JSON.stringify(turn2Messages[1]?.content)).not.toContain(
						"Provider stopped with: sensitive",
					)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			globalThis.fetch = originalFetch
			for (const b of backends.values()) {
				await (await b).close()
			}
		}
	})

	it("treats an Anthropic stream error after a sensitive or refusal delta as a provider error instead of a completed refusal", async () => {
		const originalFetch = globalThis.fetch
		const makeFailingStream = (stopReason: "sensitive" | "refusal", withErrorEvent: boolean) =>
			[
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_stream_fail",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-5",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				})}\n\n`,
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: stopReason, stop_sequence: null },
					usage: { output_tokens: 1 },
				})}\n\n`,
				...(withErrorEvent
					? [
							`event: error\ndata: ${JSON.stringify({
								type: "error",
								error: { type: "overloaded_error", message: "Overloaded" },
							})}\n\n`,
						]
					: []),
			].join("")

		const realModels = createPiModels({
			openai: null,
			anthropic: Redacted.make("sk-ant-test"),
		})

		globalThis.fetch = async () =>
			new Response(makeFailingStream("sensitive", true), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		const backend1 = await createInMemoryPiDurableBackend(realModels)
		try {
			const result = await Effect.runPromise(
				runPiDurableTurn(backend1, {
					operationId: "turn:1",
					turn: 1,
					provider: "anthropic",
					modelId: "claude-sonnet-4-5",
					system: null,
					text: "trigger sensitive then overloaded_error",
				}),
			)
			expect(result).toMatchObject({
				ok: false,
				error: {
					error_type: "model_request_failed_error",
					message: PROVIDER_FAILURE_MESSAGE,
					terminal: false,
				},
			})
		} finally {
			globalThis.fetch = originalFetch
			await backend1.close()
		}

		globalThis.fetch = async () =>
			new Response(makeFailingStream("refusal", false), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		const backend2 = await createInMemoryPiDurableBackend(realModels)
		try {
			const result = await Effect.runPromise(
				runPiDurableTurn(backend2, {
					operationId: "turn:1",
					turn: 1,
					provider: "anthropic",
					modelId: "claude-sonnet-4-5",
					system: null,
					text: "trigger refusal then disconnect",
				}),
			)
			expect(result).toMatchObject({
				ok: false,
				error: {
					error_type: "model_request_failed_error",
					message: PROVIDER_FAILURE_MESSAGE,
					terminal: false,
				},
			})
		} finally {
			globalThis.fetch = originalFetch
			await backend2.close()
		}

		const sentAfterPostStopError: Array<unknown> = []
		globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null
			sentAfterPostStopError.push(body)
			const isFailingTurn = JSON.stringify(body).includes("trigger post-stop overloaded_error")
			const sse = isFailingTurn
				? [
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								id: "msg_post_stop_err",
								type: "message",
								role: "assistant",
								model: "claude-sonnet-4-5",
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 10, output_tokens: 0 },
							},
						})}\n\n`,
						`event: message_delta\ndata: ${JSON.stringify({
							type: "message_delta",
							delta: { stop_reason: "sensitive", stop_sequence: null },
							usage: { output_tokens: 1 },
						})}\n\n`,
						`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
						`event: error\ndata: ${JSON.stringify({
							type: "error",
							error: { type: "overloaded_error", message: "Overloaded after message_stop" },
						})}\n\n`,
					].join("")
				: [
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								id: "msg_clean_followup",
								type: "message",
								role: "assistant",
								model: "claude-sonnet-4-5",
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 8, output_tokens: 0 },
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
							delta: { type: "text_delta", text: "Clean reply" },
						})}\n\n`,
						`event: content_block_stop\ndata: ${JSON.stringify({
							type: "content_block_stop",
							index: 0,
						})}\n\n`,
						`event: message_delta\ndata: ${JSON.stringify({
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 3 },
						})}\n\n`,
						`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
					].join("")
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		}
		const backend3 = await createInMemoryPiDurableBackend(realModels)
		try {
			const result1 = await Effect.runPromise(
				runPiDurableTurn(backend3, {
					operationId: "turn:1",
					turn: 1,
					provider: "anthropic",
					modelId: "claude-sonnet-4-5",
					system: null,
					text: "trigger post-stop overloaded_error",
				}),
			)
			expect(result1).toMatchObject({
				ok: false,
				error: {
					error_type: "model_request_failed_error",
					message: PROVIDER_FAILURE_MESSAGE,
					terminal: false,
				},
			})

			const result2 = await Effect.runPromise(
				runPiDurableTurn(backend3, {
					operationId: "turn:2",
					turn: 2,
					provider: "anthropic",
					modelId: "claude-sonnet-4-5",
					system: null,
					text: "fresh prompt",
				}),
			)
			expect(result2).toMatchObject({ ok: true, reply: { text: "Clean reply" } })
			const lastRequest = sentAfterPostStopError.at(-1)
			expect(JSON.stringify(lastRequest)).not.toContain("Overloaded after message_stop")
			expect(JSON.stringify(lastRequest)).not.toContain("trigger post-stop overloaded_error")
		} finally {
			globalThis.fetch = originalFetch
			await backend3.close()
		}
	})

	it("keeps unconfirmed Anthropic stop_reasons like content_filter or case-mismatched REFUSAL on the error path", async () => {
		const originalFetch = globalThis.fetch
		const realModels = createPiModels({
			openai: null,
			anthropic: Redacted.make("sk-ant-test"),
		})

		for (const unconfirmedStopReason of [
			"content_filter",
			"REFUSAL",
			"SENSITIVE",
			"incomplete.content_filter",
		]) {
			const sentRequests: Array<unknown> = []
			globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null
				sentRequests.push(body)
				const isFailingTurn = JSON.stringify(body).includes(`trigger:${unconfirmedStopReason}`)
				const sse = isFailingTurn
					? [
							`event: message_start\ndata: ${JSON.stringify({
								type: "message_start",
								message: {
									id: `msg_${unconfirmedStopReason}`,
									type: "message",
									role: "assistant",
									model: "claude-sonnet-4-5",
									content: [],
									stop_reason: null,
									stop_sequence: null,
									usage: { input_tokens: 10, output_tokens: 0 },
								},
							})}\n\n`,
							`event: message_delta\ndata: ${JSON.stringify({
								type: "message_delta",
								delta: { stop_reason: unconfirmedStopReason, stop_sequence: null },
								usage: { output_tokens: 1 },
							})}\n\n`,
							`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
						].join("")
					: [
							`event: message_start\ndata: ${JSON.stringify({
								type: "message_start",
								message: {
									id: "msg_clean",
									type: "message",
									role: "assistant",
									model: "claude-sonnet-4-5",
									content: [],
									stop_reason: null,
									stop_sequence: null,
									usage: { input_tokens: 8, output_tokens: 0 },
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
								delta: { type: "text_delta", text: "Clean follow-up" },
							})}\n\n`,
							`event: content_block_stop\ndata: ${JSON.stringify({
								type: "content_block_stop",
								index: 0,
							})}\n\n`,
							`event: message_delta\ndata: ${JSON.stringify({
								type: "message_delta",
								delta: { stop_reason: "end_turn", stop_sequence: null },
								usage: { output_tokens: 3 },
							})}\n\n`,
							`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
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
						provider: "anthropic",
						modelId: "claude-sonnet-4-5",
						system: null,
						text: `trigger:${unconfirmedStopReason}`,
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
						provider: "anthropic",
						modelId: "claude-sonnet-4-5",
						system: null,
						text: "clean next turn",
					}),
				)
				expect(turn2).toMatchObject({ ok: true, reply: { text: "Clean follow-up" } })
				const lastRequest = JSON.stringify(sentRequests.at(-1))
				expect(lastRequest).not.toContain("Unhandled stop reason")
				expect(lastRequest).not.toContain(`trigger:${unconfirmedStopReason}`)
			} finally {
				globalThis.fetch = originalFetch
				await backend.close()
			}
		}
	})

	it.each(["Request blocked: timeout policy", "Provider stopped with: sensitive"])(
		"hands Pi a refusal without Anthropic's explanation %j, so a compaction neither stores nor retries it",
		async (explanation) => {
			const originalFetch = globalThis.fetch
			globalThis.fetch = async () =>
				new Response(
					[
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								id: "msg_compaction_refusal",
								type: "message",
								role: "assistant",
								model: "claude-sonnet-4-6",
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 10, output_tokens: 0 },
							},
						})}\n\n`,
						`event: message_delta\ndata: ${JSON.stringify({
							type: "message_delta",
							delta: { stop_reason: "refusal", stop_sequence: null, stop_details: { explanation } },
							usage: { input_tokens: 10, output_tokens: 2 },
						})}\n\n`,
						`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
					].join(""),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)
			try {
				const models = createPiModels({ openai: null, anthropic: Redacted.make("sk-ant-test") })
				const model = models.getModel("anthropic", "claude-sonnet-4-6")
				if (model === undefined) {
					throw new Error("expected claude-sonnet-4-6")
				}
				const summary = await models.completeSimple(model, {
					messages: [{ role: "user", content: "summarize", timestamp: 0 }],
				})
				expect(summary).toMatchObject({ stopReason: "error", rawStopReason: "refusal" })
				expect(summary.errorMessage).toBe("The model refused to complete the request")
				expect(JSON.stringify(summary)).not.toContain(explanation)
				expect(isRetryableAssistantError(summary)).toBe(false)
			} finally {
				globalThis.fetch = originalFetch
			}
		},
	)

	it("keeps provider errorMessage out of session events for all three Anthropic refusal fallback paths", async () => {
		const secretDetail = "secret upstream detail"
		const warnCalls: Array<ReadonlyArray<unknown>> = []
		const originalWarn = console.warn
		console.warn = (...args: ReadonlyArray<unknown>) => {
			warnCalls.push(args)
		}

		const originalFetch = globalThis.fetch
		const closeables: Array<() => Promise<void>> = []

		try {
			const realModels = createPiModels({
				openai: null,
				anthropic: Redacted.make("sk-ant-test"),
			})
			globalThis.fetch = async () =>
				new Response(
					[
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								id: "msg_secret_refusal",
								type: "message",
								role: "assistant",
								model: "claude-sonnet-4-6",
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 10, output_tokens: 0 },
							},
						})}\n\n`,
						`event: message_delta\ndata: ${JSON.stringify({
							type: "message_delta",
							delta: {
								stop_reason: "refusal",
								stop_sequence: null,
								stop_details: { explanation: secretDetail },
							},
							usage: { input_tokens: 10, output_tokens: 2 },
						})}\n\n`,
						`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
					].join(""),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)

			const normalizedBackends = new Map<
				string,
				Promise<Awaited<ReturnType<typeof createInMemoryPiDurableBackend>>>
			>()
			const getNormalizedBackend = (conversation: string) => {
				let existing = normalizedBackends.get(conversation)
				if (existing === undefined) {
					existing = createInMemoryPiDurableBackend(realModels)
					normalizedBackends.set(conversation, existing)
				}
				return existing
			}
			closeables.push(async () => {
				for (const backend of normalizedBackends.values()) {
					await (await backend).close()
				}
			})
			const normalizedExecutor = makePiTurnExecutorLayer({
				recoverTurn: (conversation, operationId) =>
					!normalizedBackends.has(conversation)
						? Effect.succeed(null)
						: Effect.flatMap(
								Effect.promise(() => getNormalizedBackend(conversation)),
								(backend) => recoverPiDurableTurn(backend, operationId),
							),
				runTurn: (conversation, request) =>
					Effect.flatMap(
						Effect.promise(() => getNormalizedBackend(conversation)),
						(backend) => runPiDurableTurn(backend, request),
					),
				abortTurn: (conversation, operationId) =>
					Effect.suspend(() => {
						const backend = normalizedBackends.get(conversation)
						return backend === undefined
							? Effect.void
							: Effect.flatMap(
									Effect.promise(() => backend),
									(resolved) => Effect.asVoid(resolved.abort(operationId)),
								)
					}),
			})
			const normalizedLayer = Checkfu.layer(
				CheckfuHandlersLive.pipe(
					Layer.provide(ArtifactBytesKept),
					Layer.provide(SessionOutputsUnpublished),
					Layer.provide(ListingStore.memory),
					Layer.provide(PiDurableHarnessLive),
				),
			).pipe(
				Layer.provide(normalizedExecutor),
				Layer.provide(Domain.InMemory),
				Layer.provideMerge(makeArtifactStoreMemory().layer),
				Layer.provideMerge(ArtifactLinksTest),
				Layer.provideMerge(Digest.layerWebCrypto),
				Layer.provideMerge(SecureRandom.layerWebCrypto),
				Layer.provideMerge(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							CHECKFU_API_KEY: TEST_API_KEY,
							ANTHROPIC_API_KEY: "sk-ant-test",
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
						body: { name: "Anthropic Fallback 1", model: "claude-sonnet-4-6" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env 1" },
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
				}).pipe(Effect.scoped, Effect.provide(normalizedLayer)),
			)
			expect(warnCalls).toContainEqual([
				"pi refusal fallback",
				{ provider: "anthropic", model: "claude-sonnet-4-6", rawStopReason: "refusal" },
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
					"a".repeat(12_000),
					normalTurns === 4 ? 190_000 : 6000,
					3000,
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
						body: { name: "Anthropic Fallback 2", model: "claude-sonnet-4-5" },
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

					for (let turn = 1; turn <= 4; turn++) {
						yield* sendAndSettle(apiFetch, session.id, [`turn-${turn}:${"u".repeat(12_000)}`], turn)
					}
					yield* sendAndSettle(apiFetch, session.id, ["trigger-compaction-refusal"], 5)

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
							ANTHROPIC_API_KEY: "sk-ant-test",
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
						body: { name: "Anthropic Fallback 3", model: "claude-sonnet-4-6" },
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
				{ provider: "anthropic", model: "claude-sonnet-4-6", rawStopReason: "refusal" },
			])
			expect(JSON.stringify(warnCalls)).not.toContain(secretDetail)
		} finally {
			console.warn = originalWarn
			globalThis.fetch = originalFetch
			for (const close of closeables) {
				await close()
			}
		}
	})
})
