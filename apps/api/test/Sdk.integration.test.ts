import {
	AuthenticationError,
	Checkfu,
	CheckfuClient,
	ConflictError,
	NotFoundError,
	isPendingResource,
} from "@checkfu/sdk"
import type { JsonSessionEvent, SessionEvent } from "@checkfu/sdk"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Stream from "effect/Stream"
import { AgentVersionWaitTimeout, makeApiHandler } from "../src/Http/Router.ts"
import { TEST_API_KEY, makeAssistantReply, makePiDurableTestLayer } from "./helpers/ApiHarness.ts"

const makeFetchBridge =
	(
		runEffect: <A>(effect: Effect.Effect<A>) => Promise<A>,
		apiFetch: Effect.Effect<
			HttpServerResponse.HttpServerResponse,
			never,
			HttpServerRequest.HttpServerRequest
		>,
	): typeof globalThis.fetch =>
	async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init)
		const serverResponse = await runEffect(
			apiFetch.pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(request),
				),
			),
		)
		return HttpServerResponse.toWeb(serverResponse)
	}

describe("@checkfu/sdk live API integration", () => {
	it.live(
		"exercises full Effect-native CheckfuClient lifecycle against makeApiHandler",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { layer } = makePiDurableTestLayer(async (model, context) => {
						const lastUser = context.messages
							.filter((m) => m.role === "user")
							.map((m) =>
								typeof m.content === "string"
									? m.content
									: m.content.map((p) => (p.type === "text" ? p.text : "")).join(""),
							)
							.at(-1)
						return makeAssistantReply(model, null, `Echo: ${lastUser ?? ""}`, 4, 6)
					})

					yield* Effect.gen(function* () {
						const { fetch: apiFetch } = yield* makeApiHandler
						const services = yield* Effect.context<never>()
						const runEffect = Effect.runPromiseWith(services)
						const bridgeFetch = makeFetchBridge(runEffect, apiFetch)

						const sdkLayer = CheckfuClient.layerFetch({
							apiKey: TEST_API_KEY,
							baseUrl: "http://localhost:1337",
							fetch: bridgeFetch,
							maxRetries: 0,
						})

						yield* Effect.gen(function* () {
							const client = yield* CheckfuClient

							const createdAgentRes = yield* client.agents.create(
								{
									name: "SDK Agent",
									model: "gpt-4o-mini",
									system: "Be concise.",
								},
								{ idempotencyKey: "sdk-idem-agent-1", withResponse: true },
							)
							expect(createdAgentRes.status).toBe(201)
							expect(createdAgentRes.requestId).toBeTruthy()
							const agent = yield* client.waitForPending(createdAgentRes.data)
							expect(agent.name).toBe("SDK Agent")
							expect(agent.version).toBe(1)

							const replayedAgent = yield* client.waitForPending(
								yield* client.agents.create(
									{
										name: "SDK Agent",
										model: "gpt-4o-mini",
										system: "Be concise.",
									},
									{ idempotencyKey: "sdk-idem-agent-1" },
								),
							)
							expect(replayedAgent.id).toBe(agent.id)

							const fetchedAgent = yield* client.agents.retrieve(agent.id)
							expect(fetchedAgent.id).toBe(agent.id)

							const updatedAgent = yield* client.waitForPending(
								yield* client.agents.update(agent.id, {
									version: agent.version,
									description: "Updated via SDK",
								}),
							)
							expect(updatedAgent.version).toBe(2)
							expect(updatedAgent.description).toBe("Updated via SDK")

							const conflictErr = yield* Effect.flip(
								client.agents.update(agent.id, { version: 1, name: "Stale" }),
							)
							expect(conflictErr._tag).toBe("ConflictError")
							expect(conflictErr).toBeInstanceOf(ConflictError)

							const env = yield* client.waitForPending(
								yield* client.environments.create({ name: "sdk-env" }),
							)
							expect(env.name).toBe("sdk-env")
							const env2 = yield* client.waitForPending(
								yield* client.environments.create({ name: "disposable-env" }),
							)
							const deleted = yield* client.environments.delete(env2.id)
							expect(deleted).toEqual({ id: env2.id, type: "environment_deleted" })
							const missingEnvErr = yield* Effect.flip(client.environments.retrieve(env2.id))
							expect(missingEnvErr._tag).toBe("NotFoundError")
							const listedEnvironments = yield* Stream.runCollect(
								client.environments.listStream({ limit: 1, include_archived: true }),
							).pipe(
								Effect.repeat({
									schedule: Schedule.spaced("5 millis"),
									times: 400,
									until: (entries) => entries.length === 1,
								}),
							)
							expect(Array.from(listedEnvironments, (entry) => entry.id)).toEqual([env.id])

							const artifact = yield* client.waitForPending(
								yield* client.artifacts.create({
									name: "sdk-artifact",
									files: [{ path: "index.html", content: "<h1>Hi</h1>" }],
								}),
							)
							const listedArtifacts = yield* Stream.runCollect(
								client.artifacts.listStream({ limit: 1, order: "desc" }),
							).pipe(
								Effect.repeat({
									schedule: Schedule.spaced("5 millis"),
									times: 400,
									until: (entries) => entries.length === 1,
								}),
							)
							expect(Array.from(listedArtifacts, (entry) => entry.name)).toEqual(["sdk-artifact"])
							expect(Array.from(listedArtifacts, (entry) => entry.id)).toEqual([artifact.id])

							const automation = yield* client.automations.create(
								{
									name: "sdk-automation",
									agent: agent.id,
									environment_id: env.id,
									initial_events: [
										{ type: "user.message", content: [{ type: "text", text: "Report." }] },
									],
									schedule: { type: "cron", expression: "0 0 29 2 *", timezone: "UTC" },
								},
								{ idempotencyKey: "sdk-effect-create" },
							)
							if ("pending" in automation) {
								return yield* Effect.die(new Error("automation create stayed pending"))
							}
							expect(automation.status).toBe("active")
							expect(automation.upcoming_runs_at).toHaveLength(5)
							const queued = yield* client.automations.run(automation.id)
							expect(queued).toEqual({
								type: "automation_run",
								automation_id: automation.id,
								run: 1,
								status: "queued",
								trigger: { type: "manual" },
							})
							yield* client.automations.run(automation.id)
							yield* client.automations.run(automation.id)
							const runs = yield* client.automations.runs.list(automation.id, { limit: 5 }).pipe(
								Effect.repeat({
									schedule: Schedule.spaced("5 millis"),
									times: 400,
									until: (page) => page.data.length >= 3,
								}),
							)
							expect(runs.data[0]).toMatchObject({
								run: 1,
								status: "started",
								session_id: `sess_${automation.id}_1`,
							})
							const paged = yield* Stream.runCollect(
								client.automations.runs.listStream(automation.id, { limit: 1 }),
							)
							expect(Array.from(paged, (entry) => entry.run)).toEqual([1, 2, 3])
							const pagedNewestFirst = yield* Stream.runCollect(
								client.automations.runs.listStream(automation.id, { limit: 1, order: "desc" }),
							)
							expect(Array.from(pagedNewestFirst, (entry) => entry.run)).toEqual([3, 2, 1])
							const third = yield* client.automations.runs.retrieve(automation.id, queued.run + 2)
							expect(third.run).toBe(3)
							const listedAutomations = yield* Stream.runCollect(
								client.automations.listStream({ limit: 1 }),
							)
							expect(Array.from(listedAutomations, (entry) => entry.id)).toEqual([automation.id])
							const tooFrequent = yield* Effect.flip(
								client.automations.create(
									{
										name: "too-frequent",
										agent: agent.id,
										environment_id: env.id,
										initial_events: [
											{ type: "user.message", content: [{ type: "text", text: "Report." }] },
										],
										schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" },
									},
									{ idempotencyKey: "sdk-too-frequent" },
								),
							)
							expect(tooFrequent._tag).toBe("BadRequestError")
							const archivedAutomation = yield* client.automations.archive(automation.id)
							if ("pending" in archivedAutomation) {
								return yield* Effect.die(new Error("automation archive stayed pending"))
							}
							expect(archivedAutomation.status).toBe("archived")

							const session = yield* client.waitForPending(
								yield* client.sessions.create({
									agent: agent.id,
									environment_id: env.id,
									title: "SDK Effect Session",
								}),
							)
							expect(session.status).toBe("idle")

							const sendReceipt = yield* client.sessions.events.send(session.id, {
								events: [
									{
										id: "evt_user_1",
										type: "user.message",
										content: [{ type: "text", text: "Hello from Effect SDK" }],
									},
								],
							})
							expect(sendReceipt.data).toHaveLength(1)
							const firstReceipt = sendReceipt.data[0]
							expect(firstReceipt?.type).toBe("user.message")
							if (firstReceipt?.type === "user.message") {
								expect(firstReceipt.turn).toBe(1)
								expect(firstReceipt.id).toBe("evt_user_1")
							}

							const liveEvents = yield* client.sessions.events.stream(session.id).pipe(
								Stream.takeUntil((ev: SessionEvent) => ev.type === "session.status_idle"),
								Stream.runCollect,
							)
							const liveArray = Array.from(liveEvents)
							const agentMsg = liveArray.find((e) => e.type === "agent.message")
							expect(agentMsg?.type).toBe("agent.message")
							if (agentMsg?.type === "agent.message") {
								expect(agentMsg.content[0]?.text).toBe("Echo: Hello from Effect SDK")
							}

							const pagedEvents = yield* Stream.runCollect(
								client.sessions.events.listStream(session.id, { limit: 2, order: "asc" }),
							)
							expect(Array.from(pagedEvents).map((e) => e.seq)).toEqual(liveArray.map((e) => e.seq))

							const archivedSession = yield* client.waitForPending(
								yield* client.sessions.archive(session.id),
							)
							expect(archivedSession.archived_at).not.toBeNull()

							const afterCursor = liveArray.at(-1)?.seq ?? 0
							const tailEvents = yield* Stream.runCollect(
								client.sessions.events.stream(session.id, { after: afterCursor }),
							)
							const tailArray = Array.from(tailEvents)
							expect(tailArray.at(-1)?.type).toBe("session.archived")

							const postArchiveCursor = tailArray.at(-1)?.seq ?? afterCursor
							const empty204 = yield* Stream.runCollect(
								client.sessions.events.stream(session.id, { after: postArchiveCursor }),
							)
							expect(Array.from(empty204)).toEqual([])

							const archivedAgent = yield* client.waitForPending(
								yield* client.agents.archive(agent.id),
							)
							expect(archivedAgent.archived_at).not.toBeNull()
						}).pipe(Effect.provide(sdkLayer))

						const badAuthErr = yield* Effect.gen(function* () {
							const client = yield* CheckfuClient
							return yield* Effect.flip(client.agents.retrieve("agent_any"))
						}).pipe(
							Effect.provide(
								CheckfuClient.layerFetch({
									apiKey: "ck_wrong_key",
									baseUrl: "http://localhost:1337",
									fetch: bridgeFetch,
									maxRetries: 0,
								}),
							),
						)
						expect(badAuthErr._tag).toBe("AuthenticationError")
						expect(badAuthErr).toBeInstanceOf(AuthenticationError)
					}).pipe(Effect.provide(layer))
				}),
			),
		{ timeout: 15_000 },
	)

	it.live(
		"exercises Promise / AsyncIterable Checkfu facade end-to-end against makeApiHandler",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { layer } = makePiDurableTestLayer(async (model) =>
						makeAssistantReply(model, null, "Hello from Promise SDK", 4, 6),
					)

					yield* Effect.gen(function* () {
						const { fetch: apiFetch } = yield* makeApiHandler
						const services = yield* Effect.context<never>()
						const runEffect = Effect.runPromiseWith(services)
						const bridgeFetch = makeFetchBridge(runEffect, apiFetch)

						const client = new Checkfu({
							apiKey: TEST_API_KEY,
							baseUrl: "http://localhost:1337",
							fetch: bridgeFetch,
							maxRetries: 0,
						})

						yield* Effect.promise(async () => {
							try {
								const createdAgent = await client.agents.create({
									name: "Promise Agent",
									model: "gpt-4o-mini",
								})
								const agent = await client.waitForPending(createdAgent)
								expect(typeof agent.created_at).toBe("string")

								const env = await client.waitForPending(
									await client.environments.create({ name: "promise-env" }),
								)

								const session = await client.waitForPending(
									await client.sessions.create({
										agent: { id: agent.id, version: agent.version },
										environment_id: env.id,
									}),
								)
								expect(session.agent).toEqual({ id: agent.id, version: 1 })
								const listedSessions = async () => {
									const ids: Array<string> = []
									for await (const entry of client.sessions.list({ agent_id: agent.id })) {
										ids.push(entry.id)
									}
									return ids
								}
								await expect.poll(() => listedSessions(), { timeout: 5000 }).toEqual([session.id])

								const receipt = await client.sessions.events.send(session.id, {
									events: [
										{
											type: "user.message",
											content: [{ type: "text", text: "Ping" }],
										},
									],
								})
								expect(receipt.data[0]?.type).toBe("user.message")

								const stream = await client.sessions.events.stream(session.id)
								const seen: Array<JsonSessionEvent> = []
								for await (const event of stream) {
									seen.push(event)
									if (event.type === "session.status_idle") {
										break
									}
								}
								expect(seen.some((e) => e.type === "agent.message")).toBe(true)
								expect(typeof seen[0]?.created_at).toBe("string")

								const allEvents: Array<JsonSessionEvent> = []
								for await (const event of client.sessions.events.list(session.id, { limit: 2 })) {
									allEvents.push(event)
								}
								expect(allEvents.length).toBeGreaterThanOrEqual(seen.length)

								const automation = await client.waitForPending(
									await client.automations.create(
										{
											name: "promise-automation",
											agent: agent.id,
											environment_id: env.id,
											initial_events: [
												{ type: "user.message", content: [{ type: "text", text: "Report." }] },
											],
											schedule: { type: "cron", expression: "0 0 29 2 *", timezone: "UTC" },
										},
										{ idempotencyKey: "sdk-promise-create" },
									),
								)
								for (const expected of [1, 2, 3]) {
									expect((await client.automations.run(automation.id)).run).toBe(expected)
								}
								const runNumbers = async (order?: "asc" | "desc") => {
									const numbers: Array<number> = []
									for await (const entry of client.automations.runs.list(automation.id, {
										limit: 1,
										...(order === undefined ? {} : { order }),
									})) {
										numbers.push(entry.run)
									}
									return numbers
								}
								await expect.poll(() => runNumbers(), { timeout: 5000 }).toEqual([1, 2, 3])
								expect(await runNumbers("desc")).toEqual([3, 2, 1])
								const firstRun = await client.automations.run(automation.id)
								await expect
									.poll(() =>
										client.automations.runs.retrieve(automation.id, firstRun.run).then(
											(entry) => entry.run,
											() => null,
										),
									)
									.toBe(firstRun.run)
								const listedIds: Array<string> = []
								for await (const entry of client.automations.list({ limit: 1 })) {
									listedIds.push(entry.id)
								}
								expect(listedIds).toContain(automation.id)

								await expect(client.sessions.retrieve("sess_does_not_exist")).rejects.toThrow(
									NotFoundError,
								)

								expect(isPendingResource(session)).toBe(false)
							} finally {
								await client.close()
							}
						})
					}).pipe(Effect.provide(layer))
				}),
			),
		{ timeout: 15_000 },
	)

	it.live(
		"resolves real 202 Pending agent creation via waitForPending",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { layer } = makePiDurableTestLayer(async (model) =>
						makeAssistantReply(model, null, "ok", 2, 2),
					)

					yield* Effect.gen(function* () {
						const { fetch: apiFetch } = yield* makeApiHandler.pipe(
							Effect.provideService(AgentVersionWaitTimeout, "0 millis"),
						)
						const services = yield* Effect.context<never>()
						const runEffect = Effect.runPromiseWith(services)
						const bridgeFetch = makeFetchBridge(runEffect, apiFetch)

						const sdkLayer = CheckfuClient.layerFetch({
							apiKey: TEST_API_KEY,
							baseUrl: "http://localhost:1337",
							fetch: bridgeFetch,
							maxRetries: 0,
						})

						yield* Effect.gen(function* () {
							const client = yield* CheckfuClient
							const created = yield* client.agents.create({
								name: "Eventually Ready Agent",
								model: "gpt-4o-mini",
							})
							const ready = yield* client.waitForPending(created, {
								initialDelay: "5 millis",
								maxDelay: "50 millis",
								timeout: "5 seconds",
							})
							expect(ready.name).toBe("Eventually Ready Agent")
						}).pipe(Effect.provide(sdkLayer))
					}).pipe(Effect.provide(layer))
				}),
			),
		{ timeout: 15_000 },
	)
})
