import { AgentView } from "@checkfu/agents/Agent/AgentView.view"
import { describe, expect, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import { State } from "alchemy/State"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import stack, {
	markDeployProgramEvaluated,
	shouldRequireShippedBaseline,
	withProductionBaselineGate,
	withProductionStateGate,
} from "../../../alchemy.run.ts"
import ApiWorker from "../src/ApiWorker.ts"

describe("Alchemy stack and worker entry", () => {
	it("loads ApiWorker and alchemy.run.ts without workerd, uses local state in dev, and keeps AgentView unversioned", async () => {
		expect(ApiWorker).toBeDefined()
		expect(stack).toBeDefined()
		expect(AgentView.definition.version).toBeUndefined()

		const devStateLayer = (stack.state as Layer.Layer<typeof State.Identifier>).pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(Alchemy.AlchemyContext, {
						dotAlchemy: "/nonexistent/.alchemy",
						dev: true,
						adopt: false,
					}),
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
					Effect.provide(
						Layer.mergeAll(
							Layer.succeed(Alchemy.AlchemyContext, {
								dotAlchemy: "/nonexistent/.alchemy",
								dev,
								adopt: false,
							}),
							Layer.succeed(Alchemy.Stage, stage),
						),
					),
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
})
