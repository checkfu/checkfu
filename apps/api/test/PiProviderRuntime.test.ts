import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { ProviderRuntimeConfig, ProviderSpec } from "@checkfu/pi-providers/catalog"
import { buildPiProvider } from "@checkfu/pi-providers/runtime"
import { hasApi } from "@earendil-works/pi-ai/models"
import { describe, expect, it, vi } from "@effect/vitest"
import * as Alchemy from "alchemy"
import * as Alchemist from "alchemy/Alchemist"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { AbortGrace, abortPiDurableTurn, runPiDurableTurn } from "../src/Pi/PiDurableEngine.ts"
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
