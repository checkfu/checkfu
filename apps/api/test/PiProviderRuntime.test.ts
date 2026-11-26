import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { ProviderCredentialCheck } from "@checkfu/pi-providers/catalog"
import { createProviderModels } from "@checkfu/pi-providers/runtime"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import type { AgentChange } from "@earendil-works/pi-durable"
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
import type { PiDurableBackend } from "../src/Pi/PiDurableEngine.ts"
import { PiHarnessWorker } from "../src/Pi/PiHarness.ts"
import {
	EnvPiProviderRuntimeLive,
	PiProviderRuntime,
	loadEnvPiProviderRuntime,
	staticPiProviderRuntime,
} from "../src/Pi/PiProviderRuntime.ts"
import type { PiSessionProviders } from "../src/Pi/PiProviderRuntime.ts"
import { PiSession, PiSessionLive, makePiHarnessBackend } from "../src/Pi/PiSession.do.ts"
import type { PiTurnRequest } from "../src/Pi/PiTurn.ts"
import { ActiveUsage } from "../src/Pi/PiTurnUsage.ts"
import { makeAssistantReply, makeScriptedPiModels } from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

const makeTurnRequest = (turn: number, provider = "openai"): PiTurnRequest => ({
	operationId: `turn:${turn}`,
	turn,
	provider,
	modelId: "gpt-4o-mini",
	system: null,
	text: "hello",
})

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

	it.effect("invokes async checkCredentials once per turn admission and surfaces its message", () =>
		Effect.gen(function* () {
			let checks = 0
			const backend = makePiHarnessBackend(
				{
					pi: async () => ({
						commit: async () => undefined,
						snapshot: async () => undefined,
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

	it.live(
		"keeps slow credential checks outside the session lock and unblocks recovery on abort",
		() =>
			Effect.gen(function* () {
				const cancelled = new Set<string>()
				const harnessAborts: Array<string> = []
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
							snapshot: async () => undefined,
						}),
						abort: async ({ operationId }: { readonly operationId: string }) => {
							harnessAborts.push(operationId)
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
						checkCredentials: (_provider, signal) => {
							observedSignal = signal
							markEntered()
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
				expect(harnessAborts).toEqual(["turn:1"])
				expect(observedSignal?.aborted).toBe(true)

				const [turnOutcome, recoverOutcome] = yield* Effect.all([
					Fiber.join(turnFiber),
					Fiber.join(recoverFiber),
				])
				expect(turnOutcome).toEqual({ ok: false, error: { _tag: "TurnInterrupted" } })
				expect(recoverOutcome).toEqual({ ok: false, error: { _tag: "TurnInterrupted" } })
			}),
	)

	it.live("aborts the credential check signal when the admission fiber is interrupted", () =>
		Effect.gen(function* () {
			let observedSignal: AbortSignal | undefined
			let markEntered!: () => void
			const entered = new Promise<void>((resolve) => {
				markEntered = resolve
			})

			const backend = makePiHarnessBackend(
				{
					pi: async () => ({
						commit: async () => undefined,
						snapshot: async () => undefined,
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
					checkCredentials: (_provider, signal) => {
						observedSignal = signal
						markEntered()
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
			expect(observedSignal?.aborted).toBe(false)

			yield* Fiber.interrupt(turnFiber)
			expect(observedSignal?.aborted).toBe(true)
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
							snapshot: async (token: unknown) =>
								token === ActiveUsage ? undefined : { input_tokens: 5, output_tokens: 3 },
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

	it.live(
		"wakes a stalled credential check when an overlapping retry submits the turn so recovery returns the reply",
		() =>
			Effect.gen(function* () {
				const rawBackend = yield* Effect.promise(() =>
					createInMemoryPiDurableBackend(
						makeScriptedPiModels(async (model) =>
							makeAssistantReply(model, null, "reply from overlapping retry", 7, 4),
						),
					),
				)
				let checkCall = 0
				let stalledSignal: AbortSignal | undefined
				let markStalledEntered!: () => void
				const stalledEntered = new Promise<void>((resolve) => {
					markStalledEntered = resolve
				})

				const backend: PiDurableBackend = {
					...rawBackend,
					checkCredentials: (_provider, signal) => {
						checkCall += 1
						if (checkCall === 1) {
							stalledSignal = signal
							markStalledEntered()
							return new Promise(() => {
								// intentionally unsettled
							})
						}
						return { ok: true }
					},
				}

				try {
					const request = makeTurnRequest(1, "openai")
					const stalledTurn = yield* Effect.forkChild(runPiDurableTurn(backend, request), {
						startImmediately: true,
					})
					yield* Effect.promise(() => stalledEntered)

					const recovery = yield* Effect.forkChild(recoverPiDurableTurn(backend, "turn:1"), {
						startImmediately: true,
					})

					const retryOutcome = yield* runPiDurableTurn(backend, request)
					expect(retryOutcome).toMatchObject({
						ok: true,
						reply: { text: "reply from overlapping retry" },
					})

					const [stalledOutcome, recoveredOutcome] = yield* Effect.all([
						Fiber.join(stalledTurn),
						Fiber.join(recovery),
					])
					expect(stalledSignal?.aborted).toBe(true)
					expect(stalledOutcome).toMatchObject({
						ok: true,
						reply: { text: "reply from overlapping retry" },
					})
					expect(recoveredOutcome).toMatchObject({
						ok: true,
						reply: { text: "reply from overlapping retry" },
					})
				} finally {
					yield* Effect.promise(() => rawBackend.close())
				}
			}),
	)

	it.live(
		"rejects a stale turn before reconfiguring the root agent when a newer turn submits during credential checks",
		() =>
			Effect.gen(function* () {
				const rawBackend = yield* Effect.promise(() =>
					createInMemoryPiDurableBackend(
						makeScriptedPiModels(async (model) =>
							makeAssistantReply(model, null, `reply from ${model.id}`, 6, 3),
						),
					),
				)
				let markTurn1Entered!: () => void
				const turn1Entered = new Promise<void>((resolve) => {
					markTurn1Entered = resolve
				})
				let releaseTurn1Check!: () => void
				const turn1Gate = new Promise<void>((resolve) => {
					releaseTurn1Check = resolve
				})
				const ensureRootCalls: Array<AgentChange> = []
				let checkCall = 0

				const backend: PiDurableBackend = {
					...rawBackend,
					checkCredentials: async () => {
						checkCall += 1
						if (checkCall === 1) {
							markTurn1Entered()
							await turn1Gate
						}
						return { ok: true }
					},
					ensureRoot: async (agent) => {
						ensureRootCalls.push(agent)
						return rawBackend.ensureRoot(agent)
					},
				}

				try {
					const turn1Fiber = yield* Effect.forkChild(
						runPiDurableTurn(backend, {
							operationId: "turn:1",
							turn: 1,
							provider: "openai",
							modelId: "gpt-4o-mini",
							system: "stale turn 1 instructions",
							text: "hello from turn 1",
						}),
						{ startImmediately: true },
					)
					yield* Effect.promise(() => turn1Entered)

					const turn2Outcome = yield* runPiDurableTurn(backend, {
						operationId: "turn:2",
						turn: 2,
						provider: "openai",
						modelId: "gpt-4.1-mini",
						system: "newer turn 2 instructions",
						text: "hello from turn 2",
					})
					expect(turn2Outcome).toMatchObject({
						ok: true,
						reply: { text: "reply from gpt-4.1-mini" },
					})

					releaseTurn1Check()
					const turn1Outcome = yield* Fiber.join(turn1Fiber)
					expect(turn1Outcome).toEqual({ ok: false, error: { _tag: "TurnInterrupted" } })

					expect(ensureRootCalls).toEqual([
						{
							model: { provider: "openai", modelId: "gpt-4.1-mini" },
							instructions: "newer turn 2 instructions",
						},
					])

					const pi = yield* Effect.promise(() => rawBackend.pi())
					const root = yield* Effect.promise(() =>
						pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT),
					)
					expect(root).toBeDefined()
					const rootAgent = yield* Effect.promise(() =>
						root === undefined ? Promise.resolve(undefined) : root.agent(BACKGROUND_CONTEXT),
					)
					expect(rootAgent).toMatchObject({
						model: { provider: "openai", modelId: "gpt-4.1-mini" },
						instructions: "newer turn 2 instructions",
					})
				} finally {
					releaseTurn1Check()
					yield* Effect.promise(() => rawBackend.close())
				}
			}),
	)

	it.effect(
		"preserves the receiver and abort signal for class-based PiSessionProviders.checkCredentials",
		() =>
			Effect.gen(function* () {
				let seenSignal: AbortSignal | undefined
				class ScopedSessionProviders implements PiSessionProviders {
					readonly #allowedProvider: string
					constructor(allowedProvider: string) {
						this.#allowedProvider = allowedProvider
					}
					createModels() {
						return createProviderModels({ env: {} })
					}
					checkCredentials(provider: string, signal?: AbortSignal): ProviderCredentialCheck {
						seenSignal = signal
						if (provider === this.#allowedProvider) {
							return { ok: true }
						}
						return {
							ok: false,
							missing: ["OPENAI_API_KEY"],
							message: `Only "${this.#allowedProvider}" is enabled for this session.`,
						}
					}
				}

				const sessionProviders = new ScopedSessionProviders("anthropic")
				const backend = makePiHarnessBackend(
					{
						pi: async () => ({
							commit: async () => undefined,
							snapshot: async () => undefined,
						}),
					} as unknown as Parameters<typeof makePiHarnessBackend>[0],
					{
						isCancelled: () => false,
						markCancelled: () => undefined,
					} as unknown as Parameters<typeof makePiHarnessBackend>[1],
					{},
					() => undefined,
					() => Promise.resolve(true),
					sessionProviders,
				)

				const outcome = yield* runPiDurableTurn(backend, makeTurnRequest(1, "openai"))
				expect(seenSignal).toBeDefined()
				expect(outcome).toEqual({
					ok: false,
					error: {
						_tag: "TurnFailed",
						error_type: "missing_api_key_error",
						message: 'Only "anthropic" is enabled for this session.',
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
