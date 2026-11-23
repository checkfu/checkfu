import * as Cloudflare from "@alchemy.run/cloudflare"
import { AgentView } from "@checkfu/agents/Agent/AgentView.view"
import { Credentials } from "@distilled.cloud/cloudflare/Credentials"
import * as workers from "@distilled.cloud/cloudflare/workers"
import { describe, expect, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import { State } from "alchemy/State"
import * as Cause from "effect/Cause"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
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

const expectRefusedDefect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.map(Effect.exit(effect), (exit) => {
		expect(Exit.isFailure(exit)).toBe(true)
		if (Exit.isFailure(exit)) {
			const defect = Cause.findDefect(exit.cause)
			expect(Result.isSuccess(defect)).toBe(true)
			if (Result.isSuccess(defect)) {
				const error = defect.success
				expect(error instanceof Error ? error.message : String(error)).toMatch(
					/Production deploy refused/,
				)
			}
		}
	})

describe("Alchemy stack and worker entry", () => {
	it.effect(
		"loads ApiWorker and alchemy.run.ts without workerd, uses local state in dev, and keeps AgentView unversioned",
		() =>
			Effect.gen(function* () {
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
				const devStateStore = yield* Effect.gen(function* () {
					const state = yield* State
					return yield* state
				}).pipe(Effect.provide(devStateLayer))
				expect(devStateStore.id).toBe("local")

				const checkBaselineGate = (dev: boolean, stage: string) =>
					shouldRequireShippedBaseline.pipe(
						Effect.provide([
							Layer.succeed(Alchemy.AlchemyContext, {
								dotAlchemy: "/nonexistent/.alchemy",
								dev,
								adopt: false,
							}),
							Layer.succeed(Alchemy.Stage, stage),
						]),
					)
				expect(yield* checkBaselineGate(true, "production")).toBe(false)
				expect(yield* checkBaselineGate(false, "production")).toBe(true)
				expect(yield* checkBaselineGate(false, "staging")).toBe(false)
			}),
	)

	it.effect(
		"gates production provider mutations on the shipped baseline while allowing logs, destroy, dev, and staging",
		() =>
			Effect.gen(function* () {
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
				class DualCollection extends Alchemy.ProviderCollection<DualCollection>()(
					"MockCollection",
				) {}
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
					)

				const destroyProvider = yield* buildGatedCollection(false, "production", false)
				expect(gateChecks).toBe(0)
				const destroyLive = yield* destroyProvider.modes!.live
				const destroyLocal = yield* destroyProvider.modes!.local
				yield* destroyLive.delete({} as never)
				yield* destroyLocal.delete({} as never)
				expect(deleteCalls).toBe(2)
				expect(gateChecks).toBe(0)

				const prodProvider = yield* buildGatedCollection(false, "production", true)
				expect(gateChecks).toBe(0)
				yield* prodProvider.logs!({} as never)
				expect(logsCalls).toBe(1)
				expect(gateChecks).toBe(0)

				const liveVariant = yield* prodProvider.modes!.live
				const localVariant = yield* prodProvider.modes!.local
				yield* expectRefusedDefect(liveVariant.delete({} as never))
				yield* expectRefusedDefect(localVariant.delete({} as never))
				yield* expectRefusedDefect(liveVariant.reconcile({} as never))
				yield* expectRefusedDefect(liveVariant.precreate!({} as never))
				expect(deleteCalls).toBe(2)
				expect(reconcileCalls).toBe(0)
				expect(precreateCalls).toBe(0)
				expect(gateChecks).toBe(1)

				failGate = false
				gateChecks = 0
				const passingProdProvider = yield* buildGatedCollection(false, "production", true)
				const passingLive = yield* passingProdProvider.modes!.live
				yield* passingLive.delete({} as never)
				yield* passingLive.reconcile({} as never)
				yield* passingLive.precreate!({} as never)
				expect(gateChecks).toBe(1)
				expect(deleteCalls).toBe(3)
				expect(reconcileCalls).toBe(1)
				expect(precreateCalls).toBe(1)

				failGate = true
				gateChecks = 0
				const devProdProvider = yield* buildGatedCollection(true, "production", true)
				yield* devProdProvider.delete({} as never)
				yield* devProdProvider.reconcile({} as never)
				const stagingProvider = yield* buildGatedCollection(false, "staging", true)
				yield* stagingProvider.delete({} as never)
				yield* stagingProvider.reconcile({} as never)
				expect(gateChecks).toBe(0)
				expect(deleteCalls).toBe(5)
				expect(reconcileCalls).toBe(3)
			}),
	)

	it.effect(
		"gates production state-store initialization during deploy planning and drift preflight",
		() =>
			Effect.gen(function* () {
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
					)

				yield* expectRefusedDefect(
					initGatedState({
						dev: false,
						stage: "production",
						runProgram: true,
						spans: ["plan.make"],
					}),
				)
				yield* expectRefusedDefect(
					initGatedState({
						dev: false,
						stage: "production",
						runProgram: false,
						spans: ["cli.deploy", "Alchemist.Drift.scan"],
					}),
				)
				expect(stateGateChecks).toBe(2)
				expect(stateInitCalls).toBe(0)

				yield* initGatedState({
					dev: false,
					stage: "production",
					runProgram: true,
					spans: ["cli.logs", "Alchemist.Logs.entries"],
				})
				yield* initGatedState({
					dev: false,
					stage: "production",
					runProgram: false,
					spans: ["cli.drift", "Alchemist.Drift.scan"],
				})
				yield* initGatedState({
					dev: false,
					stage: "production",
					runProgram: false,
					spans: ["cli.destroy"],
				})
				yield* initGatedState({
					dev: true,
					stage: "production",
					runProgram: true,
					spans: ["cli.deploy", "plan.make"],
				})
				yield* initGatedState({
					dev: false,
					stage: "staging",
					runProgram: true,
					spans: ["cli.deploy", "plan.make"],
				})
				expect(stateGateChecks).toBe(2)
				expect(stateInitCalls).toBe(5)

				failStateGate = false
				yield* initGatedState({
					dev: false,
					stage: "production",
					runProgram: false,
					spans: ["cli.deploy", "Alchemist.Drift.scan"],
				})
				yield* initGatedState({
					dev: false,
					stage: "production",
					runProgram: true,
					spans: ["cli.deploy", "plan.make"],
				})
				expect(stateGateChecks).toBe(4)
				expect(stateInitCalls).toBe(7)
			}),
	)

	it.effect(
		"syncs state-store observability onto existing current-version Workers without clobbering sibling settings",
		() =>
			Effect.gen(function* () {
				const patched: Array<workers.PatchScriptSettingRequest> = []
				const patchSetting = (input: workers.PatchScriptSettingRequest) => {
					patched.push(input)
					return Effect.succeed({} as workers.PatchScriptSettingResponse)
				}

				// Existing store with previous default (invocationLogs: true) + extra settings to preserve.
				const updated = yield* syncStateStoreObservability({
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
				})
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
				const unchanged = yield* syncStateStoreObservability({
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
				})
				expect(unchanged).toEqual({
					status: "unchanged",
					scriptName: DEFAULT_STATE_STORE_WORKER_NAME,
				})
				expect(patched).toHaveLength(1)

				// Dry-run -> reports planned observability without patching.
				const dryRun = yield* syncStateStoreObservability({
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
				})
				expect(dryRun.status).toBe("would-update")
				expect(patched).toHaveLength(1)

				// Missing Worker -> reports no changes and gives conditional bootstrap guidance.
				const missing = yield* syncStateStoreObservability({
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
				})
				expect(missing).toEqual({
					status: "missing",
					scriptName: DEFAULT_STATE_STORE_WORKER_NAME,
				})
				const missingMessage = formatSyncStateStoreObservabilityResult(missing)
				expect(missingMessage).toContain("no settings were changed")
				expect(missingMessage).toContain("in this account")
				expect(missingMessage).toContain("--yes")
				expect(missingMessage).not.toContain("the next deploy will bootstrap it")

				// Partially bootstrapped Worker (no deployed versions yet) -> treated as missing.
				const versionless = yield* syncStateStoreObservability({
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
				})
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
				const ciResolved = yield* Effect.gen(function* () {
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
				)
				expect(ciResolved.env.type).toBe("apiToken")
				expect(ciResolved.env.accountId).toBe(ciAccountId)
				expect(ciResolved.creds.type).toBe("apiToken")
			}),
	)
})
