import { AgentView } from "@checkfu/domain/Agent/AgentView.view"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "@effect/vitest"
import * as Alchemy from "alchemy"
import * as Alchemist from "alchemy/Alchemist"
import { State } from "alchemy/State"
import * as Cause from "effect/Cause"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import stack, {
	CLOUDFLARE_STATE_OBSERVABILITY,
	checkfuStack,
	inProduction,
	publishDomainOnlyWhenRouted,
} from "../../../alchemy.run.ts"
import ApiWorker, { API_WORKER_PROPS } from "../src/ApiWorker.ts"
import { PI_HARNESS_WORKER_PROPS } from "../src/Pi/PiHarnessWorker.ts"
import { ARTIFACT_BUCKET_PROPS, artifactBucketProps } from "../src/Artifacts/ArtifactStore.ts"
import { CONTENT_WORKER_PROPS } from "../src/Content/ContentWorker.ts"
import {
	API_DOMAIN_ENV,
	DETACH_ALL,
	MCP_DOMAIN_ENV,
	PUBLISH_DOMAIN_ENV,
	publishDomain,
} from "../src/CustomDomain.ts"
import { JURISDICTION_ENV } from "../src/Placement.ts"

const RemovalPolicyName = Schema.Literals(["retain", "destroy", "protect"])

const UNENFORCEABLE = "R2 cannot keep artifact files in that jurisdiction"

const bucketPropsFor = (env: Record<string, string>) =>
	artifactBucketProps.parse(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true }))

describe("Alchemy stack and worker entry", () => {
	it.effect(
		"loads ApiWorker and alchemy.run.ts without workerd, uses local state in dev, and keeps AgentView unversioned",
		() =>
			Effect.gen(function* () {
				expect(ApiWorker).toBeDefined()
				expect(API_WORKER_PROPS.compatibility.date >= "2026-11-17").toBe(true)
				expect(ARTIFACT_BUCKET_PROPS).toEqual({ forceDestroy: true })
				expect("flags" in API_WORKER_PROPS.compatibility).toBe(false)
				expect(API_WORKER_PROPS.codeUpdateStrategy).toEqual({
					mode: "deferred",
					maxDelay: "12 minutes",
				})
				expect(API_WORKER_PROPS.observability).toEqual({
					enabled: true,
					issues: { enabled: true },
				})
				expect(PI_HARNESS_WORKER_PROPS.compatibility.date >= "2026-11-17").toBe(true)
				expect(PI_HARNESS_WORKER_PROPS.codeUpdateStrategy).toEqual({
					mode: "deferred",
					maxDelay: "12 minutes",
				})
				expect(PI_HARNESS_WORKER_PROPS.workersDev).toBe(false)
				expect(PI_HARNESS_WORKER_PROPS.observability).toEqual({
					enabled: true,
					issues: { enabled: true },
				})
				expect(CONTENT_WORKER_PROPS.compatibility.date).toBe(API_WORKER_PROPS.compatibility.date)
				expect(CONTENT_WORKER_PROPS.observability).toEqual({
					enabled: true,
					logs: { enabled: true, invocationLogs: false },
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

	it.effect("keeps artifact bytes in the R2 jurisdiction the objects are placed in", () =>
		Effect.gen(function* () {
			expect(yield* bucketPropsFor({})).toEqual({ forceDestroy: true })
			expect(yield* bucketPropsFor({ [JURISDICTION_ENV]: "" })).toEqual({ forceDestroy: true })
			for (const jurisdiction of ["eu", "fedramp", "us"]) {
				expect(yield* bucketPropsFor({ [JURISDICTION_ENV]: jurisdiction })).toEqual({
					forceDestroy: true,
					jurisdiction,
				})
			}
			const refused = yield* Effect.flip(bucketPropsFor({ [JURISDICTION_ENV]: "fedramp-high" }))
			expect(refused.message).toContain(UNENFORCEABLE)
		}),
	)

	it.live("refuses to plan a jurisdiction R2 cannot enforce before any network call", () =>
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
			const planned = (jurisdiction: string) =>
				Effect.sync(() => vi.stubEnv(JURISDICTION_ENV, jurisdiction)).pipe(
					Effect.andThen(
						Alchemist.plan({
							stack: checkfuStack(Effect.void),
							stage: "jurisdiction",
							operation: "deploy",
						}),
					),
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
					Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "planned")),
				)
			expect(yield* planned("fedramp-high")).toContain(UNENFORCEABLE)
			expect(requests).toBe(0)
			expect(yield* planned("eu")).not.toContain(UNENFORCEABLE)
		}),
	)

	it.live(
		"refuses to replace or delete the artifact bucket on the production stage only",
		() =>
			Effect.gen(function* () {
				const scratch = yield* Effect.acquireRelease(
					Effect.promise(() => mkdtemp(join(tmpdir(), "checkfu-stack-"))),
					(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
				)
				yield* Effect.acquireRelease(
					Effect.sync(() => vi.stubEnv("ALCHEMY_HOME", join(scratch, "home"))),
					() => Effect.sync(() => vi.unstubAllEnvs()),
				)
				const bucketPolicy = (stage: string) =>
					Alchemist.plan({
						stack: checkfuStack(Effect.void),
						stage,
						operation: "deploy",
						dev: true,
					}).pipe(
						Effect.flatMap((plan) =>
							Schema.decodeUnknownEffect(RemovalPolicyName)(
								plan.native.resources["ArtifactBucket"]?.resource.RemovalPolicy,
							),
						),
						Effect.scoped,
						Effect.provide(Alchemist.layer()),
						Effect.provideService(Alchemy.AlchemyContext, {
							dotAlchemy: join(scratch, stage),
							dev: true,
							adopt: false,
						}),
					)
				expect(yield* bucketPolicy("production")).toBe("protect")
				expect(yield* bucketPolicy("staging")).toBe("destroy")
			}),
		60_000,
	)

	it.live(
		"gives no Worker the publish domain in dev, where nothing routes it, and refuses API settings that could sit inside it",
		() =>
			Effect.gen(function* () {
				const scratch = yield* Effect.acquireRelease(
					Effect.promise(() => mkdtemp(join(tmpdir(), "checkfu-stack-"))),
					(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
				)
				yield* Effect.acquireRelease(
					Effect.sync(() => vi.stubEnv("ALCHEMY_HOME", join(scratch, "home"))),
					() => Effect.sync(() => vi.unstubAllEnvs()),
				)
				const planned = (stage: string, env: Record<string, string>) =>
					Effect.sync(() => {
						for (const [name, value] of Object.entries(env)) {
							vi.stubEnv(name, value)
						}
					}).pipe(
						Effect.andThen(
							Alchemist.plan({
								stack: checkfuStack(Effect.void),
								stage,
								operation: "deploy",
								dev: true,
							}),
						),
						Effect.map(({ native }) => {
							const content = native.resources["ContentWorker"]
							const api = native.resources["ApiWorker"]
							return {
								routes: content?.action === "create" ? content.props.routes : content?.action,
								record: native.resources["PublishWildcard"] !== undefined,
								told: [content, api].map((worker) =>
									worker?.action === "create"
										? Object.keys(worker.props.env ?? {}).includes(PUBLISH_DOMAIN_ENV)
										: worker?.action,
								),
							}
						}),
						Effect.scoped,
						Effect.provide(Alchemist.layer()),
						Effect.provideService(Alchemy.AlchemyContext, {
							dotAlchemy: join(scratch, stage),
							dev: true,
							adopt: false,
						}),
						Effect.exit,
						Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : exit.value)),
					)
				const none = { routes: undefined, record: false, told: [false, false] }
				expect(yield* planned("unset", {})).toEqual(none)
				expect(
					yield* planned("set", {
						[PUBLISH_DOMAIN_ENV]: "pages.example",
						[API_DOMAIN_ENV]: DETACH_ALL,
						[MCP_DOMAIN_ENV]: DETACH_ALL,
					}),
				).toEqual(none)
				expect(
					yield* planned("inside", {
						[PUBLISH_DOMAIN_ENV]: "pages.example",
						[API_DOMAIN_ENV]: "api.pages.example",
						[MCP_DOMAIN_ENV]: DETACH_ALL,
					}),
				).toContain(`${API_DOMAIN_ENV} is inside ${PUBLISH_DOMAIN_ENV} pages.example`)
				expect(
					yield* planned("implicit", {
						[PUBLISH_DOMAIN_ENV]: "pages.example",
						[API_DOMAIN_ENV]: "",
						[MCP_DOMAIN_ENV]: "",
					}),
				).toContain(
					`${API_DOMAIN_ENV} must be a hostname outside ${PUBLISH_DOMAIN_ENV} pages.example, or none`,
				)
			}),
		60_000,
	)

	it.effect("passes the publish domain to the Workers only outside dev", () =>
		Effect.gen(function* () {
			const seen = (dev: boolean) =>
				publishDomainOnlyWhenRouted(publishDomain).pipe(
					Effect.provideService(Alchemy.AlchemyContext, {
						dotAlchemy: "/nonexistent/.alchemy",
						dev,
						adopt: false,
					}),
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromUnknown({ [PUBLISH_DOMAIN_ENV]: "Pages.example" }),
					),
				)
			expect(yield* seen(false)).toBe("pages.example")
			expect(yield* seen(true)).toBeUndefined()
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
