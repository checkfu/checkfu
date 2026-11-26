import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { ProviderRuntimeConfig, ProviderSpec } from "@checkfu/pi-providers/catalog"
import { buildPiProvider } from "@checkfu/pi-providers/runtime"
import { createProvider, hasApi } from "@earendil-works/pi-ai/models"
import { describe, expect, it, vi } from "@effect/vitest"
import * as Alchemy from "alchemy"
import * as Alchemist from "alchemy/Alchemist"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import {
	AbortGrace,
	abortPiDurableTurn,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../src/Pi/PiDurableEngine.ts"
import { PiHarnessWorker } from "../src/Pi/PiHarness.ts"
import {
	EnvPiProviderRuntimeLive,
	PiProviderRuntime,
	dynamicPiProviderRuntime,
	loadEnvPiProviderRuntime,
	staticPiProviderRuntime,
} from "../src/Pi/PiProviderRuntime.ts"
import { PiSession, PiSessionLive, makePiHarnessBackend } from "../src/Pi/PiSession.do.ts"
import type { PiTurnRequest } from "../src/Pi/PiTurn.ts"

const makeTurnRequest = (turn: number, provider = "openai"): PiTurnRequest => ({
	operationId: `turn:${turn}`,
	turn,
	provider,
	modelId: "gpt-4o-mini",
	system: null,
	text: "hello",
})

const makeSseCompletedBody = (text: string): string =>
	[
		`event: response.completed`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				output: [
					{
						type: "message",
						id: "msg_test",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text, annotations: [] }],
					},
				],
				usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
			},
		})}`,
		"",
		"",
	].join("\n")

const startCaptureResponsesServer = async () => {
	const authHeaders: Array<string | undefined> = []
	const server = createServer((req, res) => {
		authHeaders.push(req.headers.authorization)
		req.resume()
		req.on("end", () => {
			res.statusCode = 200
			res.setHeader("content-type", "text/event-stream; charset=utf-8")
			res.end(makeSseCompletedBody("ok"))
		})
	})
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve())
	})
	const address = server.address() as AddressInfo
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		authHeaders,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error !== undefined && error !== null) {
						reject(error)
					} else {
						resolve()
					}
				})
			}),
	}
}

describe("PiProviderRuntime", () => {
	it.effect("resolves static provider credentials and models without reading environment", () =>
		Effect.gen(function* () {
			const runtime = staticPiProviderRuntime({
				env: { OPENAI_API_KEY: "sk-static-test" },
			})
			const providers = yield* runtime.forSession({ sessionId: "sess_static" })
			expect(providers.checkCredentials("openai")).toEqual({ ok: true })
			expect(providers.checkCredentials("anthropic")).toMatchObject({ ok: false })
			const models = providers.createModels()
			expect(models.getModel("openai", "gpt-4o-mini")?.id).toBe("gpt-4o-mini")
			const auth = yield* Effect.promise(() => models.getAuth("openai"))
			expect(auth?.auth.apiKey).toBe("sk-static-test")
		}),
	)

	it.live("re-resolves dynamic provider credentials across requests on a warm session", () =>
		Effect.gen(function* () {
			const server = yield* Effect.acquireRelease(
				Effect.promise(() => startCaptureResponsesServer()),
				(running) => Effect.promise(() => running.close()),
			)
			let currentKey: string | undefined = "sk-rotated-v1"
			const seenContexts: Array<{ readonly sessionId: string; readonly provider?: string }> = []

			const runtime = dynamicPiProviderRuntime((context) => {
				seenContexts.push(context)
				const config: ProviderRuntimeConfig = {
					env: currentKey === undefined ? {} : { OPENAI_API_KEY: currentKey },
					baseUrlOverrides: { openai: server.baseUrl },
				}
				return Effect.succeed(config)
			})

			const providers = yield* runtime.forSession({ sessionId: "sess_warm_1" })
			const models = providers.createModels()
			const model = models.getModel("openai", "gpt-4o-mini")
			expect(model).toBeDefined()
			if (model === undefined) {
				return
			}

			expect(
				yield* Effect.promise(() => Promise.resolve(providers.checkCredentials("openai"))),
			).toEqual({
				ok: true,
			})

			const first = yield* Effect.promise(() =>
				models.completeSimple(model, {
					messages: [{ role: "user", content: "first", timestamp: 1_700_000_000_000 }],
				}),
			)
			expect(first.stopReason).toBe("stop")

			// Rotate key while the same Models instance stays warm in memory.
			currentKey = "sk-rotated-v2"
			const second = yield* Effect.promise(() =>
				models.completeSimple(model, {
					messages: [{ role: "user", content: "second", timestamp: 1_700_000_000_001 }],
				}),
			)
			expect(second.stopReason).toBe("stop")

			expect(server.authHeaders).toEqual(["Bearer sk-rotated-v1", "Bearer sk-rotated-v2"])
			expect(seenContexts).toContainEqual({ sessionId: "sess_warm_1", provider: "openai" })

			// Revoke key -> fails closed on credential check.
			currentKey = undefined
			expect(
				yield* Effect.promise(() => Promise.resolve(providers.checkCredentials("openai"))),
			).toMatchObject({ ok: false })
		}),
	)

	it.live(
		"rejects requests for models removed from a custom provider allowlist or with an incompatible API",
		() =>
			Effect.gen(function* () {
				const server = yield* Effect.acquireRelease(
					Effect.promise(() => startCaptureResponsesServer()),
					(running) => Effect.promise(() => running.close()),
				)
				const makeSpec = (
					format: "openai-responses" | "openai-completions",
					modelIds: ReadonlyArray<string>,
				): ProviderSpec => ({
					id: "acme",
					name: "Acme",
					source: "custom",
					defaultFormat: format,
					formats: [format],
					baseUrl: server.baseUrl,
					auth: { kind: "bearer", env: "ACME_API_KEY", label: "Acme API Key" },
					allowUnlistedModels: false,
					models: Object.fromEntries(modelIds.map((id) => [id, {}])),
				})

				let currentSpec = makeSpec("openai-responses", ["model-a", "model-b"])
				const runtime = dynamicPiProviderRuntime(() =>
					Effect.succeed({
						env: { ACME_API_KEY: "sk-acme-1" },
						customProviders: [currentSpec],
					}),
				)
				const providers = yield* runtime.forSession({ sessionId: "sess_allowlist" })
				const models = providers.createModels()
				const staleModelA = models.getModel("acme", "model-a")
				expect(staleModelA).toBeDefined()
				if (staleModelA === undefined || !hasApi(staleModelA, "openai-responses")) {
					return
				}

				// Remove model-a from the allowlist while acme remains configured.
				currentSpec = makeSpec("openai-responses", ["model-b"])
				const simpleRemoved = yield* Effect.promise(() =>
					models.completeSimple(staleModelA, {
						messages: [{ role: "user", content: "blocked", timestamp: 1_700_000_000_000 }],
					}),
				)
				expect(simpleRemoved.stopReason).toBe("error")
				expect(simpleRemoved.errorMessage).toContain("acme/model-a")

				const typedRemoved = yield* Effect.promise(() =>
					models.complete(staleModelA, {
						messages: [{ role: "user", content: "blocked", timestamp: 1_700_000_000_001 }],
					}),
				)
				expect(typedRemoved.stopReason).toBe("error")
				expect(typedRemoved.errorMessage).toContain("acme/model-a")

				const deferredHandle = {
					id: "handle_1",
					provider: "acme",
					modelId: "model-a",
					api: "openai-responses",
				} as const

				const deferredRemoved = yield* Effect.promise(() =>
					models.fetchDeferred(staleModelA, deferredHandle),
				)
				expect(deferredRemoved.stopReason).toBe("error")

				const cancelRemoved = yield* Effect.flip(
					Effect.tryPromise({
						try: () => models.cancelDeferred(staleModelA, deferredHandle),
						catch: String,
					}),
				)
				expect(cancelRemoved).toContain("acme/model-a")
				expect(yield* Effect.promise(() => models.getAuth(staleModelA))).toBeUndefined()

				// Re-add model-a on an incompatible API: typed stream/complete must reject it.
				currentSpec = makeSpec("openai-completions", ["model-a"])
				const incompatibleApi = yield* Effect.promise(() =>
					models.complete(staleModelA, {
						messages: [{ role: "user", content: "wrong-api", timestamp: 1_700_000_000_002 }],
					}),
				)
				expect(incompatibleApi.stopReason).toBe("error")
				expect(incompatibleApi.errorMessage).toContain("openai-completions")
				expect(server.authHeaders).toEqual([])
			}),
	)

	it.live(
		"refreshes synchronous model lookups on checkCredentials when a provider or model is added mid-session",
		() =>
			Effect.gen(function* () {
				const server = yield* Effect.acquireRelease(
					Effect.promise(() => startCaptureResponsesServer()),
					(running) => Effect.promise(() => running.close()),
				)
				let customProviders: ReadonlyArray<ProviderSpec> = []
				const runtime = dynamicPiProviderRuntime(() =>
					Effect.succeed({
						env: customProviders.length > 0 ? { ACME_API_KEY: "sk-acme-added" } : {},
						customProviders,
					}),
				)

				const providers = yield* runtime.forSession({ sessionId: "sess_added_mid" })
				const models = providers.createModels()
				expect(models.getModel("acme", "model-new")).toBeUndefined()

				customProviders = [
					{
						id: "acme",
						name: "Acme",
						source: "custom",
						defaultFormat: "openai-responses",
						formats: ["openai-responses"],
						baseUrl: server.baseUrl,
						auth: { kind: "bearer", env: "ACME_API_KEY", label: "Acme API Key" },
						allowUnlistedModels: false,
						models: { "model-new": {} },
					},
				]

				expect(
					yield* Effect.promise(() => Promise.resolve(providers.checkCredentials("acme"))),
				).toEqual({ ok: true })

				const addedModel = models.getModel("acme", "model-new")
				expect(addedModel).toBeDefined()
				if (addedModel === undefined) {
					return
				}

				// Newly opened registries (e.g. after storage reopen) also see the synced provider.
				expect(providers.createModels().getModel("acme", "model-new")?.id).toBe("model-new")

				const reply = yield* Effect.promise(() =>
					models.completeSimple(addedModel, {
						messages: [{ role: "user", content: "hello", timestamp: 1_700_000_000_000 }],
					}),
				)
				expect(reply.stopReason).toBe("stop")
				expect(server.authHeaders).toEqual(["Bearer sk-acme-added"])
			}),
	)

	it.live(
		"preserves setProvider, deleteProvider, and clearProviders across dynamic resolutions",
		() =>
			Effect.gen(function* () {
				const server = yield* Effect.acquireRelease(
					Effect.promise(() => startCaptureResponsesServer()),
					(running) => Effect.promise(() => running.close()),
				)
				const runtime = dynamicPiProviderRuntime(() =>
					Effect.succeed({
						env: { OPENAI_API_KEY: "sk-openai-live", ANTHROPIC_API_KEY: "sk-ant-live" },
						baseUrlOverrides: { openai: server.baseUrl },
					}),
				)

				const providers = yield* runtime.forSession({ sessionId: "sess_mutations" })
				const models = providers.createModels()
				const openaiModel = models.getModel("openai", "gpt-4o-mini")
				expect(openaiModel).toBeDefined()
				if (openaiModel === undefined) {
					return
				}

				models.deleteProvider("openai")
				expect(models.getProvider("openai")).toBeUndefined()
				expect(yield* Effect.promise(() => models.getAuth("openai"))).toBeUndefined()
				expect(yield* Effect.promise(() => models.checkAuth("openai"))).toBeUndefined()
				const deletedReply = yield* Effect.promise(() =>
					models.completeSimple(openaiModel, {
						messages: [{ role: "user", content: "deleted", timestamp: 1_700_000_000_000 }],
					}),
				)
				expect(deletedReply.stopReason).toBe("error")
				expect(server.authHeaders).toEqual([])

				// Even after checkCredentials syncs openai, the explicit deleteProvider stays honored.
				yield* Effect.promise(() => Promise.resolve(providers.checkCredentials("openai")))
				expect(models.getProvider("openai")).toBeUndefined()

				const overrideSpec: ProviderSpec = {
					id: "custom-override",
					name: "Custom Override",
					source: "custom",
					defaultFormat: "openai-responses",
					formats: ["openai-responses"],
					baseUrl: server.baseUrl,
					auth: { kind: "bearer", env: "CUSTOM_OVERRIDE_KEY", label: "Custom Override Key" },
					allowUnlistedModels: false,
					models: { "override-model": {} },
				}
				const overrideProvider = buildPiProvider(overrideSpec, {
					env: { CUSTOM_OVERRIDE_KEY: "sk-override-key" },
				})

				models.clearProviders()
				expect(models.getProviders()).toEqual([])
				expect(yield* Effect.promise(() => models.getAuth("anthropic"))).toBeUndefined()

				models.setProvider(overrideProvider)
				expect(models.getProviders().map((p) => p.id)).toEqual(["custom-override"])
				const overrideAuth = yield* Effect.promise(() => models.getAuth("custom-override"))
				expect(overrideAuth?.auth.headers?.Authorization).toBe("Bearer sk-override-key")
				expect(yield* Effect.promise(() => models.getAuth("anthropic"))).toBeUndefined()
			}),
	)

	it.live(
		"runs slow credential checks outside the session lock so abort does not reset the Durable Object",
		() =>
			Effect.gen(function* () {
				const cancelled = new Set<string>()
				const harnessAborts: Array<string> = []
				let resetCount = 0
				let ensureRootCalls = 0
				let submitCalls = 0

				let markCheckEntered!: () => void
				const checkEntered = new Promise<void>((resolve) => {
					markCheckEntered = resolve
				})
				let releaseCheck!: () => void
				const checkGate = new Promise<void>((resolve) => {
					releaseCheck = resolve
				})

				const backend = makePiHarnessBackend(
					{
						pi: async () => ({
							commit: async () => undefined,
						}),
						abort: async ({ operationId }: { readonly operationId: string }) => {
							harnessAborts.push(operationId)
						},
						root: async () => {
							ensureRootCalls += 1
						},
						submit: async () => {
							submitCalls += 1
						},
					} as unknown as Parameters<typeof makePiHarnessBackend>[0],
					{
						isCancelled: (operationId: string) => cancelled.has(operationId),
						markCancelled: (operationId: string) => {
							cancelled.add(operationId)
						},
					} as unknown as Parameters<typeof makePiHarnessBackend>[1],
					{},
					() => {
						resetCount += 1
					},
					() => Promise.resolve(true),
					{
						checkCredentials: async () => {
							markCheckEntered()
							await checkGate
							return { ok: true }
						},
					},
				)

				try {
					const turnFiber = yield* Effect.forkChild(
						runPiDurableTurn(backend, makeTurnRequest(1, "openai")),
						{ startImmediately: true },
					)
					yield* Effect.promise(() => checkEntered)

					const aborted = yield* abortPiDurableTurn(backend, "turn:1").pipe(
						Effect.provideService(AbortGrace, "30 millis"),
					)
					expect(aborted).toBe(true)
					expect(resetCount).toBe(0)
					expect(harnessAborts).toEqual(["turn:1"])

					releaseCheck()
					const outcome = yield* Fiber.join(turnFiber)
					expect(outcome).toEqual({ ok: false, error: { _tag: "TurnInterrupted" } })
					expect(ensureRootCalls).toBe(0)
					expect(submitCalls).toBe(0)
				} finally {
					releaseCheck()
				}
			}),
	)

	it.live("propagates stream AbortSignal into slow provider resolution", () =>
		Effect.gen(function* () {
			let interruptedCount = 0
			let allowResolve = true

			const runtime = dynamicPiProviderRuntime(({ provider }) => {
				if (allowResolve || provider === undefined) {
					return Effect.succeed({ env: { OPENAI_API_KEY: "sk-initial" } })
				}
				return Effect.never.pipe(
					Effect.onInterrupt(() =>
						Effect.sync(() => {
							interruptedCount += 1
						}),
					),
				)
			})

			const providers = yield* runtime.forSession({ sessionId: "sess_abort_stream" })
			const models = providers.createModels()
			const model = models.getModel("openai", "gpt-4o-mini")
			expect(model).toBeDefined()
			if (model === undefined || !hasApi(model, "openai-responses")) {
				return
			}

			allowResolve = false

			const abortAfterStart = async (
				run: (signal: AbortSignal) => Promise<{ readonly stopReason: string }>,
			) => {
				const controller = new AbortController()
				const pending = run(controller.signal)
				await new Promise<void>((resolve) => {
					setTimeout(() => {
						resolve()
					}, 10)
				})
				controller.abort()
				return pending
			}

			const simpleOutcome = yield* Effect.promise(() =>
				abortAfterStart((signal) =>
					models
						.streamSimple(
							model,
							{ messages: [{ role: "user", content: "hi", timestamp: 1_700_000_000_000 }] },
							{ signal },
						)
						.result(),
				),
			)
			expect(simpleOutcome.stopReason).toBe("aborted")

			const typedOutcome = yield* Effect.promise(() =>
				abortAfterStart((signal) =>
					models
						.stream(
							model,
							{ messages: [{ role: "user", content: "hi", timestamp: 1_700_000_000_001 }] },
							{ signal },
						)
						.result(),
				),
			)
			expect(typedOutcome.stopReason).toBe("aborted")

			const deferredOutcome = yield* Effect.promise(() =>
				abortAfterStart((signal) =>
					models
						.streamDeferred(
							model,
							{
								id: "handle_abort",
								provider: "openai",
								modelId: "gpt-4o-mini",
								api: "openai-responses",
							},
							{ signal },
						)
						.result(),
				),
			)
			expect(deferredOutcome.stopReason).toBe("aborted")
			expect(interruptedCount).toBe(3)
		}),
	)

	it.live(
		"prefers an existing submission over the cancellation fence after credential checks complete",
		() =>
			Effect.gen(function* () {
				const cancelled = new Set<string>()
				let submitted = false
				let markEntered!: () => void
				const entered = new Promise<void>((resolve) => {
					markEntered = resolve
				})
				let releaseCheck!: () => void
				const gate = new Promise<void>((resolve) => {
					releaseCheck = resolve
				})

				const assistantMessage = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "already submitted reply" }],
					api: "openai-responses" as const,
					provider: "openai",
					model: "gpt-4o-mini",
					usage: {
						input: 5,
						output: 3,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 8,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: 1_700_000_000_000,
				}

				const backend = makePiHarnessBackend(
					{
						pi: async () => ({
							commit: async <T>(fn: (tx: unknown) => T): Promise<T> =>
								fn({
									submissionByRequest: () =>
										submitted
											? {
													type: "input",
													status: "done",
													entry: 1,
													answer: 2,
												}
											: undefined,
									doc: async () => ({ operation: null }),
								}),
							snapshot: async () => ({ input_tokens: 5, output_tokens: 3 }),
							conversation: async () => ({
								entries: async () => ({
									items: [{ id: 2, model: [assistantMessage] }],
									next: undefined,
								}),
							}),
						}),
						wait: async () => ({ status: "done" as const }),
						abort: async () => undefined,
					} as unknown as Parameters<typeof makePiHarnessBackend>[0],
					{
						isCancelled: (operationId: string) => cancelled.has(operationId),
						markCancelled: (operationId: string) => {
							cancelled.add(operationId)
						},
					} as unknown as Parameters<typeof makePiHarnessBackend>[1],
					{},
					() => undefined,
					() => Promise.resolve(true),
					{
						checkCredentials: async () => {
							markEntered()
							await gate
							return { ok: true }
						},
					},
				)

				try {
					const turnFiber = yield* Effect.forkChild(
						runPiDurableTurn(backend, makeTurnRequest(1, "openai")),
						{ startImmediately: true },
					)
					yield* Effect.promise(() => entered)

					// Concurrent call submits and finishes while this call checks credentials, then abort marks fence.
					submitted = true
					cancelled.add("turn:1")
					releaseCheck()

					const outcome = yield* Fiber.join(turnFiber)
					expect(outcome).toMatchObject({
						ok: true,
						reply: { text: "already submitted reply" },
					})
				} finally {
					releaseCheck()
				}
			}),
	)

	it.live("releases discarded registries on reopen so they are no longer synced", () =>
		Effect.gen(function* () {
			let modelIds: ReadonlyArray<string> = ["model-v1"]
			const runtime = dynamicPiProviderRuntime(() =>
				Effect.succeed({
					env: { ACME_API_KEY: "sk-acme" },
					customProviders: [
						{
							id: "acme",
							name: "Acme",
							source: "custom",
							defaultFormat: "openai-responses",
							formats: ["openai-responses"],
							baseUrl: "https://acme.example/v1",
							auth: { kind: "bearer", env: "ACME_API_KEY", label: "Acme API Key" },
							allowUnlistedModels: false,
							models: Object.fromEntries(modelIds.map((id) => [id, {}])),
						},
					],
				}),
			)

			const providers = yield* runtime.forSession({ sessionId: "sess_reopen_release" })
			const discarded = providers.createModels()
			providers.releaseModels?.(discarded)
			const active = providers.createModels()

			modelIds = ["model-v1", "model-v2"]
			yield* Effect.promise(() => Promise.resolve(providers.checkCredentials("acme")))

			expect(active.getModel("acme", "model-v2")?.id).toBe("model-v2")
			expect(discarded.getModel("acme", "model-v2")).toBeUndefined()
		}),
	)

	it.live("preserves a lowered provider-specific minContextWindow in synchronous lookups", () =>
		Effect.gen(function* () {
			const spec: ProviderSpec = {
				id: "acme",
				name: "Acme",
				source: "custom",
				defaultFormat: "openai-responses",
				formats: ["openai-responses"],
				baseUrl: "https://acme.example/v1",
				auth: { kind: "bearer", env: "ACME_API_KEY", label: "Acme API Key" },
				allowUnlistedModels: false,
				models: {
					"small-16k": { contextWindow: 16_384 },
					"large-128k": { contextWindow: 128_000 },
				},
			}

			const runtime = dynamicPiProviderRuntime(({ provider }) =>
				Effect.succeed({
					env: { ACME_API_KEY: "sk-acme" },
					customProviders: [spec],
					minContextWindow: provider === "acme" ? 8192 : 65_536,
				}),
			)

			const providers = yield* runtime.forSession({ sessionId: "sess_ctx_floor" })
			const models = providers.createModels()
			expect(models.getModel("acme", "small-16k")).toBeUndefined()

			const available = yield* Effect.promise(() => models.getAvailable("acme"))
			expect(available.map((m) => m.id)).toContain("small-16k")
			expect(models.getModel("acme", "small-16k")?.id).toBe("small-16k")
			expect(models.getModels("acme").map((m) => m.id)).toContain("small-16k")
		}),
	)

	it.live("keeps interactive login credentials across dynamic rebuilds until logout", () =>
		Effect.gen(function* () {
			const runtime = dynamicPiProviderRuntime(() =>
				Effect.succeed({
					env: { OPENAI_API_KEY: "sk-fresh-every-call" },
				}),
			)
			const providers = yield* runtime.forSession({ sessionId: "sess_login_persist" })
			const models = providers.createModels()

			const interactiveProvider = createProvider({
				id: "interactive",
				name: "Interactive",
				models: [],
				api: {
					stream: () => {
						throw new Error("unused")
					},
					streamSimple: () => {
						throw new Error("unused")
					},
				},
				auth: {
					apiKey: {
						name: "Interactive Key",
						login: async () => ({ type: "api_key", key: "sk-logged-in-secret" }),
						resolve: async ({ credential }) =>
							credential?.type === "api_key" && credential.key !== undefined
								? { auth: { apiKey: credential.key }, source: "stored" }
								: undefined,
					},
				},
			})

			models.setProvider(interactiveProvider)
			expect(yield* Effect.promise(() => models.getAuth("interactive"))).toBeUndefined()

			yield* Effect.promise(() =>
				models.login("interactive", "api_key", {
					prompt: async () => "sk-logged-in-secret",
					notify: () => undefined,
				}),
			)

			const afterLogin = yield* Effect.promise(() => models.getAuth("interactive"))
			expect(afterLogin?.auth.apiKey).toBe("sk-logged-in-secret")

			yield* Effect.promise(() => models.logout("interactive"))
			expect(yield* Effect.promise(() => models.getAuth("interactive"))).toBeUndefined()
		}),
	)

	it.live(
		"prevents older concurrent resolutions from overwriting newer provider or full snapshots",
		() =>
			Effect.gen(function* () {
				const makeSpec = (modelIds: ReadonlyArray<string>): ProviderSpec => ({
					id: "acme",
					name: "Acme",
					source: "custom",
					defaultFormat: "openai-responses",
					formats: ["openai-responses"],
					baseUrl: "https://acme.example/v1",
					auth: { kind: "bearer", env: "ACME_API_KEY", label: "Acme API Key" },
					allowUnlistedModels: false,
					models: Object.fromEntries(modelIds.map((id) => [id, {}])),
				})

				let holdFullRefresh = false
				let markFullRefreshEntered!: () => void
				const fullRefreshEntered = new Promise<void>((resolve) => {
					markFullRefreshEntered = resolve
				})
				let releaseFullRefresh!: () => void
				const fullRefreshGate = new Promise<void>((resolve) => {
					releaseFullRefresh = resolve
				})

				let currentModels: ReadonlyArray<string> = ["model-old", "model-keep"]
				const runtime = dynamicPiProviderRuntime(({ provider }) => {
					const captured = [...currentModels]
					if (provider === undefined && holdFullRefresh) {
						return Effect.promise(async () => {
							markFullRefreshEntered()
							await fullRefreshGate
							return {
								env: { ACME_API_KEY: "sk-acme" },
								customProviders: [makeSpec(captured)],
							}
						})
					}
					return Effect.succeed({
						env: { ACME_API_KEY: "sk-acme" },
						customProviders: [makeSpec(captured)],
					})
				})

				const providers = yield* runtime.forSession({ sessionId: "sess_snapshot_order" })
				const models = providers.createModels()
				expect(models.getModel("acme", "model-old")?.id).toBe("model-old")

				try {
					// Start an older full refresh capturing model-old before it is removed.
					holdFullRefresh = true
					const slowRefresh = models.getAvailable()
					yield* Effect.promise(() => fullRefreshEntered)

					// Remove model-old and run a newer provider-specific credential check.
					currentModels = ["model-keep"]
					yield* Effect.promise(() => Promise.resolve(providers.checkCredentials("acme")))
					expect(models.getModel("acme", "model-old")).toBeUndefined()

					// Now let the older full refresh complete; it must NOT restore model-old.
					releaseFullRefresh()
					const availableAfterSlow = yield* Effect.promise(() => slowRefresh)
					expect(
						availableAfterSlow.some((m) => m.provider === "acme" && m.id === "model-old"),
					).toBe(false)
					expect(models.getModel("acme", "model-old")).toBeUndefined()
					expect(providers.createModels().getModel("acme", "model-old")).toBeUndefined()
				} finally {
					releaseFullRefresh()
				}
			}),
	)

	it.live(
		"revalidates gateway models by their original lookup ID instead of stripped wire ID",
		() =>
			Effect.gen(function* () {
				const server = yield* Effect.acquireRelease(
					Effect.promise(() => startCaptureResponsesServer()),
					(running) => Effect.promise(() => running.close()),
				)
				const runtime = dynamicPiProviderRuntime(() =>
					Effect.succeed({
						env: {
							CLOUDFLARE_ACCOUNT_ID: "acct_test",
							CLOUDFLARE_GATEWAY_ID: "gw_test",
							CLOUDFLARE_AI_API_KEY: "cf-aig-test-token",
						},
						baseUrlOverrides: { "cloudflare-ai-gateway": server.baseUrl },
					}),
				)
				const providers = yield* runtime.forSession({ sessionId: "sess_gateway_lookup" })
				const models = providers.createModels()

				const gatewayModel = models.getModel("cloudflare-ai-gateway", "openai/future-model")
				expect(gatewayModel).toBeDefined()
				if (gatewayModel === undefined || !hasApi(gatewayModel, "openai-responses")) {
					return
				}
				expect(gatewayModel.id).toBe("future-model")

				const auth = yield* Effect.promise(() => models.getAuth(gatewayModel))
				expect(auth?.auth.headers?.["cf-aig-authorization"]).toBe("Bearer cf-aig-test-token")

				const simpleReply = yield* Effect.promise(() =>
					models.completeSimple(gatewayModel, {
						messages: [{ role: "user", content: "gateway hi", timestamp: 1_700_000_000_000 }],
					}),
				)
				expect(simpleReply.stopReason).toBe("stop")

				const typedReply = yield* Effect.promise(() =>
					models.complete(gatewayModel, {
						messages: [{ role: "user", content: "gateway typed", timestamp: 1_700_000_000_001 }],
					}),
				)
				expect(typedReply.stopReason).toBe("stop")

				models.deleteProvider("cloudflare-ai-gateway")
				expect(yield* Effect.promise(() => models.getAuth(gatewayModel))).toBeUndefined()
				const afterDelete = yield* Effect.promise(() =>
					models.completeSimple(gatewayModel, {
						messages: [{ role: "user", content: "blocked", timestamp: 1_700_000_000_002 }],
					}),
				)
				expect(afterDelete.stopReason).toBe("error")
			}),
	)

	it.live(
		"unblocks both runPiDurableTurn and recoverPiDurableTurn when abort interrupts a stalled credential check",
		() =>
			Effect.gen(function* () {
				const cancelled = new Set<string>()
				let resetCount = 0
				let observedSignal: AbortSignal | undefined
				let markEntered!: () => void
				const entered = new Promise<void>((resolve) => {
					markEntered = resolve
				})

				const backend = makePiHarnessBackend(
					{
						pi: async () => ({
							commit: async () => undefined,
						}),
						abort: async () => undefined,
					} as unknown as Parameters<typeof makePiHarnessBackend>[0],
					{
						isCancelled: (operationId: string) => cancelled.has(operationId),
						markCancelled: (operationId: string) => {
							cancelled.add(operationId)
						},
					} as unknown as Parameters<typeof makePiHarnessBackend>[1],
					{},
					() => {
						resetCount += 1
					},
					() => Promise.resolve(true),
					{
						checkCredentials: (_provider, signal) => {
							observedSignal = signal
							markEntered()
							// Deliberately never resolves (simulating a hung external credential check).
							return new Promise(() => {
								// intentionally unsettled
							})
						},
					},
				)

				const turnFiber = yield* Effect.forkChild(
					runPiDurableTurn(backend, makeTurnRequest(1, "openai")),
					{ startImmediately: true },
				)
				yield* Effect.promise(() => entered)

				const recoverFiber = yield* Effect.forkChild(recoverPiDurableTurn(backend, "turn:1"), {
					startImmediately: true,
				})

				const aborted = yield* abortPiDurableTurn(backend, "turn:1").pipe(
					Effect.provideService(AbortGrace, "50 millis"),
				)
				expect(aborted).toBe(true)
				expect(resetCount).toBe(0)
				expect(observedSignal?.aborted).toBe(true)

				const [turnOutcome, recoverOutcome] = yield* Effect.all([
					Fiber.join(turnFiber),
					Fiber.join(recoverFiber),
				])
				expect(turnOutcome).toEqual({ ok: false, error: { _tag: "TurnInterrupted" } })
				expect(recoverOutcome).toEqual({ ok: false, error: { _tag: "TurnInterrupted" } })
			}),
	)

	it.live("returns an aborted refresh result when signal fires during config resolution", () =>
		Effect.gen(function* () {
			let hangRefresh = false
			const runtime = dynamicPiProviderRuntime(({ provider }) => {
				if (hangRefresh && provider === undefined) {
					return Effect.never
				}
				return Effect.succeed({ env: { OPENAI_API_KEY: "sk-refresh" } })
			})

			const providers = yield* runtime.forSession({ sessionId: "sess_refresh_abort" })
			const models = providers.createModels()

			hangRefresh = true
			const runAbortedRefresh = async () => {
				const controller = new AbortController()
				const pending = models.refresh({ signal: controller.signal })
				await new Promise<void>((resolve) => {
					setTimeout(() => {
						resolve()
					}, 10)
				})
				controller.abort()
				return pending
			}
			const result = yield* Effect.promise(() => runAbortedRefresh())
			expect(result.aborted).toBe(true)
			expect(result.errors.size).toBe(0)
		}),
	)

	it.live(
		"preserves refresh ordering across registry rebuilds for a refreshable provider installed via setProvider",
		() =>
			Effect.gen(function* () {
				const runtime = dynamicPiProviderRuntime(() =>
					Effect.succeed({ env: { OPENAI_API_KEY: "sk-fresh-every-call" } }),
				)
				const providers = yield* runtime.forSession({ sessionId: "sess_refresh_order" })
				const models = providers.createModels()

				let callCount = 0
				let markFirstStarted!: () => void
				const firstStarted = new Promise<void>((resolve) => {
					markFirstStarted = resolve
				})
				let releaseFirst!: () => void
				const firstGate = new Promise<void>((resolve) => {
					releaseFirst = resolve
				})

				const makeRefreshModel = (id: string) => ({
					id,
					name: id,
					api: "openai-responses" as const,
					provider: "refreshable",
					baseUrl: "https://refreshable.example/v1",
					reasoning: false,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
				})

				const refreshable = createProvider({
					id: "refreshable",
					name: "Refreshable",
					models: [],
					api: {
						stream: () => {
							throw new Error("unused")
						},
						streamSimple: () => {
							throw new Error("unused")
						},
					},
					auth: {
						apiKey: {
							name: "Refreshable Key",
							resolve: async () => ({ auth: { apiKey: "sk-ref" }, source: "static" }),
						},
					},
					fetchModels: async () => {
						callCount += 1
						if (callCount === 1) {
							markFirstStarted()
							await firstGate
							return [makeRefreshModel("stale-v1")]
						}
						return [makeRefreshModel("fresh-v2")]
					},
				})

				models.setProvider(refreshable)

				try {
					const firstRefresh = models.refresh({ providers: ["refreshable"] })
					yield* Effect.promise(() => firstStarted)

					const secondResult = yield* Effect.promise(() =>
						models.refresh({ providers: ["refreshable"] }),
					)
					expect(secondResult.aborted).toBe(false)
					expect(models.getModels("refreshable").map((m) => m.id)).toEqual(["fresh-v2"])

					releaseFirst()
					const firstResult = yield* Effect.promise(() => firstRefresh)
					expect(firstResult.aborted).toBe(false)
					expect(models.getModels("refreshable").map((m) => m.id)).toEqual(["fresh-v2"])
				} finally {
					releaseFirst()
				}
			}),
	)

	it.live(
		"does not retain snapshots for unknown provider IDs and tombstones removed providers",
		() =>
			Effect.gen(function* () {
				let includeAcme = true
				const acmeSpec: ProviderSpec = {
					id: "acme",
					name: "Acme",
					source: "custom",
					defaultFormat: "openai-responses",
					formats: ["openai-responses"],
					baseUrl: "https://acme.example/v1",
					auth: { kind: "bearer", env: "ACME_API_KEY", label: "Acme API Key" },
					allowUnlistedModels: false,
					models: { "model-a": {} },
				}

				const runtime = dynamicPiProviderRuntime(() =>
					Effect.succeed({
						env: includeAcme ? { ACME_API_KEY: "sk-acme" } : {},
						customProviders: includeAcme ? [acmeSpec] : [],
					}),
				)
				const providers = yield* runtime.forSession({ sessionId: "sess_unknown_bound" })
				const models = providers.createModels()
				expect(models.getModel("acme", "model-a")?.id).toBe("model-a")

				// Probe many unknown provider IDs.
				for (let i = 0; i < 100; i += 1) {
					const check = yield* Effect.promise(() =>
						Promise.resolve(providers.checkCredentials(`unknown-provider-${i}`)),
					)
					expect(check.ok).toBe(false)
				}
				expect(yield* Effect.promise(() => models.getAuth("unknown-provider-0"))).toBeUndefined()
				expect(models.getProvider("unknown-provider-0")).toBeUndefined()

				// Remove previously configured acme -> tombstoned on active & reopened registries.
				includeAcme = false
				const acmeCheck = yield* Effect.promise(() =>
					Promise.resolve(providers.checkCredentials("acme")),
				)
				expect(acmeCheck.ok).toBe(false)
				expect(models.getProvider("acme")).toBeUndefined()
				expect(models.getModel("acme", "model-a")).toBeUndefined()
				expect(providers.createModels().getProvider("acme")).toBeUndefined()
			}),
	)

	it.effect("invokes async checkCredentials once per turn admission and surfaces its message", () =>
		Effect.gen(function* () {
			let checks = 0
			const backend = makePiHarnessBackend(
				{
					pi: async () => ({
						commit: async () => undefined,
					}),
				} as unknown as Parameters<typeof makePiHarnessBackend>[0],
				{
					isCancelled: () => false,
					markCancelled: () => undefined,
				} as unknown as Parameters<typeof makePiHarnessBackend>[1],
				{},
				() => undefined,
				() => Promise.resolve(true),
				{
					checkCredentials: async (provider) => {
						checks += 1
						return {
							ok: false,
							missing: ["OPENAI_API_KEY"],
							message: `No active credential for "${provider}".`,
						}
					},
				},
			)

			const outcome = yield* runPiDurableTurn(backend, makeTurnRequest(1, "openai"))
			expect(checks).toBe(1)
			expect(outcome).toEqual({
				ok: false,
				error: {
					_tag: "TurnFailed",
					error_type: "missing_api_key_error",
					message: 'No active credential for "openai".',
					terminal: false,
				},
			})
		}),
	)

	it.effect("loads provider credentials from environment via EnvPiProviderRuntimeLive", () =>
		Effect.gen(function* () {
			const runtime = yield* PiProviderRuntime
			const providers = yield* runtime.forSession({ sessionId: "sess_env" })
			expect(providers.checkCredentials("openai")).toEqual({ ok: true })
			expect(providers.checkCredentials("anthropic")).toMatchObject({ ok: false })
			const auth = yield* Effect.promise(() => providers.createModels().getAuth("openai"))
			expect(auth?.auth.apiKey).toBe("sk-from-env")
		}).pipe(
			Effect.provide(
				EnvPiProviderRuntimeLive.pipe(
					Layer.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnv({ env: { OPENAI_API_KEY: "sk-from-env" } }),
						),
					),
				),
			),
		),
	)

	it.effect("loadEnvPiProviderRuntime stays empty when no provider secrets are configured", () =>
		Effect.gen(function* () {
			const runtime = yield* loadEnvPiProviderRuntime
			const providers = yield* runtime.forSession({ sessionId: "sess_empty" })
			expect(providers.checkCredentials("openai")).toMatchObject({ ok: false })
			expect(providers.checkCredentials("anthropic")).toMatchObject({ ok: false })
		}).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
	)

	it.effect("supports overriding PiProviderRuntime with a custom Effect layer", () =>
		Effect.gen(function* () {
			const runtime = yield* PiProviderRuntime
			const providers = yield* runtime.forSession({ sessionId: "sess_custom_layer" })
			expect(providers.checkCredentials("anthropic")).toEqual({ ok: true })
			expect(providers.checkCredentials("openai")).toMatchObject({ ok: false })
		}).pipe(
			Effect.provide(
				Layer.succeed(
					PiProviderRuntime,
					staticPiProviderRuntime({ env: { ANTHROPIC_API_KEY: "sk-ant-injected" } }),
				),
			),
		),
	)

	it.live(
		"plans PiSessionLive with env secrets by default and skips env secrets when PiProviderRuntime is injected",
		() =>
			Effect.gen(function* () {
				const scratch = yield* Effect.acquireRelease(
					Effect.promise(() => mkdtemp(join(tmpdir(), "checkfu-pi-runtime-"))),
					(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
				)
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						vi.stubEnv("ALCHEMY_HOME", join(scratch, "home"))
						vi.stubEnv("OPENAI_API_KEY", "sk-plan-env-test")
					}),
					() => Effect.sync(() => vi.unstubAllEnvs()),
				)

				const planWith = (stage: string, injectRuntime: boolean) => {
					const providerLayer = injectRuntime
						? PiSessionLive.pipe(
								Layer.provide(
									Layer.succeed(PiProviderRuntime, staticPiProviderRuntime({ env: {} })),
								),
							)
						: PiSessionLive
					const worker = PiHarnessWorker.make(
						{ main: import.meta.url },
						Effect.gen(function* () {
							yield* PiSession
							return PiHarnessWorker.of({
								recoverTurn: () => Effect.succeed(null),
								runTurn: () => Effect.die(new Error("plan only")),
								abortTurn: () => Effect.succeed(false),
								discardWorkspace: () => Effect.void,
							})
						}).pipe(Effect.provide(providerLayer)),
					)
					const stack = Alchemy.Stack(
						"PiProviderRuntimePlanTest",
						{
							providers: Cloudflare.providers(),
							state: Alchemy.localState(),
						},
						Effect.asVoid(PiHarnessWorker).pipe(Effect.provide(worker)),
					)
					return Alchemist.plan({
						stack,
						stage,
						operation: "deploy",
						dev: true,
					}).pipe(
						Effect.map(({ native }) => {
							const planned = native.resources["PiHarnessWorker"]
							return planned?.action === "create" ? Object.keys(planned.props.env ?? {}) : []
						}),
						Effect.scoped,
						Effect.provide(Alchemist.layer()),
						Effect.provideService(Alchemy.AlchemyContext, {
							dotAlchemy: join(scratch, stage),
							dev: true,
							adopt: false,
						}),
					)
				}

				const defaultEnvKeys = yield* planWith("default-env", false)
				expect(defaultEnvKeys).toContain("OPENAI_API_KEY")

				const injectedEnvKeys = yield* planWith("injected-runtime", true)
				expect(injectedEnvKeys).not.toContain("OPENAI_API_KEY")
			}),
		60_000,
	)
})
