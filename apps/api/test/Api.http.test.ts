import { Agent } from "@checkfu/agents/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/agents/Agent/AgentVersion.id"
import { AgentView } from "@checkfu/agents/Agent/AgentView.view"
import { CreateAgent } from "@checkfu/agents/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/agents/Agent/CreateAgent.decision"
import { CreateEnvironment } from "@checkfu/environments/Environment/CreateEnvironment.command"
import { Environment } from "@checkfu/environments/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import { EnvironmentView } from "@checkfu/environments/Environment/EnvironmentView.view"
import { CreateSession } from "@checkfu/sessions/Session/CreateSession.command"
import { ModelProvider } from "@checkfu/sessions/Session/ModelProvider.external"
import { Session } from "@checkfu/sessions/Session/Session.aggregate"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { SessionView } from "@checkfu/sessions/Session/SessionView.view"
import { MAX_IDENTIFIER_LENGTH } from "@checkfu/sessions/Session/SessionTypes"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as Scope from "effect/Scope"
import { REQUEST_ID_HEADER, RequestId, apiError, statusOf } from "../src/Http/Api.ts"
import { toApiError } from "../src/Http/HttpHelpers.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { AgentVersionLookupTimeout } from "../src/Pi/PiDurableModelProvider.ts"
import {
	AUTH_HEADERS,
	type RecordedModelCall,
	TEST_API_KEY,
	createIdleSession,
	extractConversationMessageCount,
	extractLastUserText,
	extractSystemText,
	makeAssistantReply,
	makePiDurableTestLayer,
	providerError,
	readSseUntil,
	sendRequest,
} from "./helpers/ApiHarness.ts"

describe("HTTP API routing, auth, validation, and quickstart", () => {
	it("runs the full multi-turn quickstart flow through real pi-durable: agent -> environment -> session -> SSE -> archive", async () => {
		const seenCalls: Array<RecordedModelCall> = []

		const { layer, closeAll } = makePiDurableTestLayer(async (model, context) => {
			const lastUserText = extractLastUserText(context)
			seenCalls.push({
				provider: model.provider,
				modelId: model.id,
				systemPrompt: extractSystemText(context),
				messageCount: extractConversationMessageCount(context),
				lastUserText,
			})
			return makeAssistantReply(model, "Planning reply", `Echo: ${lastUserText}`, 15, 7)
		})

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					// 1. Health check is public
					const healthRes = yield* sendRequest(apiFetch, { method: "GET", path: "/health" })
					expect(healthRes.status).toBe(200)
					expect(yield* Effect.promise(() => healthRes.json())).toEqual({ status: "ok" })

					// 2. Create & update agent (v1 -> v2, OpenAI model)
					const createAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: {
							name: "Coding Assistant",
							model: "gpt-4o-mini",
							system: "You are helpful.",
						},
					})
					expect(createAgentRes.status).toBe(201)
					const agentV1 = (yield* Effect.promise(() => createAgentRes.json())) as {
						id: string
						version: number
						model: { id: string }
					}
					expect(agentV1.id).toMatch(/^agent_/)
					expect(agentV1.version).toBe(1)

					const updateAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agentV1.id}`,
						headers: AUTH_HEADERS,
						body: {
							version: 1,
							system: "You are concise.",
						},
					})
					expect(updateAgentRes.status).toBe(200)
					const agentV2 = (yield* Effect.promise(() => updateAgentRes.json())) as {
						version: number
						system: string
					}
					expect(agentV2.version).toBe(2)
					expect(agentV2.system).toBe("You are concise.")

					// 3. Create environment
					const createEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "default-cloud" },
					})
					expect(createEnvRes.status).toBe(201)
					const env = (yield* Effect.promise(() => createEnvRes.json())) as {
						id: string
						config: { type: string }
					}
					expect(env.id).toMatch(/^env_/)
					expect(env.config.type).toBe("cloud")

					// 4. Create session pinned to agent v2 + environment
					const createSessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: {
							agent: agentV1.id,
							environment_id: env.id,
							title: "Quickstart Session",
						},
					})
					expect(createSessRes.status).toBe(201)
					const session = (yield* Effect.promise(() => createSessRes.json())) as {
						id: string
						status: string
						agent: { id: string; version: number }
						environment_id: string
					}
					expect(session.id).toMatch(/^sess_/)
					expect(session.agent).toEqual({ id: agentV1.id, version: 2 })

					// 5. Open live SSE stream, then send turn 1 user.message
					const streamRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					expect(streamRes.status).toBe(200)
					expect(streamRes.headers.get("content-type")).toContain("text/event-stream")

					const sendTurn1Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									type: "user.message",
									content: [{ type: "text", text: "Hello Checkfu!" }],
								},
							],
						},
					})
					expect(sendTurn1Res.status).toBe(200)

					const turn1Frames = yield* Effect.promise(() =>
						readSseUntil(streamRes, (evt) => evt.type === "session.status_idle"),
					)
					expect(turn1Frames.map((frame) => frame.event)).toEqual([
						"user.message",
						"session.status_running",
						"span.model_request_start",
						"agent.thinking",
						"agent.message",
						"span.model_request_end",
						"session.status_idle",
					])
					const agentMsgFrame = turn1Frames.find((f) => f.event === "agent.message")
					expect(agentMsgFrame?.data.content).toEqual([
						{ type: "text", text: "Echo: Hello Checkfu!" },
					])

					// 6. Send turn 2 and verify pi-durable preserves full conversation history
					const lastTurn1Seq = turn1Frames[turn1Frames.length - 1]!.id
					const turn2Stream = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream?after=${lastTurn1Seq}`,
						headers: AUTH_HEADERS,
					})
					const sendTurn2Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									type: "user.message",
									content: [{ type: "text", text: "Follow up!" }],
								},
							],
						},
					})
					expect(sendTurn2Res.status).toBe(200)
					const turn2Frames = yield* Effect.promise(() =>
						readSseUntil(turn2Stream, (evt) => evt.type === "session.status_idle"),
					)
					expect(turn2Frames.find((f) => f.event === "agent.message")?.data.content).toEqual([
						{ type: "text", text: "Echo: Follow up!" },
					])

					// 7. Paginated history + accumulated usage across both turns
					const listRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events?limit=3`,
						headers: AUTH_HEADERS,
					})
					expect(listRes.status).toBe(200)
					const page1 = (yield* Effect.promise(() => listRes.json())) as {
						data: ReadonlyArray<{ type: string }>
						has_more: boolean
						next_cursor: number | null
					}
					expect(page1.data).toHaveLength(3)
					expect(page1.has_more).toBe(true)
					expect(page1.next_cursor).toBe(3)

					const getSessRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}`,
						headers: AUTH_HEADERS,
					})
					const updatedSession = (yield* Effect.promise(() => getSessRes.json())) as {
						status: string
						turn: number
						usage: { input_tokens: number; output_tokens: number }
					}
					expect(updatedSession.status).toBe("idle")
					expect(updatedSession.turn).toBe(2)
					expect(updatedSession.usage).toEqual({ input_tokens: 30, output_tokens: 14 })

					// 8. Archive session
					const archiveRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(archiveRes.status).toBe(200)
					const archived = (yield* Effect.promise(() => archiveRes.json())) as {
						status: string
						archived_at: string | null
					}
					expect(archived.status).toBe("terminated")
					expect(archived.archived_at).not.toBeNull()
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}

		// Turn 1 had 1 message (user); Turn 2 had 3 messages (user + assistant + user) inside pi-durable!
		expect(seenCalls).toHaveLength(2)
		expect(seenCalls[0]).toMatchObject({
			provider: "openai",
			modelId: "gpt-4o-mini",
			messageCount: 1,
			lastUserText: "Hello Checkfu!",
		})
		expect(seenCalls[0]?.systemPrompt).toContain("You are concise.")
		expect(seenCalls[1]).toMatchObject({
			provider: "openai",
			modelId: "gpt-4o-mini",
			messageCount: 3,
			lastUserText: "Follow up!",
		})
	})

	it("applies the event-batch body limit to the endpoint, with or without a trailing slash", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const events = Array.from({ length: 8 }, () => ({
						type: "user.message",
						content: [{ type: "text", text: "é".repeat(16_384) }],
					}))
					expect(new TextEncoder().encode(JSON.stringify({ events })).length).toBeGreaterThan(
						160 * 1024,
					)
					const session = yield* createIdleSession(apiFetch)
					for (const suffix of ["", "/"]) {
						const target = yield* createIdleSession(apiFetch)
						const res = yield* sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/sessions/${target.id}/events${suffix}`,
							headers: AUTH_HEADERS,
							body: { events },
						})
						expect(res.status).toBe(200)
					}
					const tooLarge = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: { events, padding: "x".repeat(900_000) },
					})
					expect(tooLarge.status).toBe(413)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("enforces CHECKFU_API_KEY auth on /v1/* and fails closed when unconfigured", async () => {
		const { layer: authedLayer, closeAll: closeAuthed } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		const { layer: unconfiguredLayer, closeAll: closeUnconfigured } = makePiDurableTestLayer(
			async (model) => makeAssistantReply(model, null, "ok", 1, 1),
			{},
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					// Missing auth header -> 401 with Bearer challenge
					const noAuthRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						body: { name: "A", model: "gpt-4o-mini" },
					})
					expect(noAuthRes.status).toBe(401)
					expect(noAuthRes.headers.get("www-authenticate")).toBe("Bearer")

					// Wrong bearer token -> 401 with Bearer challenge
					const wrongAuthRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { authorization: "Bearer wrong-key" },
						body: { name: "A", model: "gpt-4o-mini" },
					})
					expect(wrongAuthRes.status).toBe(401)
					expect(wrongAuthRes.headers.get("www-authenticate")).toBe("Bearer")

					// x-api-key header works
					const xApiKeyRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { "x-api-key": TEST_API_KEY },
						body: { name: "A", model: "gpt-4o-mini" },
					})
					expect(xApiKeyRes.status).toBe(201)
				}).pipe(Effect.scoped, Effect.provide(authedLayer)),
			)

			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					// /health remains available
					const healthRes = yield* sendRequest(apiFetch, { method: "GET", path: "/health" })
					expect(healthRes.status).toBe(200)

					// /v1/* fails closed with 503 when CHECKFU_API_KEY is unset
					const unconfiguredRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "A", model: "gpt-4o-mini" },
					})
					expect(unconfiguredRes.status).toBe(503)
				}).pipe(Effect.scoped, Effect.provide(unconfiguredLayer)),
			)
		} finally {
			await closeAuthed()
			await closeUnconfigured()
		}
	})

	it("imports ApiWorker and alchemy.run.ts cleanly without workerd, enforces body size limits, and rejects a turn with no admitted user message", async () => {
		// 1. Stack-import smoke test: ApiWorker and alchemy.run.ts must load in Bun/Node without cloudflare:workers
		const workerMod = await import("../src/ApiWorker.ts")
		expect(workerMod.default).toBeDefined()
		const stackMod = await import("../../../alchemy.run.ts")
		expect(stackMod.default).toBeDefined()
		const Alchemy = await import("alchemy")
		const { State } = await import("alchemy/State")
		const FileSystem = await import("effect/FileSystem")
		const Path = await import("effect/Path")
		const devStateLayer = (stackMod.default.state as Layer.Layer<typeof State.Identifier>).pipe(
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

		// Local development skips the production baseline gate even when ALCHEMY_STAGE=production.
		const checkBaselineGate = (dev: boolean, stage: string) =>
			Effect.runPromise(
				stackMod.shouldRequireShippedBaseline.pipe(
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

		// Production baseline gate only runs on resource deployment (`precreate` / `reconcile`),
		// never on stack evaluation or read-only operations like `alchemy logs --stage production`.
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
							yield* stackMod.markDeployProgramEvaluated
						}
						const collection = yield* DualCollection
						return collection.get("Mock.Resource")!
					}).pipe(
						Effect.provide(
							stackMod.withProductionBaselineGate(mockProvidersLayer, testGate).pipe(
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

		// Standalone production destroy (`buildWithoutProgram`, runProgram = false) succeeds even
		// when the baseline gate fails, without running the gate.
		const destroyProvider = await buildGatedCollection(false, "production", false)
		expect(gateChecks).toBe(0)
		const destroyLive = await Effect.runPromise(destroyProvider.modes!.live)
		const destroyLocal = await Effect.runPromise(destroyProvider.modes!.local)
		await Effect.runPromise(destroyLive.delete({} as never))
		await Effect.runPromise(destroyLocal.delete({} as never))
		expect(deleteCalls).toBe(2)
		expect(gateChecks).toBe(0)

		// Production build + logs succeed even when the baseline gate fails (`alchemy logs --stage production`).
		const prodProvider = await buildGatedCollection(false, "production", true)
		expect(gateChecks).toBe(0)
		await Effect.runPromise(prodProvider.logs!({} as never))
		expect(logsCalls).toBe(1)
		expect(gateChecks).toBe(0)

		// Production deploy (including delete-first replacements on both live and local modes,
		// plus precreate and reconcile) fails BEFORE calling the provider.
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

		// Once the baseline gate passes, production delete/reconcile/precreate run and memoize once per build.
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

		// Local dev and non-production stages skip the gate even on deploy mutations.
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

		// Production state-store initialization is gated during deploy planning (`plan.make` span)
		// BEFORE Cloudflare.state() can bootstrap or upgrade a Worker, while logs, standalone destroy,
		// local dev, and non-production stages initialize state without running the gate.
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
							yield* stackMod.markDeployProgramEvaluated
						}
						const stateInit = yield* State
						let wrapped = stateInit
						for (let i = options.spans.length - 1; i >= 0; i--) {
							wrapped = wrapped.pipe(Effect.withSpan(options.spans[i]!))
						}
						return yield* wrapped
					}).pipe(
						Effect.provide(
							stackMod.withProductionStateGate(mockStateLayer, stateGate).pipe(
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

		// Production deploy plan AND `alchemy deploy --stage production --detect-drift --yes`
		// (which runs Drift.scan without evaluating the stack program) refuse BEFORE
		// state-store bootstrap/upgrade runs.
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

		// Production logs (`cli.logs`), standalone drift (`cli.drift`), standalone destroy
		// (`cli.destroy`), dev, and staging initialize state without running the gate.
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

		// Once the baseline gate passes, production deploy planning and drift preflight initialize state normally.
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

		// 2. AgentView stays at its original generation (no unnecessary version bump)
		const { AgentView } = await import("@checkfu/agents/Agent/AgentView.view")
		expect(AgentView.definition.version).toBeUndefined()

		// 4. Oversized HTTP body (> 160 KiB) returns 413 payload_too_large before buffering/persisting,
		// and a turn with no admitted user message fails with recoverable invalid_turn_input.
		const { layer, closeAll, requests } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const provider = yield* ModelProvider

					const hugeAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: {
							name: "Huge Agent",
							model: "gpt-4o-mini",
							system: "x".repeat(200_000),
						},
					})
					expect(hugeAgentRes.status).toBe(413)

					const okAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Ok Agent", model: "gpt-4o-mini" },
					})
					const okAgent = (yield* Effect.promise(() => okAgentRes.json())) as { id: string }

					const emptyTurnErr = yield* Effect.flip(
						provider.generate({
							session_id: SessionId.make("sess_missing_events"),
							agent_id: okAgent.id,
							agent_version: 1,
							environment_id: "env_1",
							turn: 5,
							generation: 0,
							input: [],
						}),
					)
					expect(providerError(emptyTurnErr).error_type).toBe("invalid_turn_input")
					expect(providerError(emptyTurnErr).terminal).toBe(false)

					const session = yield* createIdleSession(apiFetch)
					const unseenTurnErr = yield* Effect.flip(
						provider.generate({
							session_id: SessionId.make(session.id),
							agent_id: okAgent.id,
							agent_version: 1,
							environment_id: session.environment_id,
							turn: 3,
							generation: 0,
							input: ["a turn the event log has not reached"],
						}),
					)
					expect(providerError(unseenTurnErr).error_type).toBe("session_history_unavailable")
					expect(providerError(unseenTurnErr).terminal).toBe(false)
					expect(requests.map((request) => request.seed)).toEqual([undefined])
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.succeed(AgentVersionLookupTimeout, "60 millis").pipe(Layer.provideMerge(layer)),
					),
				),
			)
		} finally {
			await closeAll()
		}
	})

	it("rejects cursor and limit parameters that are not plain non-negative integers", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					for (const query of ["after=1e2", "after=0x10", "after=%20", "limit=5.0", "limit=1e1"]) {
						const res = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/sessions/${session.id}/events?${query}`,
							headers: AUTH_HEADERS,
						})
						expect({ query, status: res.status }).toEqual({ query, status: 400 })
					}
					const plain = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events?after=0&limit=10`,
						headers: AUTH_HEADERS,
					})
					expect(plain.status).toBe(200)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("accepts a full-size batch of non-ASCII user messages", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					const text = "漢".repeat(16_384)
					const res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: Array.from({ length: 4 }, () => ({
								type: "user.message",
								content: [{ type: "text", text }],
							})),
						},
					})
					expect(res.status).toBe(200)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("serves an OpenAPI document for the declared routes and ISO timestamps on resources", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const specRes = yield* sendRequest(apiFetch, { method: "GET", path: "/openapi.json" })
					expect(specRes.status).toBe(200)
					const spec = (yield* Effect.promise(() => specRes.json())) as {
						paths: Record<string, Record<string, unknown>>
					}
					expect(Object.keys(spec.paths).toSorted()).toEqual([
						"/health",
						"/v1/agents",
						"/v1/agents/{agent_id}",
						"/v1/agents/{agent_id}/archive",
						"/v1/environments",
						"/v1/environments/{environment_id}",
						"/v1/environments/{environment_id}/archive",
						"/v1/sessions",
						"/v1/sessions/{session_id}",
						"/v1/sessions/{session_id}/archive",
						"/v1/sessions/{session_id}/events",
						"/v1/sessions/{session_id}/events/stream",
					])
					const streamGet = spec.paths["/v1/sessions/{session_id}/events/stream"]?.["get"] as
						| { readonly responses: Record<string, unknown> }
						| undefined
					expect(Object.keys(streamGet?.responses ?? {})).toEqual(
						expect.arrayContaining(["200", "204"]),
					)
					const agentsPost = spec.paths["/v1/agents"]?.["post"] as
						| { readonly responses: Record<string, unknown> }
						| undefined
					expect(Object.keys(agentsPost?.responses ?? {})).toEqual(expect.arrayContaining(["415"]))

					const unsupportedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "content-type": "text/plain" },
						body: { name: "Agent", model: "gpt-4o-mini" },
					})
					expect(unsupportedRes.status).toBe(415)
					expect(unsupportedRes.headers.get("content-type")).toContain("application/json")
					const unsupportedBody = (yield* Effect.promise(() => unsupportedRes.json())) as {
						type: string
						error: { type: string; message: string }
					}
					expect(unsupportedBody.type).toBe("error")
					expect(unsupportedBody.error.type).toBe("unsupported_media_type")
					expect(unsupportedBody.error.message).toContain("text/plain")

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Agent", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as Record<string, unknown>
					expect(agent.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
					expect(agent.archived_at).toBeNull()
					expect("current_version_id" in agent).toBe(false)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("describes the SessionEvent union in /openapi.json for list and SSE endpoints", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const specRes = yield* sendRequest(apiFetch, { method: "GET", path: "/openapi.json" })
					expect(specRes.status).toBe(200)
					type JsonSchemaNode = {
						readonly $ref?: string
						readonly type?: string
						readonly enum?: ReadonlyArray<unknown>
						readonly properties?: Record<string, JsonSchemaNode>
						readonly required?: ReadonlyArray<string>
						readonly additionalProperties?: boolean
						readonly items?: JsonSchemaNode
						readonly anyOf?: ReadonlyArray<JsonSchemaNode>
						readonly contentMediaType?: string
						readonly contentSchema?: JsonSchemaNode
					}
					const spec = (yield* Effect.promise(() => specRes.json())) as {
						readonly paths: Record<
							string,
							{
								readonly get?: {
									readonly responses?: Record<
										string,
										{
											readonly content?: Record<
												string,
												{
													readonly schema?: JsonSchemaNode
													readonly "x-effect-stream"?: { readonly encoding?: string }
												}
											>
										}
									>
								}
							}
						>
						readonly components?: { readonly schemas?: Record<string, JsonSchemaNode> }
					}
					const schemas = spec.components?.schemas ?? {}
					const resolve = (node: JsonSchemaNode | undefined): JsonSchemaNode | undefined => {
						if (node?.$ref === undefined) return node
						const name = node.$ref.replace(/^#\/components\/schemas\//, "")
						return schemas[name]
					}

					const listMedia =
						spec.paths["/v1/sessions/{session_id}/events"]?.get?.responses?.["200"]?.content?.[
							"application/json"
						]
					const listItemsRef = listMedia?.schema?.properties?.["data"]?.items
					expect(listItemsRef?.$ref).toBe("#/components/schemas/SessionEvent")

					const streamMedia =
						spec.paths["/v1/sessions/{session_id}/events/stream"]?.get?.responses?.["200"]
							?.content?.["text/event-stream"]
					expect(streamMedia?.["x-effect-stream"]?.encoding).toBe("sse")
					const streamData = resolve(streamMedia?.schema?.properties?.["data"])
					expect(streamData?.type).toBe("string")
					expect(streamData?.contentMediaType).toBe("application/json")
					expect(streamData?.contentSchema?.$ref).toBe("#/components/schemas/SessionEvent")

					const sessionEventSchema = resolve(listItemsRef)
					const members = (sessionEventSchema?.anyOf ?? []).map((member) => resolve(member))
					const expectedTags = (SessionView.definition.events ?? []).map((event) => event.tag)
					expect(members).toHaveLength(expectedTags.length)

					const byType = new Map<string, JsonSchemaNode>()
					for (const member of members) {
						expect(member?.type).toBe("object")
						expect(member?.additionalProperties).toBe(false)
						expect(member?.required).toEqual(
							expect.arrayContaining(["id", "seq", "type", "created_at"]),
						)
						const typeEnum = member?.properties?.["type"]?.enum
						expect(typeEnum).toHaveLength(1)
						byType.set(String(typeEnum?.[0]), member!)
					}
					expect([...byType.keys()].toSorted()).toEqual(expectedTags.toSorted())

					expect(Object.keys(byType.get("user.message")?.properties ?? {}).toSorted()).toEqual([
						"content",
						"created_at",
						"id",
						"seq",
						"type",
					])
					expect(Object.keys(byType.get("agent.message")?.properties ?? {}).toSorted()).toEqual([
						"content",
						"created_at",
						"id",
						"seq",
						"truncated",
						"type",
					])
					expect(byType.get("agent.message")?.required?.toSorted()).toEqual([
						"content",
						"created_at",
						"id",
						"seq",
						"type",
					])
					expect(
						Object.keys(byType.get("span.model_request_start")?.properties ?? {}).toSorted(),
					).toEqual(["created_at", "id", "model_request_start_id", "seq", "type"])
					expect(
						Object.keys(byType.get("span.model_request_end")?.properties ?? {}).toSorted(),
					).toEqual([
						"created_at",
						"id",
						"is_error",
						"model_request_start_id",
						"model_usage",
						"seq",
						"type",
					])
					expect(Object.keys(byType.get("agent.thinking")?.properties ?? {}).toSorted()).toEqual([
						"created_at",
						"id",
						"seq",
						"thinking",
						"type",
					])
					expect(
						Object.keys(byType.get("session.status_idle")?.properties ?? {}).toSorted(),
					).toEqual(["created_at", "id", "seq", "stop_reason", "type"])
					expect(Object.keys(byType.get("session.error")?.properties ?? {}).toSorted()).toEqual([
						"created_at",
						"error",
						"id",
						"seq",
						"type",
					])
					for (const emptyTag of [
						"user.interrupt",
						"session.status_running",
						"session.status_terminated",
						"session.archived",
					]) {
						expect(Object.keys(byType.get(emptyTag)?.properties ?? {}).toSorted()).toEqual([
							"created_at",
							"id",
							"seq",
							"type",
						])
					}
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("maps every error envelope to its numeric HTTP status and rejects empty request IDs", () => {
		const requestId = RequestId.make("req_test_status_map")
		for (const status of [400, 401, 404, 409, 413, 415, 429, 500, 503] as const) {
			const envelope = apiError(status, "message", requestId)
			expect(statusOf(envelope)).toBe(status)
			expect(envelope.request_id).toBe(requestId)
		}
		expect(() => RequestId.make("")).toThrow(/Schema validation failed/)
		expect(
			toApiError(
				{ type: "error", error: { type: "conflict_error", message: "Conflict." } },
				requestId,
			),
		).toEqual({
			type: "error",
			error: { type: "conflict_error", message: "Conflict." },
			request_id: requestId,
		})
		expect(
			toApiError(
				{
					type: "error",
					error: { type: "conflict_error", message: "Conflict." },
					request_id: "req_stale_other_request",
				},
				requestId,
			),
		).toEqual({
			type: "error",
			error: { type: "conflict_error", message: "Conflict." },
			request_id: requestId,
		})
	})

	it("routes stored resource IDs according to each resource's advertised ID schema", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const createAgent = yield* CreateAgentDecision
					const environments = yield* Environment
					const sessions = yield* Session
					const agentViews = yield* AgentView
					const envViews = yield* EnvironmentView
					const sessionViews = yield* SessionView
					const { fetch: apiFetch } = yield* makeApiHandler

					const longAgentId = AgentId.make(`agent_${"a".repeat(MAX_IDENTIFIER_LENGTH - 6)}`)
					const extraLongAgentId = AgentId.make(`agent_${"b".repeat(MAX_IDENTIFIER_LENGTH + 20)}`)
					const longEnvId = EnvironmentId.make(`env_${"e".repeat(120)}`)
					const extraLongEnvId = EnvironmentId.make(`env_${"f".repeat(MAX_IDENTIFIER_LENGTH + 20)}`)
					const longSessionId = SessionId.make(`sess_${"s".repeat(MAX_IDENTIFIER_LENGTH - 5)}`)
					expect(longAgentId.length).toBe(MAX_IDENTIFIER_LENGTH)
					expect(extraLongAgentId.length).toBeGreaterThan(MAX_IDENTIFIER_LENGTH)
					expect(extraLongEnvId.length).toBeGreaterThan(MAX_IDENTIFIER_LENGTH)
					expect(longSessionId.length).toBe(MAX_IDENTIFIER_LENGTH)

					for (const [agentId, versionId] of [
						[longAgentId, AgentVersionId.make("aver_long_1")],
						[extraLongAgentId, AgentVersionId.make("aver_extra_long_1")],
					] as const) {
						yield* createAgent.send(
							new CreateAgent({
								agent_id: agentId,
								version_id: versionId,
								name: "Long ID Agent",
								model: { id: "gpt-4o-mini" },
								system: null,
								description: null,
							}),
						)
						yield* agentViews.waitFor(Agent.ref(agentId), { version: 1 }, { timeout: "2 seconds" })
					}

					for (const envId of [longEnvId, extraLongEnvId]) {
						yield* environments.send(
							new CreateEnvironment({
								environment_id: envId,
								name: "Long ID Env",
								description: null,
								config: { type: "cloud", networking: { type: "unrestricted" } },
							}),
						)
						yield* envViews.waitFor(
							Environment.ref(envId),
							{ version: 1 },
							{ timeout: "2 seconds" },
						)
					}

					yield* sessions.send(
						new CreateSession({
							session_id: longSessionId,
							agent_id: longAgentId,
							agent_version: 1,
							environment_id: longEnvId,
							title: "Long ID Session",
						}),
					)
					yield* sessionViews.waitFor(
						Session.ref(longSessionId),
						{ status: "idle" },
						{ timeout: "2 seconds" },
					)

					// Stored AgentId and EnvironmentId > 256 chars match their advertised schemas.
					for (const agentId of [longAgentId, extraLongAgentId]) {
						expect(
							(yield* sendRequest(apiFetch, {
								method: "GET",
								path: `/v1/agents/${agentId}`,
								headers: AUTH_HEADERS,
							})).status,
						).toBe(200)
						expect(
							(yield* sendRequest(apiFetch, {
								method: "POST",
								path: `/v1/agents/${agentId}`,
								headers: AUTH_HEADERS,
								body: { version: 1, name: "Updated Long ID Agent" },
							})).status,
						).toBe(200)
					}

					for (const envId of [longEnvId, extraLongEnvId]) {
						expect(
							(yield* sendRequest(apiFetch, {
								method: "GET",
								path: `/v1/environments/${envId}`,
								headers: AUTH_HEADERS,
							})).status,
						).toBe(200)
					}

					const getSession = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${longSessionId}`,
						headers: AUTH_HEADERS,
					})
					expect(getSession.status).toBe(200)

					// SessionId enforces its 256-char limit via parameter schema validation (400), not route 404.
					const oversizedSession = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${"s".repeat(MAX_IDENTIFIER_LENGTH + 1)}`,
						headers: AUTH_HEADERS,
					})
					expect(oversizedSession.status).toBe(400)
					expect(yield* Effect.promise(() => oversizedSession.json())).toMatchObject({
						type: "error",
						error: { type: "invalid_request_error" },
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("reports response encoding failures as generic 500 internal_error instead of 400", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realAgentViews = yield* AgentView
					const brokenAgentViews = {
						...realAgentViews,
						get: () =>
							Effect.succeed(
								Option.some({
									id: "agent_broken",
									type: "agent",
									version: 0, // Violates PositiveInt in AgentResource!
									name: "Broken",
									model: { id: "gpt-4o-mini" },
									system: null,
									description: null,
									created_at: "2026-01-01T00:00:00.000Z",
									updated_at: "2026-01-01T00:00:00.000Z",
									archived_at: null,
									current_version_id: "aver_broken",
								} as unknown as never),
							),
					} as unknown as typeof realAgentViews

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentView, brokenAgentViews),
					)
					const res = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/agent_broken",
						headers: AUTH_HEADERS,
					})
					expect(res.status).toBe(500)
					const body = (yield* Effect.promise(() => res.json())) as {
						type: string
						error: { type: string; message: string }
						request_id: string
					}
					expect(body).toEqual({
						type: "error",
						error: {
							type: "internal_error",
							message: "Internal server error.",
						},
						request_id: res.headers.get(REQUEST_ID_HEADER),
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("treats leading double-slash request targets as paths instead of authorities", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					const doubleSlash = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "//",
						headers: AUTH_HEADERS,
					})
					expect(doubleSlash.status).toBe(404)
					expect(yield* Effect.promise(() => doubleSlash.json())).toEqual({
						type: "error",
						error: {
							type: "not_found_error",
							message: "Route GET // not found.",
						},
						request_id: doubleSlash.headers.get(REQUEST_ID_HEADER),
					})

					const authorityLike = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "//evil.example/v1/unknown?x=1",
						headers: AUTH_HEADERS,
					})
					expect(authorityLike.status).toBe(404)
					expect(yield* Effect.promise(() => authorityLike.json())).toEqual({
						type: "error",
						error: {
							type: "not_found_error",
							message: "Route GET //evil.example/v1/unknown not found.",
						},
						request_id: authorityLike.headers.get(REQUEST_ID_HEADER),
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("ties the router layer lifetime to the caller's Scope across requests and runs finalizers on close", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const handlerScope = yield* Scope.make()
					expect(handlerScope.state._tag).toBe("Empty")

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(Scope.provide(handlerScope))

					// makeApiHandler acquired its router layer inside the caller's scope (Empty -> Open means
					// router finalizers are registered on handlerScope rather than an orphaned Scope.make()).
					expect(handlerScope.state._tag).toBe("Open")

					// Router stays alive across multiple requests while its owning scope is open.
					const first = yield* sendRequest(apiFetch, { method: "GET", path: "/health" })
					expect(first.status).toBe(200)
					expect(handlerScope.state._tag).toBe("Open")

					const second = yield* sendRequest(apiFetch, { method: "GET", path: "/health" })
					expect(second.status).toBe(200)
					expect(handlerScope.state._tag).toBe("Open")

					yield* Scope.close(handlerScope, Exit.void)
					expect(handlerScope.state._tag).toBe("Closed")
				}).pipe(Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("sets Cache-Control: no-store on protected responses without altering /health or /openapi.json", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const apiKeyHeaders = { "x-api-key": TEST_API_KEY }

					// Public routes retain their own cache policy (not forced to no-store).
					const healthRes = yield* sendRequest(apiFetch, { method: "GET", path: "/health" })
					expect(healthRes.status).toBe(200)
					expect(healthRes.headers.get("cache-control")).toBeNull()

					const openapiRes = yield* sendRequest(apiFetch, { method: "GET", path: "/openapi.json" })
					expect(openapiRes.status).toBe(200)
					expect(openapiRes.headers.get("cache-control")).toBeNull()

					// Protected JSON and SSE routes authenticated via x-api-key MUST include no-store.
					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: apiKeyHeaders,
						body: { name: "Cache Test Agent", model: "gpt-4o-mini" },
					})
					expect(agentRes.headers.get("cache-control")).toBe("no-store")
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const getAgentRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/agents/${agent.id}`,
						headers: apiKeyHeaders,
					})
					expect(getAgentRes.status).toBe(200)
					expect(getAgentRes.headers.get("cache-control")).toBe("no-store")

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: apiKeyHeaders,
						body: { name: "Cache Test Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const getEnvRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/environments/${env.id}`,
						headers: apiKeyHeaders,
					})
					expect(getEnvRes.status).toBe(200)
					expect(getEnvRes.headers.get("cache-control")).toBe("no-store")

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: apiKeyHeaders,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					const getSessRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}`,
						headers: apiKeyHeaders,
					})
					expect(getSessRes.status).toBe(200)
					expect(getSessRes.headers.get("cache-control")).toBe("no-store")

					const listEventsRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events`,
						headers: apiKeyHeaders,
					})
					expect(listEventsRes.status).toBe(200)
					expect(listEventsRes.headers.get("cache-control")).toBe("no-store")

					const streamRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: apiKeyHeaders,
					})
					expect(streamRes.status).toBe(200)
					expect(streamRes.headers.get("cache-control")).toContain("no-store")
					yield* Effect.promise(() => streamRes.body?.cancel() ?? Promise.resolve())
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("returns a unique request-id header on every response, echoes it in error bodies and /openapi.json, and ignores caller-supplied IDs", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realAgentViews = yield* AgentView
					let failMode: "none" | "defect" | "error" = "none"
					const flakyAgentViews = {
						...realAgentViews,
						get: (
							ref: Parameters<typeof realAgentViews.get>[0],
							options?: Parameters<typeof realAgentViews.get>[1],
						) =>
							failMode === "defect"
								? Effect.die(new Error("simulated agent view crash"))
								: failMode === "error"
									? Effect.fail(new Error("simulated agent view failure") as unknown as never)
									: realAgentViews.get(ref, options),
					} as unknown as typeof realAgentViews

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentView, flakyAgentViews),
					)

					const seenIds = new Set<string>()
					const expectRequestId = (res: Response): string => {
						const id = res.headers.get(REQUEST_ID_HEADER)
						expect(id).toMatch(/^req_[0-9a-f]{24}$/)
						expect(seenIds.has(id!)).toBe(false)
						seenIds.add(id!)
						return id!
					}

					const health1 = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/health",
						headers: { [REQUEST_ID_HEADER]: "req_caller_supplied", "x-request-id": "req_caller_x" },
					})
					expect(health1.status).toBe(200)
					const healthId1 = expectRequestId(health1)
					expect(healthId1).not.toBe("req_caller_supplied")
					expect(healthId1).not.toBe("req_caller_x")

					const health2 = yield* sendRequest(apiFetch, { method: "GET", path: "/health" })
					expect(health2.status).toBe(200)
					expectRequestId(health2)

					const openapi1 = yield* sendRequest(apiFetch, { method: "GET", path: "/openapi.json" })
					expect(openapi1.status).toBe(200)
					expectRequestId(openapi1)
					const spec = (yield* Effect.promise(() => openapi1.json())) as {
						paths: Record<
							string,
							Record<
								string,
								{
									responses?: Record<
										string,
										{
											content?: {
												"application/json"?: {
													schema?: {
														properties?: Record<string, unknown>
														required?: ReadonlyArray<string>
													}
												}
											}
										}
									>
								}
							>
						>
					}
					const agentGetResponses = spec.paths["/v1/agents/{agent_id}"]?.get?.responses
					for (const status of ["400", "401", "404", "500"]) {
						const errorSchema = agentGetResponses?.[status]?.content?.["application/json"]?.schema
						expect(errorSchema?.properties).toHaveProperty("request_id")
						expect(errorSchema?.required).toContain("request_id")
					}

					const openapi2 = yield* sendRequest(apiFetch, { method: "GET", path: "/openapi.json" })
					expect(openapi2.status).toBe(200)
					expectRequestId(openapi2)

					const unauthedRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/agent_missing",
					})
					expect(unauthedRes.status).toBe(401)
					const unauthedId = expectRequestId(unauthedRes)
					const unauthedBody = (yield* Effect.promise(() => unauthedRes.json())) as {
						request_id: string
					}
					expect(unauthedBody.request_id).toBe(unauthedId)

					const missingRouteRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/does-not-exist",
						headers: AUTH_HEADERS,
					})
					expect(missingRouteRes.status).toBe(404)
					const missingRouteId = expectRequestId(missingRouteRes)
					const missingRouteBody = (yield* Effect.promise(() => missingRouteRes.json())) as {
						request_id: string
					}
					expect(missingRouteBody.request_id).toBe(missingRouteId)

					const missingAgentRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/agent_missing",
						headers: AUTH_HEADERS,
					})
					expect(missingAgentRes.status).toBe(404)
					const missingAgentId = expectRequestId(missingAgentRes)
					const missingAgentBody = (yield* Effect.promise(() => missingAgentRes.json())) as {
						request_id: string
					}
					expect(missingAgentBody.request_id).toBe(missingAgentId)

					const badMediaRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "content-type": "text/plain" },
						body: { name: "Agent", model: "gpt-4o-mini" },
					})
					expect(badMediaRes.status).toBe(415)
					const badMediaId = expectRequestId(badMediaRes)
					const badMediaBody = (yield* Effect.promise(() => badMediaRes.json())) as {
						request_id: string
					}
					expect(badMediaBody.request_id).toBe(badMediaId)

					failMode = "defect"
					const defectRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/agent_boom",
						headers: AUTH_HEADERS,
					})
					expect(defectRes.status).toBe(500)
					const defectId = expectRequestId(defectRes)
					const defectBody = (yield* Effect.promise(() => defectRes.json())) as {
						request_id: string
					}
					expect(defectBody.request_id).toBe(defectId)

					failMode = "error"
					const errorRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/agent_boom",
						headers: AUTH_HEADERS,
					})
					expect(errorRes.status).toBe(500)
					const errorId = expectRequestId(errorRes)
					const errorBody = (yield* Effect.promise(() => errorRes.json())) as {
						request_id: string
					}
					expect(errorBody.request_id).toBe(errorId)
					failMode = "none"

					const session = yield* createIdleSession(apiFetch)
					const streamRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					expect(streamRes.status).toBe(200)
					expect(streamRes.headers.get("content-type")).toContain("text/event-stream")
					expectRequestId(streamRes)
					yield* Effect.promise(() => streamRes.body?.cancel() ?? Promise.resolve())

					const archiveRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(archiveRes.status).toBe(200)
					expectRequestId(archiveRes)

					const noContentRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream?after=999`,
						headers: AUTH_HEADERS,
					})
					expect(noContentRes.status).toBe(204)
					expectRequestId(noContentRes)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("attaches the request_id annotation to every log line emitted while handling a request", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		const logs: Array<{
			readonly message: unknown
			readonly annotations: Readonly<Record<string, unknown>>
		}> = []
		const captureLogger = Logger.layer([
			Logger.make(({ message, fiber }) => {
				logs.push({
					message,
					annotations: fiber.getRef(References.CurrentLogAnnotations),
				})
			}),
		])
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realAgentViews = yield* AgentView
					let mode:
						| "normal"
						| "router-defect"
						| "handler-error"
						| "conflict-without-request-id"
						| "conflict-with-stale-request-id"
						| "read-after-commit-defect" = "normal"
					const instrumentedAgentViews = {
						...realAgentViews,
						get: (
							ref: Parameters<typeof realAgentViews.get>[0],
							options?: Parameters<typeof realAgentViews.get>[1],
						) => {
							if (mode === "router-defect") return Effect.die(new Error("router defect"))
							if (mode === "handler-error") {
								return Effect.fail(new Error("handler error") as unknown as never)
							}
							if (mode === "conflict-without-request-id") {
								return Effect.fail({
									type: "error",
									error: { type: "conflict_error", message: "Version conflict." },
								} as unknown as never)
							}
							if (mode === "conflict-with-stale-request-id") {
								return Effect.fail({
									type: "error",
									error: { type: "conflict_error", message: "Stale version conflict." },
									request_id: "req_stale_other_request",
								} as unknown as never)
							}
							if (mode === "read-after-commit-defect") {
								return Effect.die(new Error("read after commit crash"))
							}
							return realAgentViews.get(ref, options)
						},
					} as unknown as typeof realAgentViews

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentView, instrumentedAgentViews),
						Effect.annotateLogs({ service: "checkfu-api", request_id: "req_build_stale" }),
					)

					mode = "router-defect"
					logs.length = 0
					const routerCrash = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/agent_crash",
						headers: AUTH_HEADERS,
					})
					expect(routerCrash.status).toBe(500)
					const routerCrashId = routerCrash.headers.get(REQUEST_ID_HEADER)
					expect(routerCrashId).toMatch(/^req_[0-9a-f]{24}$/)
					expect(routerCrashId).not.toBe("req_build_stale")
					expect(
						logs.some((entry) => JSON.stringify(entry.message).includes("Unhandled API failure")),
					).toBe(true)
					expect(
						logs.every(
							(entry) =>
								entry.annotations.request_id === routerCrashId &&
								entry.annotations.service === "checkfu-api",
						),
					).toBe(true)

					mode = "handler-error"
					logs.length = 0
					const handlerCrash = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/agent_err",
						headers: AUTH_HEADERS,
					}).pipe(Effect.annotateLogs({ caller: "edge", request_id: "req_caller_stale" }))
					expect(handlerCrash.status).toBe(500)
					const handlerCrashId = handlerCrash.headers.get(REQUEST_ID_HEADER)
					expect(handlerCrashId).toMatch(/^req_[0-9a-f]{24}$/)
					expect(handlerCrashId).not.toBe(routerCrashId)
					expect(handlerCrashId).not.toBe("req_caller_stale")
					expect(
						logs.some((entry) => JSON.stringify(entry.message).includes("Unhandled API failure")),
					).toBe(true)
					expect(
						logs.every(
							(entry) =>
								entry.annotations.request_id === handlerCrashId &&
								entry.annotations.service === "checkfu-api" &&
								entry.annotations.caller === "edge",
						),
					).toBe(true)

					mode = "conflict-without-request-id"
					const conflictRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/agent_conflict",
						headers: AUTH_HEADERS,
					})
					expect(conflictRes.status).toBe(409)
					const conflictId = conflictRes.headers.get(REQUEST_ID_HEADER)
					expect(conflictId).toMatch(/^req_[0-9a-f]{24}$/)
					expect(yield* Effect.promise(() => conflictRes.json())).toEqual({
						type: "error",
						error: { type: "conflict_error", message: "Version conflict." },
						request_id: conflictId,
					})

					mode = "conflict-with-stale-request-id"
					const staleConflictRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/agent_conflict_stale",
						headers: AUTH_HEADERS,
					})
					expect(staleConflictRes.status).toBe(409)
					const staleConflictId = staleConflictRes.headers.get(REQUEST_ID_HEADER)
					expect(staleConflictId).toMatch(/^req_[0-9a-f]{24}$/)
					expect(staleConflictId).not.toBe("req_stale_other_request")
					expect(yield* Effect.promise(() => staleConflictRes.json())).toEqual({
						type: "error",
						error: { type: "conflict_error", message: "Stale version conflict." },
						request_id: staleConflictId,
					})

					mode = "read-after-commit-defect"
					logs.length = 0
					const pendingRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Pending Agent", model: "gpt-4o-mini" },
					})
					expect(pendingRes.status).toBe(202)
					const pendingId = pendingRes.headers.get(REQUEST_ID_HEADER)
					expect(pendingId).toMatch(/^req_[0-9a-f]{24}$/)
					expect(
						logs.some((entry) =>
							JSON.stringify(entry.message).includes("Read after commit failed"),
						),
					).toBe(true)
					expect(
						logs.every(
							(entry) =>
								entry.annotations.request_id === pendingId &&
								entry.annotations.service === "checkfu-api",
						),
					).toBe(true)
				}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layer, captureLogger))),
			)
		} finally {
			await closeAll()
		}
	})
})
