import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { ProviderCredentialCheck } from "@checkfu/pi-providers/catalog"
import { createProviderModels } from "@checkfu/pi-providers/runtime"
import { describe, expect, it, vi } from "@effect/vitest"
import * as Alchemy from "alchemy"
import * as Alchemist from "alchemy/Alchemist"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { runPiDurableTurn } from "../src/Pi/PiDurableEngine.ts"
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

	it.effect(
		"preserves the receiver for class-based PiSessionProviders.checkCredentials and surfaces its message",
		() =>
			Effect.gen(function* () {
				class ScopedSessionProviders implements PiSessionProviders {
					readonly #allowedProvider: string
					constructor(allowedProvider: string) {
						this.#allowedProvider = allowedProvider
					}
					createModels() {
						return createProviderModels({ env: {} })
					}
					checkCredentials(provider: string): ProviderCredentialCheck {
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

				expect(backend.hasApiKey("anthropic")).toBe(true)
				expect(backend.hasApiKey("openai")).toBe(false)
				const outcome = yield* runPiDurableTurn(backend, makeTurnRequest(1, "openai"))
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
								listOutputs: () => Effect.succeed({ ok: true, files: [] }),
								readOutputs: () => Effect.succeed([]),
								discardWorkspace: () => Effect.void,
								putSecret: () => Effect.die(new Error("plan only")),
								secretUsable: () => Effect.succeed(false),
								eraseSecret: () => Effect.void,
								sealVault: () => Effect.void,
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
							expect(planned?.action).toBe("create")
							if (planned?.action !== "create") {
								return []
							}
							return Object.keys(planned.props.env ?? {})
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
