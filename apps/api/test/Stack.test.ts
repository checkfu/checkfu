import * as Cloudflare from "@alchemy.run/cloudflare"
import { AgentView } from "@checkfu/agents/Agent/AgentView.view"
import { Credentials } from "@distilled.cloud/cloudflare/Credentials"
import * as workers from "@distilled.cloud/cloudflare/workers"
import { describe, expect, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import { State } from "alchemy/State"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import stack, {
	CLOUDFLARE_STATE_OBSERVABILITY,
	DEFAULT_STATE_STORE_WORKER_NAME,
	markDeployProgramEvaluated,
	shouldRequireShippedBaseline,
	withProductionBaselineGate,
	withProductionStateGate,
} from "../../../alchemy.run.ts"
import {
	formatSyncStateStoreObservabilityResult,
	makeSyncCloudflareApiLayer,
	parseSyncCliArgs,
	syncStateStoreObservability,
} from "../../../scripts/sync-state-store-observability.ts"
import ApiWorker, { API_WORKER_PROPS } from "../src/ApiWorker.ts"

describe("Alchemy stack and worker entry", () => {
	it("loads ApiWorker and alchemy.run.ts without workerd, uses local state in dev, and keeps AgentView unversioned", async () => {
		expect(ApiWorker).toBeDefined()
		// 2026-11-17 makes enable_request_signal the default without emitting a redundant-flag warning.
		expect(API_WORKER_PROPS.compatibility.date >= "2026-11-17").toBe(true)
		expect("flags" in API_WORKER_PROPS.compatibility).toBe(false)
		expect(API_WORKER_PROPS.codeUpdateStrategy).toEqual({
			mode: "deferred",
			maxDelay: "12 minutes",
		})
		expect(API_WORKER_PROPS.observability).toEqual({
			enabled: true,
			issues: { enabled: true },
		})
		expect(CLOUDFLARE_STATE_OBSERVABILITY).toEqual({
			enabled: true,
			logs: { enabled: true, invocationLogs: false },
		})
		expect(stack).toBeDefined()
		expect(AgentView.definition.version).toBeUndefined()

		const devStateLayer = stack.state.pipe(
			Layer.provide(
				Layer.mergeAll(
					// `stack.state` types the full `Alchemy.StackServices` union for its production branch,
					// while `dev: true` only resolves `Alchemy.localState()` (`AlchemyContext | Stage | FileSystem | Path`).
					Layer.succeedContext(
						Context.makeUnsafe<
							Exclude<
								Alchemy.StackServices,
								Alchemy.AlchemyContext | Alchemy.Stage | FileSystem.FileSystem | Path.Path
							>
						>(new Map()),
					),
					Layer.succeed(Alchemy.AlchemyContext, {
						dotAlchemy: "/nonexistent/.alchemy",
						dev: true,
						adopt: false,
					}),
					Layer.succeed(Alchemy.Stage, "dev"),
					FileSystem.layerNoop({
						makeDirectory: () => Effect.void,
						exists: () => Effect.succeed(false),
						readDirectory: () => Effect.succeed([]),
						writeFile: () => Effect.void,
						writeFileString: () => Effect.void,
						rename: () => Effect.void,
					}),
					Path.layer,
				),
			),
		)
		const devStateStore = await Effect.runPromise(
			Effect.gen(function* () {
				const state = yield* State
				return yield* state
			}).pipe(Effect.provide(devStateLayer)),
		)
		expect(devStateStore.id).toBe("local")

		const checkBaselineGate = (dev: boolean, stage: string) =>
			Effect.runPromise(
				shouldRequireShippedBaseline.pipe(
					Effect.provide([
						Layer.succeed(Alchemy.AlchemyContext, {
							dotAlchemy: "/nonexistent/.alchemy",
							dev,
							adopt: false,
						}),
						Layer.succeed(Alchemy.Stage, stage),
					]),
				),
			)
		expect(await checkBaselineGate(true, "production")).toBe(false)
		expect(await checkBaselineGate(false, "production")).toBe(true)
		expect(await checkBaselineGate(false, "staging")).toBe(false)
	})

	it("gates production provider mutations on the shipped baseline while allowing logs, destroy, dev, and staging", async () => {
		let gateChecks = 0
		let reconcileCalls = 0
		let precreateCalls = 0
		let logsCalls = 0
		let deleteCalls = 0
		let failGate = true
		const mockProvider = {
			logs: () => {
				logsCalls += 1
				return Effect.succeed([])
			},
			delete: () => {
				deleteCalls += 1
				return Effect.void
			},
			precreate: () => {
				precreateCalls += 1
				return Effect.succeed({ id: "precreated" })
			},
			reconcile: () => {
				reconcileCalls += 1
				return Effect.succeed({ id: "reconciled" })
			},
		}
		class DualCollection extends Alchemy.ProviderCollection<DualCollection>()("MockCollection") {}
		const mockProvidersLayer = Layer.succeed(DualCollection, {
			kind: "ProviderCollection" as const,
			get: (name: string) =>
				name === "Mock.Resource"
					? ({
							...mockProvider,
							modes: {
								live: Effect.succeed(mockProvider),
								local: Effect.succeed(mockProvider),
							},
						} as never)
					: undefined,
			providers: {
				"Mock.Resource": {
					...mockProvider,
					modes: {
						live: Effect.succeed(mockProvider),
						local: Effect.succeed(mockProvider),
					},
				} as never,
			},
		})
		const testGate = Effect.suspend(() => {
			gateChecks += 1
			return failGate ? Effect.die(new Error("Production deploy refused")) : Effect.void
		})
		const buildGatedCollection = (dev: boolean, stage: string, runProgram: boolean) =>
			Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						if (runProgram) {
							yield* markDeployProgramEvaluated
						}
						const collection = yield* DualCollection
						return collection.get("Mock.Resource")!
					}).pipe(
						Effect.provide(
							withProductionBaselineGate(mockProvidersLayer, testGate).pipe(
								Layer.provideMerge(
									Layer.mergeAll(
										Layer.succeed(Alchemy.AlchemyContext, {
											dotAlchemy: "/nonexistent/.alchemy",
											dev,
											adopt: false,
										}),
										Layer.succeed(Alchemy.Stage, stage),
										Layer.succeed(Alchemy.Stack, {
											name: "Checkfu",
											stage,
											resources: {},
											bindings: {},
											actions: {},
										}),
									),
								),
							),
						),
					),
				),
			)

		const destroyProvider = await buildGatedCollection(false, "production", false)
		expect(gateChecks).toBe(0)
		const destroyLive = await Effect.runPromise(destroyProvider.modes!.live)
		const destroyLocal = await Effect.runPromise(destroyProvider.modes!.local)
		await Effect.runPromise(destroyLive.delete({} as never))
		await Effect.runPromise(destroyLocal.delete({} as never))
		expect(deleteCalls).toBe(2)
		expect(gateChecks).toBe(0)

		const prodProvider = await buildGatedCollection(false, "production", true)
		expect(gateChecks).toBe(0)
		await Effect.runPromise(prodProvider.logs!({} as never))
		expect(logsCalls).toBe(1)
		expect(gateChecks).toBe(0)

		const liveVariant = await Effect.runPromise(prodProvider.modes!.live)
		const localVariant = await Effect.runPromise(prodProvider.modes!.local)
		await expect(Effect.runPromise(liveVariant.delete({} as never))).rejects.toThrow(
			/Production deploy refused/,
		)
		await expect(Effect.runPromise(localVariant.delete({} as never))).rejects.toThrow(
			/Production deploy refused/,
		)
		await expect(Effect.runPromise(liveVariant.reconcile({} as never))).rejects.toThrow(
			/Production deploy refused/,
		)
		await expect(Effect.runPromise(liveVariant.precreate!({} as never))).rejects.toThrow(
			/Production deploy refused/,
		)
		expect(deleteCalls).toBe(2)
		expect(reconcileCalls).toBe(0)
		expect(precreateCalls).toBe(0)
		expect(gateChecks).toBe(1)

		failGate = false
		gateChecks = 0
		const passingProdProvider = await buildGatedCollection(false, "production", true)
		const passingLive = await Effect.runPromise(passingProdProvider.modes!.live)
		await Effect.runPromise(passingLive.delete({} as never))
		await Effect.runPromise(passingLive.reconcile({} as never))
		await Effect.runPromise(passingLive.precreate!({} as never))
		expect(gateChecks).toBe(1)
		expect(deleteCalls).toBe(3)
		expect(reconcileCalls).toBe(1)
		expect(precreateCalls).toBe(1)

		failGate = true
		gateChecks = 0
		const devProdProvider = await buildGatedCollection(true, "production", true)
		await Effect.runPromise(devProdProvider.delete({} as never))
		await Effect.runPromise(devProdProvider.reconcile({} as never))
		const stagingProvider = await buildGatedCollection(false, "staging", true)
		await Effect.runPromise(stagingProvider.delete({} as never))
		await Effect.runPromise(stagingProvider.reconcile({} as never))
		expect(gateChecks).toBe(0)
		expect(deleteCalls).toBe(5)
		expect(reconcileCalls).toBe(3)
	})

	it("gates production state-store initialization during deploy planning and drift preflight", async () => {
		let stateInitCalls = 0
		let stateGateChecks = 0
		let failStateGate = true
		const mockStateLayer = Layer.succeed(
			State,
			Effect.suspend(() => {
				stateInitCalls += 1
				return Effect.succeed({ id: "mock-cloudflare-state" } as never)
			}),
		)
		const stateGate = Effect.suspend(() => {
			stateGateChecks += 1
			return failStateGate ? Effect.die(new Error("Production deploy refused")) : Effect.void
		})
		const initGatedState = (options: {
			readonly dev: boolean
			readonly stage: string
			readonly runProgram: boolean
			readonly spans: ReadonlyArray<string>
		}) =>
			Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						if (options.runProgram) {
							yield* markDeployProgramEvaluated
						}
						const stateInit = yield* State
						let wrapped = stateInit
						for (let i = options.spans.length - 1; i >= 0; i--) {
							wrapped = wrapped.pipe(Effect.withSpan(options.spans[i]!))
						}
						return yield* wrapped
					}).pipe(
						Effect.provide(
							withProductionStateGate(mockStateLayer, stateGate).pipe(
								Layer.provideMerge(
									Layer.mergeAll(
										Layer.succeed(Alchemy.AlchemyContext, {
											dotAlchemy: "/nonexistent/.alchemy",
											dev: options.dev,
											adopt: false,
										}),
										Layer.succeed(Alchemy.Stage, options.stage),
										Layer.succeed(Alchemy.Stack, {
											name: "Checkfu",
											stage: options.stage,
											resources: {},
											bindings: {},
											actions: {},
										}),
									),
								),
							),
						),
					),
				),
			)

		await expect(
			initGatedState({
				dev: false,
				stage: "production",
				runProgram: true,
				spans: ["plan.make"],
			}),
		).rejects.toThrow(/Production deploy refused/)
		await expect(
			initGatedState({
				dev: false,
				stage: "production",
				runProgram: false,
				spans: ["cli.deploy", "Alchemist.Drift.scan"],
			}),
		).rejects.toThrow(/Production deploy refused/)
		expect(stateGateChecks).toBe(2)
		expect(stateInitCalls).toBe(0)

		await initGatedState({
			dev: false,
			stage: "production",
			runProgram: true,
			spans: ["cli.logs", "Alchemist.Logs.entries"],
		})
		await initGatedState({
			dev: false,
			stage: "production",
			runProgram: false,
			spans: ["cli.drift", "Alchemist.Drift.scan"],
		})
		await initGatedState({
			dev: false,
			stage: "production",
			runProgram: false,
			spans: ["cli.destroy"],
		})
		await initGatedState({
			dev: true,
			stage: "production",
			runProgram: true,
			spans: ["cli.deploy", "plan.make"],
		})
		await initGatedState({
			dev: false,
			stage: "staging",
			runProgram: true,
			spans: ["cli.deploy", "plan.make"],
		})
		expect(stateGateChecks).toBe(2)
		expect(stateInitCalls).toBe(5)

		failStateGate = false
		await initGatedState({
			dev: false,
			stage: "production",
			runProgram: false,
			spans: ["cli.deploy", "Alchemist.Drift.scan"],
		})
		await initGatedState({
			dev: false,
			stage: "production",
			runProgram: true,
			spans: ["cli.deploy", "plan.make"],
		})
		expect(stateGateChecks).toBe(4)
		expect(stateInitCalls).toBe(7)
	})

	it("syncs state-store observability onto existing current-version Workers without clobbering sibling settings", async () => {
		const patched: Array<workers.PatchScriptSettingRequest> = []
		const patchSetting = (input: workers.PatchScriptSettingRequest) => {
			patched.push(input)
			return Effect.succeed({} as workers.PatchScriptSettingResponse)
		}

		// Existing store with previous default (invocationLogs: true) + extra settings to preserve.
		const updated = await Effect.runPromise(
			syncStateStoreObservability({
				accountId: "acct_123",
				scriptName: DEFAULT_STATE_STORE_WORKER_NAME,
				desired: CLOUDFLARE_STATE_OBSERVABILITY,
				getSetting: () =>
					Effect.succeed({
						observability: {
							enabled: true,
							headSamplingRate: 0.5,
							redactQueryString: true,
							logs: {
								enabled: true,
								invocationLogs: true,
								destinations: ["log-dest"],
								headSamplingRate: 0.25,
								persist: true,
							},
							traces: {
								enabled: true,
								headSamplingRate: 0.1,
								persist: true,
								propagationPolicy: "authenticated",
							},
							issues: { enabled: true },
						},
					}),
				patchSetting,
			}),
		)
		expect(updated.status).toBe("updated")
		expect(patched).toHaveLength(1)
		expect(patched[0]).toEqual({
			accountId: "acct_123",
			scriptName: DEFAULT_STATE_STORE_WORKER_NAME,
			observability: {
				enabled: true,
				headSamplingRate: 0.5,
				redactQueryString: true,
				logs: {
					enabled: true,
					invocationLogs: false,
					destinations: ["log-dest"],
					headSamplingRate: 0.25,
					persist: true,
				},
				traces: {
					destinations: undefined,
					enabled: true,
					headSamplingRate: 0.1,
					persist: true,
					propagationPolicy: "authenticated",
				},
				issues: { enabled: true },
			},
		})

		// Already up to date -> no PATCH call.
		const unchanged = await Effect.runPromise(
			syncStateStoreObservability({
				accountId: "acct_123",
				scriptName: DEFAULT_STATE_STORE_WORKER_NAME,
				desired: CLOUDFLARE_STATE_OBSERVABILITY,
				getSetting: () =>
					Effect.succeed({
						observability: {
							enabled: true,
							logs: { enabled: true, invocationLogs: false },
						},
					}),
				patchSetting,
			}),
		)
		expect(unchanged).toEqual({ status: "unchanged", scriptName: DEFAULT_STATE_STORE_WORKER_NAME })
		expect(patched).toHaveLength(1)

		// Dry-run -> reports planned observability without patching.
		const dryRun = await Effect.runPromise(
			syncStateStoreObservability({
				accountId: "acct_123",
				scriptName: DEFAULT_STATE_STORE_WORKER_NAME,
				desired: CLOUDFLARE_STATE_OBSERVABILITY,
				dryRun: true,
				getSetting: () =>
					Effect.succeed({
						observability: {
							enabled: true,
							logs: { enabled: true, invocationLogs: true },
						},
					}),
				patchSetting,
			}),
		)
		expect(dryRun.status).toBe("would-update")
		expect(patched).toHaveLength(1)

		// Missing Worker -> reports no changes and gives conditional bootstrap guidance.
		const missing = await Effect.runPromise(
			syncStateStoreObservability({
				accountId: "acct_123",
				scriptName: DEFAULT_STATE_STORE_WORKER_NAME,
				desired: CLOUDFLARE_STATE_OBSERVABILITY,
				getSetting: () =>
					Effect.fail(
						new workers.WorkerNotFound({
							code: 10007,
							message: "workers.api.error.script_not_found",
						}),
					),
				patchSetting,
			}),
		)
		expect(missing).toEqual({ status: "missing", scriptName: DEFAULT_STATE_STORE_WORKER_NAME })
		const missingMessage = formatSyncStateStoreObservabilityResult(missing)
		expect(missingMessage).toContain("no settings were changed")
		expect(missingMessage).toContain("in this account")
		expect(missingMessage).toContain("--yes")
		expect(missingMessage).not.toContain("the next deploy will bootstrap it")

		// Partially bootstrapped Worker (no deployed versions yet) -> treated as missing.
		const versionless = await Effect.runPromise(
			syncStateStoreObservability({
				accountId: "acct_123",
				scriptName: "custom-state",
				desired: CLOUDFLARE_STATE_OBSERVABILITY,
				getSetting: () =>
					Effect.fail(
						new workers.WorkerHasNoVersions({
							code: 10215,
							message: "workers.api.error.script_has_no_versions",
						}),
					),
				patchSetting,
			}),
		)
		expect(versionless).toEqual({ status: "missing", scriptName: "custom-state" })
		const versionlessMessage = formatSyncStateStoreObservabilityResult(versionless)
		expect(versionlessMessage).toContain("no settings were changed")
		expect(versionlessMessage).not.toContain("When bootstrapped")
		expect(patched).toHaveLength(1)

		expect(parseSyncCliArgs([])).toEqual({
			dryRun: false,
			scriptName: DEFAULT_STATE_STORE_WORKER_NAME,
			accountId: undefined,
		})
		expect(
			parseSyncCliArgs(["--dry-run", "--worker-name", "custom-state", "--account-id=acct_999"]),
		).toEqual({
			dryRun: true,
			scriptName: "custom-state",
			accountId: "acct_999",
		})
		expect(() => parseSyncCliArgs(["--unknown"])).toThrow(/Unknown argument/)

		// Explicit --account-id feeds Cloudflare credential resolution under CI + CLOUDFLARE_API_TOKEN
		// without requiring CLOUDFLARE_ACCOUNT_ID to also be exported in the environment.
		const ciAccountId = "0123456789abcdef0123456789abcdef"
		const ciResolved = await Effect.runPromise(
			Effect.gen(function* () {
				const env = yield* yield* Cloudflare.CloudflareEnvironment
				const creds = yield* yield* Credentials
				return { env, creds }
			}).pipe(
				Effect.provide(
					makeSyncCloudflareApiLayer(ciAccountId).pipe(
						Layer.provide(
							ConfigProvider.layer(
								ConfigProvider.fromUnknown({
									CI: "true",
									CLOUDFLARE_API_TOKEN: "test-ci-token",
								}),
							),
						),
					),
				),
			),
		)
		expect(ciResolved.env.type).toBe("apiToken")
		expect(ciResolved.env.accountId).toBe(ciAccountId)
		expect(ciResolved.creds.type).toBe("apiToken")
	})
})
