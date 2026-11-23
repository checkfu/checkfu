import { AgentView } from "@checkfu/domain/Agent/AgentView.view"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "@effect/vitest"
import * as Alchemy from "alchemy"
import * as Alchemist from "alchemy/Alchemist"
import { State } from "alchemy/State"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type * as Scope from "effect/Scope"
import stack, {
	CLOUDFLARE_STATE_OBSERVABILITY,
	checkfuStack,
	inProduction,
} from "../../../alchemy.run.ts"
import ApiWorker, { API_WORKER_PROPS } from "../src/ApiWorker.ts"

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
			}),
	)

	it.effect("checks the shipped baseline only for a production deploy", () =>
		Effect.gen(function* () {
			const checked = (dev: boolean, stage: string) => {
				let ran = false
				return inProduction(
					Effect.sync(() => {
						ran = true
					}),
				).pipe(
					Effect.provide([
						Layer.succeed(Alchemy.AlchemyContext, {
							dotAlchemy: "/nonexistent/.alchemy",
							dev,
							adopt: false,
						}),
						Layer.succeed(Alchemy.Stage, stage),
					]),
					Effect.map(() => ran),
				)
			}
			expect(yield* checked(false, "production")).toBe(true)
			expect(yield* checked(true, "production")).toBe(false)
			expect(yield* checked(false, "staging")).toBe(false)
		}),
	)

	it.live("refuses every way of addressing production before any network call", () =>
		Effect.gen(function* () {
			let requests = 0
			const scratch = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), "checkfu-stack-"))),
				(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
			)
			yield* Effect.acquireRelease(
				Effect.sync(() => vi.stubEnv("ALCHEMY_HOME", join(scratch, "home"))),
				() => Effect.sync(() => vi.unstubAllEnvs()),
			)
			const stack = checkfuStack(Effect.die(new Error("baseline refused")))
			const refused = <A, E>(operation: Effect.Effect<A, E, Alchemist.Services | Scope.Scope>) =>
				operation.pipe(
					Effect.scoped,
					Effect.provide(Alchemist.layer()),
					Effect.provideService(Alchemy.AlchemyContext, {
						dotAlchemy: join(scratch, "project"),
						dev: false,
						adopt: false,
					}),
					Effect.provideService(FetchHttpClient.Fetch, () => {
						requests += 1
						return Promise.reject(new Error("no network in this test"))
					}),
					Effect.exit,
					Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "not refused")),
				)
			const production = { stack, stage: "production" }
			expect(yield* refused(Alchemist.plan({ ...production, operation: "deploy" }))).toContain(
				"baseline refused",
			)
			expect(yield* refused(Alchemist.Drift.scan(production))).toContain("baseline refused")
			expect(yield* refused(Alchemist.plan({ ...production, operation: "destroy" }))).toContain(
				"baseline refused",
			)
			expect(requests).toBe(0)
		}),
	)
})
