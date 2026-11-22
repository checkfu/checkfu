import * as Domain from "@alchemy.run/domain"
import { Agent } from "@checkfu/agents/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/agents/Agent/AgentVersion.id"
import { AgentVersionByNumberView } from "@checkfu/agents/Agent/AgentVersionByNumberView.view"
import { AgentView } from "@checkfu/agents/Agent/AgentView.view"
import { CreateAgent } from "@checkfu/agents/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/agents/Agent/CreateAgent.decision"
import { UpdateAgent } from "@checkfu/agents/Agent/UpdateAgent.command"
import { UpdateAgentDecision } from "@checkfu/agents/Agent/UpdateAgent.decision"
import { DeleteEnvironment } from "@checkfu/environments/Environment/DeleteEnvironment.command"
import { Environment } from "@checkfu/environments/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import { EnvironmentView } from "@checkfu/environments/Environment/EnvironmentView.view"
import { UpdateEnvironment } from "@checkfu/environments/Environment/UpdateEnvironment.command"
import { ModelProvider } from "@checkfu/sessions/Session/ModelProvider.external"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { SessionView } from "@checkfu/sessions/Session/SessionView.view"
import { SessionsHandlersLive } from "@checkfu/sessions/Sessions.model"
import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Checkfu } from "../src/Checkfu.model.ts"
import {
	AgentVersionWaitTimeout,
	EnvironmentPartialUpdateWaitTimeout,
	makeApiHandler,
} from "../src/Http/Router.ts"
import {
	AgentVersionLookupTimeout,
	HarnessCallFailed,
	HarnessLimits,
	PiDurableModelProviderLive,
	conversationName,
	makePiTurnExecutorLayer,
} from "../src/Pi/PiDurableModelProvider.ts"
import {
	type PiTurnRequest,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../src/Pi/PiDurableEngine.ts"
import {
	AUTH_HEADERS,
	TEST_API_KEY,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	makeScriptedPiModels,
	providerError,
	readSseUntil,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

describe("Agent and environment lifecycle, versioning, and projection consistency", () => {
	it("resolves arbitrary stored AgentVersionIds (not synthetic agentId:vN) and rejects missing/archived resources", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model, context) =>
			makeAssistantReply(model, null, `CustomVersion: ${extractLastUserText(context)}`, 4, 2),
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const createAgent = yield* CreateAgentDecision

					// Create an agent directly through the domain with an independent version_id ("aver_custom_001")
					const customAgentId = AgentId.make("agent_custom_001")
					const customVersionId = AgentVersionId.make("aver_custom_001")
					yield* createAgent.send(
						new CreateAgent({
							agent_id: customAgentId,
							version_id: customVersionId,
							name: "Custom Version Agent",
							model: { id: "anthropic/claude-sonnet-4-5" },
							system: "Custom system prompt.",
							description: null,
						}),
					)

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Custom Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					// Create session pinning explicit version 1 against the custom-version-id agent
					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: {
							agent: { id: customAgentId, version: 1 },
							environment_id: env.id,
						},
					})
					expect(sessRes.status).toBe(201)
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					const streamRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "Ping" }] }],
						},
					})
					const frames = yield* Effect.promise(() =>
						readSseUntil(streamRes, (evt) => evt.type === "session.status_idle"),
					)
					expect(frames.find((f) => f.event === "agent.message")?.data.content).toEqual([
						{ type: "text", text: "CustomVersion: Ping" },
					])

					// Delete environment -> immediate GET returns 404 (read-your-writes)
					const delRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: `/v1/environments/${env.id}`,
						headers: AUTH_HEADERS,
					})
					expect(delRes.status).toBe(200)
					const getDelRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/environments/${env.id}`,
						headers: AUTH_HEADERS,
					})
					expect(getDelRes.status).toBe(404)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("uses committed resource states to admit a session while the head views lag", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 0, 0),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch } = yield* makeApiHandler
					const write = (method: string, path: string, body?: unknown) =>
						sendRequest(fetch, { method, path, body, headers: AUTH_HEADERS })
					const agentResponse = yield* write("POST", "/v1/agents", {
						name: "Agent",
						model: "gpt-4o-mini",
					})
					const agent = (yield* Effect.promise(() => agentResponse.json())) as { id: string }
					const envResponse = yield* write("POST", "/v1/environments", { name: "Env" })
					const env = (yield* Effect.promise(() => envResponse.json())) as { id: string }

					const agents = yield* AgentView
					const environments = yield* EnvironmentView
					const initialAgent = yield* agents.get(Agent.ref(AgentId.make(agent.id)))
					const initialEnvironment = yield* environments.get(
						Environment.ref(EnvironmentId.make(env.id)),
					)
					const lagging = yield* makeApiHandler.pipe(
						Effect.provideService(AgentView, {
							...agents,
							get: () => Effect.succeed(initialAgent),
						}),
						Effect.provideService(EnvironmentView, {
							...environments,
							get: (ref, options) =>
								ref.id === env.id
									? Effect.succeed(initialEnvironment)
									: environments.get(ref, options),
						}),
					)
					const create = (environmentId: string) =>
						sendRequest(lagging.fetch, {
							method: "POST",
							path: "/v1/sessions",
							headers: AUTH_HEADERS,
							body: { agent: agent.id, environment_id: environmentId },
						})

					expect(
						(yield* write("POST", `/v1/agents/${agent.id}`, { version: 1, name: "Updated" }))
							.status,
					).toBe(200)
					const created = yield* create(env.id)
					expect(created.status).toBe(201)
					expect(yield* Effect.promise(() => created.json())).toMatchObject({
						agent: { id: agent.id, version: 2 },
					})
					expect((yield* write("POST", `/v1/environments/${env.id}/archive`)).status).toBe(200)
					expect((yield* create(env.id)).status).toBe(409)
					expect((yield* write("DELETE", `/v1/environments/${env.id}`)).status).toBe(200)
					expect((yield* create(env.id)).status).toBe(404)
					expect((yield* write("POST", `/v1/agents/${agent.id}/archive`)).status).toBe(200)
					const otherEnv = yield* write("POST", "/v1/environments", { name: "Active environment" })
					const active = (yield* Effect.promise(() => otherEnv.json())) as { id: string }
					expect((yield* create(active.id)).status).toBe(409)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("honors top-level agent_version with object agent refs", async () => {
		const seenContexts: Array<ReadonlyArray<{ readonly role: string; readonly text: string }>> = []

		const { layer, closeAll } = makePiDurableTestLayer(async (model, context) => {
			seenContexts.push(
				context.messages
					.filter((m) => m.role === "user" || m.role === "assistant")
					.map((m) => ({
						role: m.role,
						text:
							typeof m.content === "string"
								? m.content
								: m.content.map((p) => (p.type === "text" ? p.text : "")).join(""),
					})),
			)
			return makeAssistantReply(model, null, "Seeded reply", 10, 5)
		})

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const provider = yield* ModelProvider

					// Create agent v1 -> update to v2
					const v1Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Versioned", model: "gpt-4o-mini", system: "V1 prompt" },
					})
					const agentV1 = (yield* Effect.promise(() => v1Res.json())) as { id: string }

					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agentV1.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, system: "V2 prompt" },
					})

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					// Conflicting nested + top-level version -> 400
					const conflictRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: {
							agent: { id: agentV1.id, version: 1 },
							agent_version: 2,
							environment_id: env.id,
						},
					})
					expect(conflictRes.status).toBe(400)

					// Object agent ref without nested version + top-level agent_version: 1 -> pins v1!
					const pinnedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: {
							agent: { id: agentV1.id },
							agent_version: 1,
							environment_id: env.id,
						},
					})
					expect(pinnedRes.status).toBe(201)
					const pinnedSession = (yield* Effect.promise(() => pinnedRes.json())) as {
						id: string
						agent: { id: string; version: number }
					}
					expect(pinnedSession.agent).toEqual({ id: agentV1.id, version: 1 })

					const reply = yield* provider.generate({
						session_id: SessionId.make("sess_pinned_version"),
						agent_id: agentV1.id,
						agent_version: 1,
						environment_id: env.id,
						turn: 1,
						generation: 0,
						input: ["New question"],
					})
					expect(reply.text).toBe("Seeded reply")
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}

		expect(seenContexts).toEqual([[{ role: "user", text: "New question" }]])
	})

	it("returns 202 with the committed id when the view lags behind a create", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const views = yield* AgentView
					const lagging: typeof views = {
						...views,
						get: (ref, options) =>
							options?.atLeast === undefined
								? views.get(ref, options)
								: Effect.fail(
										new Domain.ConsistencyTimeout({
											view: "AgentView",
											key: ref.id,
											stream: options.atLeast.stream,
											version: options.atLeast.version,
										}),
									),
					}
					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentView, lagging),
					)
					const created = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Lagging Agent", model: "gpt-4o-mini" },
					})
					expect(created.status).toBe(202)
					const body = (yield* Effect.promise(() => created.json())) as {
						id: string
						type: string
						pending: boolean
					}
					expect(body).toEqual({ id: body.id, type: "agent", pending: true })

					yield* views.waitFor(
						Agent.ref(AgentId.make(body.id)),
						{ version: 1 },
						{ timeout: "2 seconds" },
					)
					const fetched = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/agents/${body.id}`,
						headers: AUTH_HEADERS,
					})
					expect(fetched.status).toBe(200)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("returns 202 with the committed id when the read after a create fails outright", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const views = yield* AgentView
					const broken: typeof views = {
						...views,
						get: (ref, options) =>
							options?.atLeast === undefined
								? views.get(ref, options)
								: Effect.die(new Error("view object unavailable")),
					}
					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentView, broken),
					)
					const created = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Unreadable Agent", model: "gpt-4o-mini" },
					})
					expect(created.status).toBe(202)
					const body = (yield* Effect.promise(() => created.json())) as { id: string }
					expect(body).toEqual({ id: body.id, type: "agent", pending: true })
					expect(body.id).toMatch(/^agent_/)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("checks agent and environment update versions against committed state even when views lag", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realAgentViews = yield* AgentView
					const realEnvViews = yield* EnvironmentView
					const agents = yield* Agent
					const environments = yield* Environment

					// Simulate AgentView lagging completely (always missing / returning ConsistencyTimeout).
					const laggingAgentViews: typeof realAgentViews = {
						...realAgentViews,
						get: (ref, options) =>
							options?.atLeast === undefined
								? Effect.succeed(Option.none())
								: Effect.fail(
										new Domain.ConsistencyTimeout({
											view: "AgentView",
											key: ref.id,
											stream: options.atLeast.stream,
											version: options.atLeast.version,
										}),
									),
					}
					// Simulate EnvironmentView returning empty on initial `get`, while `waitFor` catches up.
					let envGetCalls = 0
					const laggingEnvViews: typeof realEnvViews = {
						...realEnvViews,
						get: (ref, options) => {
							if (options?.atLeast !== undefined) {
								return Effect.fail(
									new Domain.ConsistencyTimeout({
										view: "EnvironmentView",
										key: ref.id,
										stream: options.atLeast.stream,
										version: options.atLeast.version,
									}),
								)
							}
							envGetCalls += 1
							return envGetCalls === 1 ? Effect.succeed(Option.none()) : realEnvViews.get(ref)
						},
					}

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentView, laggingAgentViews),
						Effect.provideService(EnvironmentView, laggingEnvViews),
					)

					// 1. Agent create returns 202 Pending; follow-up partial update with version 1 MUST NOT 404/409.
					const createdAgent = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: {
							name: "Lagging Agent",
							model: "gpt-4o-mini",
							system: "Keep this system prompt",
						},
					})
					expect(createdAgent.status).toBe(202)
					const { id: agentId } = (yield* Effect.promise(() => createdAgent.json())) as {
						id: string
					}

					const updatedAgent = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agentId}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Renamed While Lagging" },
					})
					expect(updatedAgent.status).toBe(202)
					const agentState = yield* agents.get(AgentId.make(agentId))
					expect(agentState.version).toBe(2)
					expect(agentState.name).toBe("Renamed While Lagging")
					expect(agentState.model_id).toBe("gpt-4o-mini")
					expect(agentState.system).toBe("Keep this system prompt")

					// Stale version after the committed v2 update must return 409.
					const staleAgent = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agentId}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Stale" },
					})
					expect(staleAgent.status).toBe(409)

					// 2. Environment create returns 202 Pending; partial update waits for v1 instead of false 404.
					const createdEnv = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: {
							name: "Lagging Env",
							description: "Preserve description",
						},
					})
					expect(createdEnv.status).toBe(202)
					const { id: envId } = (yield* Effect.promise(() => createdEnv.json())) as { id: string }

					const updatedEnv = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${envId}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Renamed Env" },
					})
					expect(updatedEnv.status).toBe(202)
					const envState = yield* environments.get(EnvironmentId.make(envId))
					expect(envState.version).toBe(2)
					expect(envState.name).toBe("Renamed Env")
					const projectedEnv = yield* realEnvViews.waitFor(
						Environment.ref(EnvironmentId.make(envId)),
						{ version: 2 },
						{ timeout: "2 seconds" },
					)
					expect(projectedEnv?.description).toBe("Preserve description")
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("reports 404 instead of 500 when an environment is deleted right after an update commits", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const environments = yield* Environment
					const realEnvViews = yield* EnvironmentView

					let deleteOnNextAtLeast = false
					const racingEnvViews = {
						...realEnvViews,
						get: (
							ref: Parameters<typeof realEnvViews.get>[0],
							options?: Parameters<typeof realEnvViews.get>[1],
						) =>
							Effect.gen(function* () {
								if (deleteOnNextAtLeast && options?.atLeast !== undefined) {
									deleteOnNextAtLeast = false
									const delReceipt = yield* environments.send(
										new DeleteEnvironment({ environment_id: ref.id }),
									)
									return yield* realEnvViews.get(ref, { atLeast: delReceipt })
								}
								return yield* realEnvViews.get(ref, options)
							}),
					} as unknown as typeof realEnvViews

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(EnvironmentView, racingEnvViews),
					)
					const createRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Ephemeral Env" },
					})
					expect(createRes.status).toBe(201)
					const env = (yield* Effect.promise(() => createRes.json())) as { id: string }

					deleteOnNextAtLeast = true
					const updateRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${env.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Updated Before Delete" },
					})
					expect(updateRes.status).toBe(404)
					expect(yield* Effect.promise(() => updateRes.json())).toEqual({
						type: "error",
						error: {
							type: "not_found_error",
							message: `Environment ${env.id} was deleted after the update committed.`,
						},
					})
					const finalState = yield* environments.get(EnvironmentId.make(env.id))
					expect(finalState.status).toBe("deleted")
					expect(finalState.version).toBe(2)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("rechecks deletion when a partial environment update times out waiting for the view", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const environments = yield* Environment
					const realEnvViews = yield* EnvironmentView

					let simulateDeleteDuringWait = false
					let waitForTimedOut = false
					const racingEnvViews = {
						...realEnvViews,
						get: (
							ref: Parameters<typeof realEnvViews.get>[0],
							options?: Parameters<typeof realEnvViews.get>[1],
						) =>
							simulateDeleteDuringWait && options?.atLeast === undefined
								? Effect.succeed(Option.none())
								: realEnvViews.get(ref, options),
						waitFor: (
							ref: Parameters<typeof realEnvViews.waitFor>[0],
							predicate: Parameters<typeof realEnvViews.waitFor>[1],
							options: Parameters<typeof realEnvViews.waitFor>[2],
						) =>
							Effect.gen(function* () {
								if (simulateDeleteDuringWait) {
									simulateDeleteDuringWait = false
									// Delete concurrently and project the tombstone before waiting so waitFor
									// actually hits WaitTimeout on the absent view rather than matching stale v1.
									const delReceipt = yield* environments.send(
										new DeleteEnvironment({ environment_id: ref.id }),
									)
									yield* realEnvViews.get(ref, { atLeast: delReceipt })
								}
								return yield* realEnvViews.waitFor(ref, predicate, options).pipe(
									Effect.tapError(() =>
										Effect.sync(() => {
											waitForTimedOut = true
										}),
									),
								)
							}),
					} as unknown as typeof realEnvViews

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(EnvironmentView, racingEnvViews),
						Effect.provideService(EnvironmentPartialUpdateWaitTimeout, "40 millis"),
					)
					const createRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Deleted During Wait Env" },
					})
					expect(createRes.status).toBe(201)
					const env = (yield* Effect.promise(() => createRes.json())) as { id: string }

					simulateDeleteDuringWait = true
					const updateRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${env.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Partial Rename" },
					})
					expect(updateRes.status).toBe(404)
					expect(waitForTimedOut).toBe(true)
					expect(yield* Effect.promise(() => updateRes.json())).toEqual({
						type: "error",
						error: {
							type: "not_found_error",
							message: `Environment ${env.id} not found.`,
						},
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("returns the exact agent version committed by an update even when a newer version lands before reading AgentView", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const updateAgent = yield* UpdateAgentDecision
					const realAgentViews = yield* AgentView

					let raceVersion3OnNextAtLeast = false
					const racingAgentViews = {
						...realAgentViews,
						get: (
							ref: Parameters<typeof realAgentViews.get>[0],
							options?: Parameters<typeof realAgentViews.get>[1],
						) =>
							Effect.gen(function* () {
								if (raceVersion3OnNextAtLeast && options?.atLeast !== undefined) {
									raceVersion3OnNextAtLeast = false
									// Writer B commits version 3 before Writer A reads AgentView for version 2.
									const v3Receipt = yield* updateAgent.send(
										new UpdateAgent({
											agent_id: ref.id,
											expected_version: 2,
											next_version_id: AgentVersionId.make("aver_writer_b_v3"),
											name: "Writer B v3",
											model: { id: "gpt-4o" },
											system: "System B",
											description: "Desc B",
										}),
									)
									const v3Commit = v3Receipt.commits.find(
										(commit) => commit.stream === `Agent/${ref.id}`,
									)
									return yield* realAgentViews.get(
										ref,
										v3Commit === undefined ? {} : { atLeast: v3Commit },
									)
								}
								return yield* realAgentViews.get(ref, options)
							}),
					} as unknown as typeof realAgentViews

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentView, racingAgentViews),
					)
					const createRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Original v1", model: "gpt-4o-mini", system: "System 1" },
					})
					expect(createRes.status).toBe(201)
					const created = (yield* Effect.promise(() => createRes.json())) as {
						id: string
						created_at: string
					}

					// Writer A updates v1 -> v2 while Writer B concurrently commits v2 -> v3.
					raceVersion3OnNextAtLeast = true
					const updateRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${created.id}`,
						headers: AUTH_HEADERS,
						body: {
							version: 1,
							name: "Writer A v2",
							model: "gpt-4o-mini",
							system: "System A",
							description: "Desc A",
						},
					})
					expect(updateRes.status).toBe(200)
					const updated = (yield* Effect.promise(() => updateRes.json())) as {
						id: string
						version: number
						name: string
						model: { id: string }
						system: string | null
						description: string | null
						created_at: string
					}
					expect(updated).toMatchObject({
						id: created.id,
						version: 2,
						name: "Writer A v2",
						model: { id: "gpt-4o-mini" },
						system: "System A",
						description: "Desc A",
						created_at: created.created_at,
					})

					// Head AgentView really is at Writer B's version 3.
					const headRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/agents/${created.id}`,
						headers: AUTH_HEADERS,
					})
					expect(headRes.status).toBe(200)
					expect(yield* Effect.promise(() => headRes.json())).toMatchObject({
						version: 3,
						name: "Writer B v3",
						model: { id: "gpt-4o" },
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("requires at least one agent reference in CreateSessionBody and OpenAPI schema", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					// OpenAPI schema for POST /v1/sessions must require either `agent` or `agent_id`.
					const openapiRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/openapi.json",
					})
					expect(openapiRes.status).toBe(200)
					const spec = (yield* Effect.promise(() => openapiRes.json())) as {
						paths: Record<
							string,
							{
								post?: {
									requestBody?: {
										content?: {
											"application/json"?: {
												schema?: { anyOf?: ReadonlyArray<{ required?: ReadonlyArray<string> }> }
											}
										}
									}
								}
							}
						>
					}
					const sessionBodySchema =
						spec.paths["/v1/sessions"]?.post?.requestBody?.content?.["application/json"]?.schema
					const requiredSets = (sessionBodySchema?.anyOf ?? []).map(
						(branch) => branch.required ?? [],
					)
					expect(requiredSets.length).toBeGreaterThanOrEqual(2)
					expect(
						requiredSets.every(
							(req) =>
								req.includes("environment_id") &&
								(req.includes("agent") || req.includes("agent_id")),
						),
					).toBe(true)

					// Missing both agent and agent_id fails request validation with 400.
					const missingAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { environment_id: "env_only" },
					})
					expect(missingAgentRes.status).toBe(400)
					expect(yield* Effect.promise(() => missingAgentRes.json())).toMatchObject({
						type: "error",
						error: { type: "invalid_request_error" },
					})

					// Conflicting agent and agent_id still fails with 400 conflict message.
					const conflictRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: "agent_1", agent_id: "agent_2", environment_id: "env_1" },
					})
					expect(conflictRes.status).toBe(400)
					expect(yield* Effect.promise(() => conflictRes.json())).toMatchObject({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: "Conflicting agent and agent_id values.",
						},
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("returns 202 pending instead of another writer's version when a newer environment update lands before reading EnvironmentView", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const environments = yield* Environment
					const realEnvViews = yield* EnvironmentView

					let raceVersion3OnNextAtLeast = false
					const racingEnvViews = {
						...realEnvViews,
						get: (
							ref: Parameters<typeof realEnvViews.get>[0],
							options?: Parameters<typeof realEnvViews.get>[1],
						) =>
							Effect.gen(function* () {
								if (raceVersion3OnNextAtLeast && options?.atLeast !== undefined) {
									raceVersion3OnNextAtLeast = false
									// Writer B commits version 3 before Writer A reads EnvironmentView for version 2.
									const v3Receipt = yield* environments.send(
										new UpdateEnvironment({
											environment_id: ref.id,
											expected_version: 2,
											name: "Writer B Env v3",
											description: "Desc B",
											config: { type: "cloud", networking: { type: "unrestricted" } },
										}),
									)
									return yield* realEnvViews.get(ref, { atLeast: v3Receipt })
								}
								return yield* realEnvViews.get(ref, options)
							}),
					} as unknown as typeof realEnvViews

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(EnvironmentView, racingEnvViews),
					)
					const createRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Original Env v1", description: "Desc 1" },
					})
					expect(createRes.status).toBe(201)
					const created = (yield* Effect.promise(() => createRes.json())) as {
						id: string
						created_at: string
					}

					// Writer A updates v1 -> v2 while Writer B concurrently commits v2 -> v3.
					// EnvironmentView only stores head (now v3), so returning v2 with a fabricated
					// timestamp or leaking v3 would both be wrong; return 202 pending instead.
					raceVersion3OnNextAtLeast = true
					const updateRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${created.id}`,
						headers: AUTH_HEADERS,
						body: {
							version: 1,
							name: "Writer A Env v2",
							description: "Desc A",
							config: { type: "cloud", networking: { type: "unrestricted" } },
						},
					})
					expect(updateRes.status).toBe(202)
					expect(yield* Effect.promise(() => updateRes.json())).toEqual({
						id: created.id,
						type: "environment",
						pending: true,
					})

					// Head EnvironmentView really is at Writer B's version 3.
					const headRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/environments/${created.id}`,
						headers: AUTH_HEADERS,
					})
					expect(headRes.status).toBe(200)
					expect(yield* Effect.promise(() => headRes.json())).toMatchObject({
						version: 3,
						name: "Writer B Env v3",
						description: "Desc B",
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("waits for the existing version or returns 202 pending on a no-op agent update when AgentVersionByNumberView lags", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realVersionsByNumber = yield* AgentVersionByNumberView
					let lagMode: "off" | "recover" | "timeout" = "off"
					let waitCalls = 0
					const seenAtLeastWhenLagging: Array<unknown> = []
					const laggingVersionsByNumber = {
						...realVersionsByNumber,
						get: (
							key: Parameters<typeof realVersionsByNumber.get>[0],
							options?: Parameters<typeof realVersionsByNumber.get>[1],
						) => {
							if (lagMode !== "off") {
								// No-op update must NOT pass an atLeast checkpoint for an unminted nextVersionId.
								seenAtLeastWhenLagging.push(options?.atLeast)
								return Effect.succeed(Option.none())
							}
							return realVersionsByNumber.get(key, options)
						},
						waitFor: (
							key: Parameters<typeof realVersionsByNumber.waitFor>[0],
							filter: Parameters<typeof realVersionsByNumber.waitFor>[1],
							options: Parameters<typeof realVersionsByNumber.waitFor>[2],
						) => {
							waitCalls += 1
							if (lagMode === "timeout") {
								return Effect.fail(
									new Domain.WaitTimeout({
										view: "AgentVersionByNumberView",
										key: String(key),
									}),
								)
							}
							return realVersionsByNumber.waitFor(key, filter, options)
						},
					} as unknown as typeof realVersionsByNumber

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentVersionByNumberView, laggingVersionsByNumber),
					)
					const createRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: {
							name: "No-op Agent",
							model: "gpt-4o-mini",
							system: "Keep steady.",
						},
					})
					expect(createRes.status).toBe(201)
					const created = (yield* Effect.promise(() => createRes.json())) as {
						id: string
						version: number
					}

					// 1. Lagging view catches up during waitFor -> 200 with existing version 1 (no 500).
					lagMode = "recover"
					const recoveredRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${created.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "No-op Agent" },
					})
					expect(recoveredRes.status).toBe(200)
					expect(waitCalls).toBe(1)
					expect(yield* Effect.promise(() => recoveredRes.json())).toMatchObject({
						id: created.id,
						version: 1,
						name: "No-op Agent",
					})

					// 2. Lagging view times out -> 202 pending (no 500).
					lagMode = "timeout"
					const pendingRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${created.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "No-op Agent" },
					})
					expect(pendingRes.status).toBe(202)
					expect(waitCalls).toBe(2)
					expect(seenAtLeastWhenLagging).toEqual([undefined, undefined])
					expect(yield* Effect.promise(() => pendingRes.json())).toEqual({
						id: created.id,
						type: "agent",
						pending: true,
					})
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.succeed(AgentVersionWaitTimeout, "50 millis").pipe(Layer.provideMerge(layer)),
					),
				),
			)
		} finally {
			await closeAll()
		}
	})

	it("preserves read-after-delete consistency when EnvironmentView lags behind DELETE", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realEnvViews = yield* EnvironmentView
					let staleSnapshot: Option.Option<unknown> = Option.none()
					let simulateLag = false

					const laggingEnvViews = {
						...realEnvViews,
						get: (
							ref: Parameters<typeof realEnvViews.get>[0],
							options?: Parameters<typeof realEnvViews.get>[1],
						) => {
							if (simulateLag) {
								if (options?.atLeast !== undefined) {
									return Effect.fail(
										new Domain.ConsistencyTimeout({
											view: "EnvironmentView",
											key: ref.id,
											stream: `Environment/${ref.id}`,
											version: 2,
										}),
									)
								}
								return Effect.succeed(staleSnapshot)
							}
							return realEnvViews.get(ref, options)
						},
					} as unknown as typeof realEnvViews

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(EnvironmentView, laggingEnvViews),
					)
					const createRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Ephemeral Env" },
					})
					expect(createRes.status).toBe(201)
					const created = (yield* Effect.promise(() => createRes.json())) as { id: string }

					// Capture the pre-delete snapshot that a lagging EnvironmentView would still hold.
					staleSnapshot = yield* realEnvViews.get(Environment.ref(EnvironmentId.make(created.id)))
					expect(Option.isSome(staleSnapshot)).toBe(true)

					simulateLag = true
					const delRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: `/v1/environments/${created.id}`,
						headers: AUTH_HEADERS,
					})
					expect(delRes.status).toBe(200)
					expect(yield* Effect.promise(() => delRes.json())).toEqual({
						id: created.id,
						type: "environment_deleted",
					})

					// Immediate GET must return 404 even while EnvironmentView still serves the stale snapshot.
					const getAfterDelete = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/environments/${created.id}`,
						headers: AUTH_HEADERS,
					})
					expect(getAfterDelete.status).toBe(404)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("enforces limited-environment networking before model calls and honors updates, lag, and deletions", async () => {
		const calledProviders: Array<string> = []
		const { layer, closeAll, requests } = makePiDurableTestLayer(async (model, context) => {
			calledProviders.push(model.provider)
			return makeAssistantReply(
				model,
				null,
				`ok:${model.provider}:${extractLastUserText(context)}`,
				4,
				2,
			)
		})

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const provider = yield* ModelProvider

					const openaiAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "OpenAI Agent", model: "gpt-4o-mini" },
					})
					const openaiAgent = (yield* Effect.promise(() => openaiAgentRes.json())) as { id: string }

					const anthropicAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Anthropic Agent", model: "anthropic/claude-sonnet-4-5" },
					})
					const anthropicAgent = (yield* Effect.promise(() => anthropicAgentRes.json())) as {
						id: string
					}

					// Limited environment allowing ONLY api.openai.com.
					const limitedEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: {
							name: "OpenAI-Only Env",
							config: {
								type: "cloud",
								networking: {
									type: "limited",
									allow_mcp_servers: false,
									allow_package_managers: false,
									allowed_hosts: ["api.openai.com"],
								},
							},
						},
					})
					expect(limitedEnvRes.status).toBe(201)
					const limitedEnv = (yield* Effect.promise(() => limitedEnvRes.json())) as { id: string }

					// 1. OpenAI session succeeds in the OpenAI-only limited environment.
					const openaiSessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: openaiAgent.id, environment_id: limitedEnv.id },
					})
					expect(openaiSessRes.status).toBe(201)
					const openaiSession = (yield* Effect.promise(() => openaiSessRes.json())) as {
						id: string
					}
					yield* sendAndSettle(apiFetch, openaiSession.id, ["hello openai"], 1)
					expect(calledProviders).toEqual(["openai"])

					// 2. Anthropic session in the same OpenAI-only limited environment is blocked BEFORE
					//    dispatching to Pi (0 Anthropic calls), stays idle, and emits environment_network_blocked.
					const anthropicSessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: anthropicAgent.id, environment_id: limitedEnv.id },
					})
					expect(anthropicSessRes.status).toBe(201)
					const anthropicSession = (yield* Effect.promise(() => anthropicSessRes.json())) as {
						id: string
					}
					const requestsBeforeBlock = requests.length
					yield* sendAndSettle(apiFetch, anthropicSession.id, ["secret transcript"], 1)
					expect(calledProviders).toEqual(["openai"])
					expect(requests.length).toBe(requestsBeforeBlock)

					const blockedEventsRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${anthropicSession.id}/events`,
						headers: AUTH_HEADERS,
					})
					const blockedEvents = (yield* Effect.promise(() => blockedEventsRes.json())) as {
						data: ReadonlyArray<{ type: string; error?: { type: string; message: string } }>
					}
					const blockedError = blockedEvents.data.find((e) => e.type === "session.error")
					expect(blockedError?.error).toMatchObject({
						type: "environment_network_blocked",
					})
					expect(blockedError?.error?.message).toContain("api.anthropic.com")

					// 3. Updating the environment's allowed_hosts to include *.anthropic.com unblocks the
					//    same session on the next turn.
					const updateEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${limitedEnv.id}`,
						headers: AUTH_HEADERS,
						body: {
							version: 1,
							config: {
								type: "cloud",
								networking: {
									type: "limited",
									allow_mcp_servers: false,
									allow_package_managers: false,
									allowed_hosts: ["API.OPENAI.COM.:443", "*.anthropic.com"],
								},
							},
						},
					})
					expect(updateEnvRes.status).toBe(200)
					yield* sendAndSettle(apiFetch, anthropicSession.id, ["now allowed"], 2)
					expect(calledProviders).toEqual(["openai", "anthropic"])

					// 4. Over-broad wildcards ("*", "*.com"), bare parent domain, and wrong ports do NOT match.
					const strictEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: {
							name: "Invalid Rules Env",
							config: {
								type: "cloud",
								networking: {
									type: "limited",
									allow_mcp_servers: false,
									allow_package_managers: false,
									allowed_hosts: [
										"*",
										"*.com",
										"openai.com",
										"api.openai.com:8443",
										"https://api.openai.com",
									],
								},
							},
						},
					})
					const strictEnv = (yield* Effect.promise(() => strictEnvRes.json())) as { id: string }
					const blockedByStrict = yield* Effect.flip(
						provider.generate({
							session_id: SessionId.make("sess_strict_rules"),
							agent_id: openaiAgent.id,
							agent_version: 1,
							environment_id: strictEnv.id,
							turn: 1,
							generation: 0,
							input: ["blocked"],
						}),
					)
					expect(providerError(blockedByStrict).error_type).toBe("environment_network_blocked")
					expect(providerError(blockedByStrict).terminal).toBe(false)

					// 5. Deleting an environment fails closed before dispatch (terminal: true, 0 model calls).
					const delRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: `/v1/environments/${strictEnv.id}`,
						headers: AUTH_HEADERS,
					})
					expect(delRes.status).toBe(200)
					const deletedErr = yield* Effect.flip(
						provider.generate({
							session_id: SessionId.make("sess_deleted_env"),
							agent_id: openaiAgent.id,
							agent_version: 1,
							environment_id: strictEnv.id,
							turn: 1,
							generation: 0,
							input: ["after delete"],
						}),
					)
					expect(providerError(deletedErr).error_type).toBe("environment_not_found")
					expect(providerError(deletedErr).terminal).toBe(true)
					expect(calledProviders).toEqual(["openai", "anthropic"])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}

		// 6. If an environment tightens from unrestricted (v1) to limited (v2) while EnvironmentView
		//    still lags at v1, generate MUST NOT dispatch against the stale v1 snapshot.
		let laggedCalls = 0
		let lagMode: "off" | "stale_timeout" | "stale_then_recover" = "off"
		let staleV1: Option.Option<unknown> = Option.none()
		let waitForCalls = 0
		const LaggingEnvView = Layer.effect(
			EnvironmentView,
			Effect.map(EnvironmentView, (real) => ({
				...real,
				get: (ref: Parameters<typeof real.get>[0], options?: Parameters<typeof real.get>[1]) =>
					lagMode !== "off" && options?.atLeast === undefined
						? Effect.succeed(staleV1 as never)
						: real.get(ref, options),
				waitFor: (
					ref: Parameters<typeof real.waitFor>[0],
					predicate: Parameters<typeof real.waitFor>[1],
					options: Parameters<typeof real.waitFor>[2],
				) => {
					if (lagMode !== "off") {
						waitForCalls += 1
						if (lagMode === "stale_timeout") {
							return Effect.fail(new Domain.WaitTimeout({ view: "EnvironmentView", key: ref.id }))
						}
					}
					return real.waitFor(ref, predicate, options)
				},
			})),
		)
		const neverCallExecutor = makePiTurnExecutorLayer({
			recoverTurn: () => Effect.succeed(null),
			runTurn: () => {
				laggedCalls += 1
				return Effect.die(new Error("must not dispatch model turn while tightened env lags"))
			},
			abortTurn: () => Effect.void,
		})
		const CheckfuLagLive = Checkfu.layer(
			SessionsHandlersLive.pipe(
				Layer.provide(PiDurableModelProviderLive.pipe(Layer.provide(LaggingEnvView))),
			),
		).pipe(Layer.provide(neverCallExecutor))
		const lagLayer = CheckfuLagLive.pipe(
			Layer.provide(Layer.succeed(AgentVersionLookupTimeout, "40 millis")),
			Layer.provide(Domain.InMemory),
			Layer.provideMerge(SecureRandom.layerWebCrypto),
			Layer.provideMerge(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						CHECKFU_API_KEY: TEST_API_KEY,
						OPENAI_API_KEY: "sk-openai-test",
						ANTHROPIC_API_KEY: "sk-anthropic-test",
					}),
				),
			),
		)
		await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const environments = yield* Environment
				const realEnvViews = yield* EnvironmentView

				const agentRes = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/agents",
					headers: AUTH_HEADERS,
					body: { name: "Anthropic Lag Agent", model: "anthropic/claude-sonnet-4-5" },
				})
				const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

				const envRes = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/environments",
					headers: AUTH_HEADERS,
					body: { name: "Tightened Env" },
				})
				const env = (yield* Effect.promise(() => envRes.json())) as { id: string }
				const envRef = Environment.ref(EnvironmentId.make(env.id))
				staleV1 = yield* realEnvViews.get(envRef)
				expect(Option.isSome(staleV1)).toBe(true)

				const sessRes = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/sessions",
					headers: AUTH_HEADERS,
					body: { agent: agent.id, environment_id: env.id },
				})
				expect(sessRes.status).toBe(201)
				const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

				// Commit v2 tightening networking to OpenAI-only.
				yield* environments.send(
					new UpdateEnvironment({
						environment_id: EnvironmentId.make(env.id),
						expected_version: 1,
						name: "Tightened Env",
						description: null,
						config: {
							type: "cloud",
							networking: {
								type: "limited",
								allow_mcp_servers: false,
								allow_package_managers: false,
								allowed_hosts: ["api.openai.com"],
							},
						},
					}),
				)

				// 6a. While EnvironmentView stays stuck at stale v1 (unrestricted) and waitFor times out,
				//     the turn fails closed with environment_unavailable (never dispatches to Anthropic).
				lagMode = "stale_timeout"
				yield* sendAndSettle(apiFetch, session.id, ["must fail closed while lagging"], 1)
				expect(waitForCalls).toBe(1)
				expect(laggedCalls).toBe(0)

				// 6b. When get() is still stale v1 but waitFor catches up to v2, the turn enforces v2's
				//     limited policy and fails with environment_network_blocked (still 0 model calls).
				lagMode = "stale_then_recover"
				yield* sendAndSettle(apiFetch, session.id, ["must enforce v2 after waitFor"], 2)
				expect(waitForCalls).toBe(2)
				expect(laggedCalls).toBe(0)

				const eventsRes = yield* sendRequest(apiFetch, {
					method: "GET",
					path: `/v1/sessions/${session.id}/events`,
					headers: AUTH_HEADERS,
				})
				const events = (yield* Effect.promise(() => eventsRes.json())) as {
					data: ReadonlyArray<{ type: string; error?: { type: string } }>
				}
				const errorTypes = events.data
					.filter((e) => e.type === "session.error")
					.map((e) => e.error?.type)
				expect(errorTypes).toEqual(["environment_unavailable", "environment_network_blocked"])
			}).pipe(Effect.scoped, Effect.provide(lagLayer)),
		)
	})

	it("rechecks outbound policy before submitting rebuilt history if the environment changes during the scan", async () => {
		const runCase = async (mutation: "tighten" | "delete") => {
			let modelCalls = 0
			let triggerOnDescScan = false
			let envIdToMutate: EnvironmentId | null = null
			const seededRequests: Array<PiTurnRequest> = []
			const backends = new Map<string, ReturnType<typeof createInMemoryPiDurableBackend>>()
			const models = makeScriptedPiModels(async (model, context) => {
				modelCalls += 1
				return makeAssistantReply(model, null, `ok:${extractLastUserText(context)}`, 5, 2)
			})
			const getBackend = (conversation: string) => {
				let backend = backends.get(conversation)
				if (backend === undefined) {
					backend = createInMemoryPiDurableBackend(models)
					backends.set(conversation, backend)
				}
				return backend
			}
			const executorLayer = makePiTurnExecutorLayer({
				recoverTurn: (conversation, operationId) =>
					!backends.has(conversation)
						? Effect.succeed(null)
						: Effect.promise(async (signal) =>
								recoverPiDurableTurn(await getBackend(conversation), operationId, signal),
							),
				runTurn: (conversation, request) =>
					Effect.promise(async (signal) => {
						if (request.seed !== undefined) seededRequests.push(request)
						return runPiDurableTurn(await getBackend(conversation), request, signal)
					}),
				abortTurn: () => Effect.void,
			})
			const MutatingHistoryScanView = Layer.effect(
				SessionView,
				Effect.gen(function* () {
					const real = yield* SessionView
					const environments = yield* Environment
					const envViews = yield* EnvironmentView
					return {
						...real,
						list: (ref, options) =>
							Effect.gen(function* () {
								if (triggerOnDescScan && options?.order === "desc" && envIdToMutate !== null) {
									triggerOnDescScan = false
									const targetId = envIdToMutate
									const receipt =
										mutation === "tighten"
											? yield* environments
													.send(
														new UpdateEnvironment({
															environment_id: targetId,
															expected_version: 1,
															name: "Mutated During Scan",
															description: null,
															config: {
																type: "cloud",
																networking: {
																	type: "limited",
																	allow_mcp_servers: false,
																	allow_package_managers: false,
																	allowed_hosts: ["api.anthropic.com"],
																},
															},
														}),
													)
													.pipe(Effect.orDie)
											: yield* environments
													.send(new DeleteEnvironment({ environment_id: targetId }))
													.pipe(Effect.orDie)
									yield* envViews
										.get(Environment.ref(targetId), { atLeast: receipt })
										.pipe(Effect.orDie)
								}
								return yield* real.list(ref, options)
							}),
					}
				}),
			)
			const CheckfuLive = Checkfu.layer(
				SessionsHandlersLive.pipe(
					Layer.provide(PiDurableModelProviderLive.pipe(Layer.provide(MutatingHistoryScanView))),
				),
			).pipe(Layer.provide(executorLayer))
			const layer = CheckfuLive.pipe(
				Layer.provide(Domain.InMemory),
				Layer.provideMerge(SecureRandom.layerWebCrypto),
				Layer.provideMerge(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							CHECKFU_API_KEY: TEST_API_KEY,
							OPENAI_API_KEY: "sk-openai-test",
							ANTHROPIC_API_KEY: "sk-anthropic-test",
						}),
					),
				),
			)

			try {
				await Effect.runPromise(
					Effect.gen(function* () {
						const { fetch: apiFetch } = yield* makeApiHandler

						const agentRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/agents",
							headers: AUTH_HEADERS,
							body: { name: "OpenAI Agent", model: "gpt-4o-mini" },
						})
						const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

						const envRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/environments",
							headers: AUTH_HEADERS,
							body: { name: "Unrestricted Initially" },
						})
						const env = (yield* Effect.promise(() => envRes.json())) as { id: string }
						envIdToMutate = EnvironmentId.make(env.id)

						const sessRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/sessions",
							headers: AUTH_HEADERS,
							body: { agent: agent.id, environment_id: env.id },
						})
						const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

						// Turn 1 succeeds while unrestricted.
						yield* sendAndSettle(apiFetch, session.id, ["turn 1"], 1)
						expect(modelCalls).toBe(1)

						// Drop Pi state so Turn 2 returns `history_required` and scans SessionView.list(desc).
						const conv = conversationName(session.id, 0)
						const existingBackend = backends.get(conv)
						backends.delete(conv)
						if (existingBackend !== undefined) {
							yield* Effect.promise(async () => (await existingBackend).close())
						}

						triggerOnDescScan = true
						const sendRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/sessions/${session.id}/events`,
							headers: AUTH_HEADERS,
							body: {
								events: [{ type: "user.message", content: [{ type: "text", text: "turn 2" }] }],
							},
						})
						expect(sendRes.status).toBe(200)

						// Wait until session settles (idle on tighten, terminated on delete).
						const expectedStatus = mutation === "tighten" ? "idle" : "terminated"
						let settled = false
						for (let attempt = 0; attempt < 400; attempt++) {
							const res = yield* sendRequest(apiFetch, {
								method: "GET",
								path: `/v1/sessions/${session.id}`,
								headers: AUTH_HEADERS,
							})
							const current = (yield* Effect.promise(() => res.json())) as {
								status: string
								turn: number
							}
							if (current.status === expectedStatus && current.turn === 2) {
								settled = true
								break
							}
							yield* Effect.sleep("5 millis")
						}
						expect(settled).toBe(true)

						// Turn 2 must NEVER submit the rebuilt transcript or call the model.
						expect(seededRequests).toHaveLength(0)
						expect(modelCalls).toBe(1)

						const eventsRes = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/sessions/${session.id}/events`,
							headers: AUTH_HEADERS,
						})
						const events = (yield* Effect.promise(() => eventsRes.json())) as {
							data: ReadonlyArray<{ type: string; error?: { type: string } }>
						}
						expect(
							events.data.filter((e) => e.type === "session.error").map((e) => e.error?.type),
						).toEqual([
							mutation === "tighten" ? "environment_network_blocked" : "environment_not_found",
						])
					}).pipe(Effect.scoped, Effect.provide(layer)),
				)
			} finally {
				for (const b of backends.values()) {
					await (await b).close()
				}
			}
		}

		await runCase("tighten")
		await runCase("delete")
	})

	it("rechecks network policy before retrying an unadmitted RPC failure, while recovering an already-admitted turn", async () => {
		const runRetryCase = async (mode: "unadmitted-tighten" | "unadmitted-delete" | "admitted") => {
			let modelCalls = 0
			let runTurnCalls = 0
			let recoverTurnCalls = 0
			const models = makeScriptedPiModels(async (model, context) => {
				modelCalls += 1
				return makeAssistantReply(model, null, `Echo: ${extractLastUserText(context)}`, 5, 3)
			})
			const backends = new Map<string, ReturnType<typeof createInMemoryPiDurableBackend>>()
			const backendFor = (name: string) => {
				let existing = backends.get(name)
				if (existing === undefined) {
					existing = createInMemoryPiDurableBackend(models)
					backends.set(name, existing)
				}
				return existing
			}

			let envIdToMutate: EnvironmentId | null = null
			let mutateDuringBackoff: (() => Effect.Effect<void>) | null = null

			const executorLayer = makePiTurnExecutorLayer({
				recoverTurn: (name, operationId) =>
					Effect.gen(function* () {
						recoverTurnCalls += 1
						if (mutateDuringBackoff !== null) {
							const mutate = mutateDuringBackoff
							mutateDuringBackoff = null
							yield* mutate()
						}
						return yield* Effect.promise(async () =>
							recoverPiDurableTurn(await backendFor(name), operationId),
						)
					}),
				runTurn: (name, request) =>
					Effect.gen(function* () {
						runTurnCalls += 1
						if (runTurnCalls === 1) {
							if (mode === "admitted") {
								// Pi admits and settles the turn, then the RPC receipt is lost.
								yield* Effect.promise(async () => runPiDurableTurn(await backendFor(name), request))
							}
							return yield* Effect.fail(new HarnessCallFailed({ cause: "simulated RPC drop" }))
						}
						return yield* Effect.promise(async () =>
							runPiDurableTurn(await backendFor(name), request),
						)
					}),
				abortTurn: (name, operationId) =>
					Effect.promise(async () => {
						await (await backendFor(name)).abort(operationId)
					}),
			})

			const CheckfuLive = Checkfu.layer(
				SessionsHandlersLive.pipe(Layer.provide(Layer.fresh(PiDurableModelProviderLive))),
			).pipe(Layer.provide(executorLayer))
			const layer = CheckfuLive.pipe(
				Layer.provide(Domain.InMemory),
				Layer.provideMerge(
					Layer.succeed(HarnessLimits, {
						attempts: 3,
						baseDelayMs: 5,
						interruptTimeoutMs: 5_000,
						settleMarginMs: 5_000,
					}),
				),
				Layer.provideMerge(SecureRandom.layerWebCrypto),
				Layer.provideMerge(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							CHECKFU_API_KEY: TEST_API_KEY,
							OPENAI_API_KEY: "sk-openai-test",
							ANTHROPIC_API_KEY: "sk-anthropic-test",
						}),
					),
				),
			)

			try {
				await Effect.runPromise(
					Effect.gen(function* () {
						const { fetch: apiFetch } = yield* makeApiHandler
						const environments = yield* Environment
						const envViews = yield* EnvironmentView

						const agentRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/agents",
							headers: AUTH_HEADERS,
							body: { name: "OpenAI Agent", model: "gpt-4o-mini" },
						})
						const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

						const envRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/environments",
							headers: AUTH_HEADERS,
							body: { name: "Unrestricted Initially" },
						})
						const env = (yield* Effect.promise(() => envRes.json())) as { id: string }
						envIdToMutate = EnvironmentId.make(env.id)

						const sessRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/sessions",
							headers: AUTH_HEADERS,
							body: { agent: agent.id, environment_id: env.id },
						})
						const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

						// Arm the environment mutation to fire right after attempt 1 fails (before attempt 2).
						const targetId = envIdToMutate
						const triggerMutation = () =>
							Effect.gen(function* () {
								const receipt =
									mode === "unadmitted-delete"
										? yield* environments
												.send(new DeleteEnvironment({ environment_id: targetId }))
												.pipe(Effect.orDie)
										: yield* environments
												.send(
													new UpdateEnvironment({
														environment_id: targetId,
														expected_version: 1,
														name: "Mutated During Retry Backoff",
														description: null,
														config: {
															type: "cloud",
															networking: {
																type: "limited",
																allow_mcp_servers: false,
																allow_package_managers: false,
																allowed_hosts: ["api.anthropic.com"],
															},
														},
													}),
												)
												.pipe(Effect.orDie)
								yield* envViews
									.get(Environment.ref(targetId), { atLeast: receipt })
									.pipe(Effect.orDie)
							})

						// Initial recoverTurn happens before runTurn; trigger mutation on the retry recoverTurn.
						let sawInitialRecover = false
						mutateDuringBackoff = () =>
							Effect.gen(function* () {
								if (!sawInitialRecover) {
									sawInitialRecover = true
									mutateDuringBackoff = triggerMutation
									return
								}
								yield* triggerMutation()
							})

						const sendRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/sessions/${session.id}/events`,
							headers: AUTH_HEADERS,
							body: {
								events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }],
							},
						})
						expect(sendRes.status).toBe(200)

						const expectedStatus = mode === "unadmitted-delete" ? "terminated" : "idle"
						let settled = false
						for (let attempt = 0; attempt < 400; attempt++) {
							const res = yield* sendRequest(apiFetch, {
								method: "GET",
								path: `/v1/sessions/${session.id}`,
								headers: AUTH_HEADERS,
							})
							const current = (yield* Effect.promise(() => res.json())) as {
								status: string
								turn: number
							}
							if (current.status === expectedStatus && current.turn === 1) {
								settled = true
								break
							}
							yield* Effect.sleep("5 millis")
						}
						expect(settled).toBe(true)

						// Retry checked recoverTurn (initial + retry) and NEVER issued a second runTurn.
						expect(recoverTurnCalls).toBe(2)
						expect(runTurnCalls).toBe(1)

						const eventsRes = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/sessions/${session.id}/events`,
							headers: AUTH_HEADERS,
						})
						const events = (yield* Effect.promise(() => eventsRes.json())) as {
							data: ReadonlyArray<{
								type: string
								error?: { type: string }
								content?: ReadonlyArray<{ text?: string }>
							}>
						}
						const expectedModelCalls = mode === "admitted" ? 1 : 0
						const expectedErrors =
							mode === "admitted"
								? []
								: [
										mode === "unadmitted-tighten"
											? "environment_network_blocked"
											: "environment_not_found",
									]
						const expectedReplies = mode === "admitted" ? ["Echo: hello"] : []
						expect(modelCalls).toBe(expectedModelCalls)
						expect(
							events.data.filter((e) => e.type === "session.error").map((e) => e.error?.type),
						).toEqual(expectedErrors)
						expect(
							events.data
								.filter((e) => e.type === "agent.message")
								.map((e) => e.content?.[0]?.text),
						).toEqual(expectedReplies)
					}).pipe(Effect.scoped, Effect.provide(layer)),
				)
			} finally {
				for (const b of backends.values()) {
					await (await b).close()
				}
			}
		}

		await runRetryCase("unadmitted-tighten")
		await runRetryCase("unadmitted-delete")
		await runRetryCase("admitted")
	})

	it("recovers a saved reply after the final runTurn attempt loses its RPC receipt", async () => {
		let modelCalls = 0
		let runTurnCalls = 0
		let recoverTurnCalls = 0
		const models = makeScriptedPiModels(async (model, context) => {
			modelCalls += 1
			return makeAssistantReply(model, null, `FinalReply: ${extractLastUserText(context)}`, 7, 5)
		})
		const backends = new Map<string, ReturnType<typeof createInMemoryPiDurableBackend>>()
		const backendFor = (name: string) => {
			let existing = backends.get(name)
			if (existing === undefined) {
				existing = createInMemoryPiDurableBackend(models)
				backends.set(name, existing)
			}
			return existing
		}

		const executorLayer = makePiTurnExecutorLayer({
			recoverTurn: (name, operationId) =>
				Effect.gen(function* () {
					recoverTurnCalls += 1
					return yield* Effect.promise(async () =>
						recoverPiDurableTurn(await backendFor(name), operationId),
					)
				}),
			runTurn: (name, request) =>
				Effect.gen(function* () {
					runTurnCalls += 1
					// Final (and only) runTurn attempt commits the reply in Pi, then loses its RPC receipt.
					yield* Effect.promise(async () => runPiDurableTurn(await backendFor(name), request))
					return yield* Effect.fail(new HarnessCallFailed({ cause: "final RPC receipt lost" }))
				}),
			abortTurn: (name, operationId) =>
				Effect.promise(async () => {
					await (await backendFor(name)).abort(operationId)
				}),
		})

		const CheckfuLive = Checkfu.layer(
			SessionsHandlersLive.pipe(Layer.provide(Layer.fresh(PiDurableModelProviderLive))),
		).pipe(Layer.provide(executorLayer))
		const layer = CheckfuLive.pipe(
			Layer.provide(Domain.InMemory),
			Layer.provideMerge(
				Layer.succeed(HarnessLimits, {
					attempts: 1,
					baseDelayMs: 5,
					interruptTimeoutMs: 5_000,
					settleMarginMs: 5_000,
				}),
			),
			Layer.provideMerge(SecureRandom.layerWebCrypto),
			Layer.provideMerge(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						CHECKFU_API_KEY: TEST_API_KEY,
						OPENAI_API_KEY: "sk-openai-test",
						ANTHROPIC_API_KEY: "sk-anthropic-test",
					}),
				),
			),
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Final Recovery Agent", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Default Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					yield* sendAndSettle(apiFetch, session.id, ["save me"], 1)

					expect(runTurnCalls).toBe(1)
					// 1 initial recovery check + 1 post-final recovery probe after the lost receipt.
					expect(recoverTurnCalls).toBe(2)
					expect(modelCalls).toBe(1)

					const eventsRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
					})
					const events = (yield* Effect.promise(() => eventsRes.json())) as {
						data: ReadonlyArray<{
							type: string
							content?: ReadonlyArray<{ text?: string }>
						}>
					}
					expect(events.data.filter((e) => e.type === "session.error")).toHaveLength(0)
					expect(
						events.data.filter((e) => e.type === "agent.message").map((e) => e.content?.[0]?.text),
					).toEqual(["FinalReply: save me"])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			for (const b of backends.values()) {
				await (await b).close()
			}
		}
	})
})
