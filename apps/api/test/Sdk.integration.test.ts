import {
	AuthenticationError,
	Checkfu,
	CheckfuClient,
	ConflictError,
	NotFoundError,
	isPendingResource,
} from "@checkfu/sdk"
import type { JsonSessionEvent, SessionEvent } from "@checkfu/sdk"
import { CodemodeSandbox } from "@earendil-works/pi-codemode"
import type { Extension } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import { AgentVersionWaitTimeout, makeApiHandler } from "../src/Http/Router.ts"
import { loadToolSurface, withScriptDeadline } from "../src/Pi/PiCodemode.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { TEST_API_KEY, makeAssistantReply, makePiDurableTestLayer } from "./helpers/ApiHarness.ts"

const withToolSurface = await loadToolSurface()

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

							// 1. Agent create (with idempotency replay), retrieve, update, conflict, archive
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

							// 2. Environment create, retrieve, update, delete
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

							// Automation create, run on request, run list, archive
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

							// 3. Session create, send events, live SSE stream, paginated list, archive, 204
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

							// Stream live until turn settles (session.status_idle)
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

							// Paginate all events with small limit=2
							const pagedEvents = yield* Stream.runCollect(
								client.sessions.events.listStream(session.id, { limit: 2, order: "asc" }),
							)
							expect(Array.from(pagedEvents).map((e) => e.seq)).toEqual(liveArray.map((e) => e.seq))

							// Archive session and verify stream finishes at session.archived, then 204 empty
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

							// Archive agent at end
							const archivedAgent = yield* client.waitForPending(
								yield* client.agents.archive(agent.id),
							)
							expect(archivedAgent.archived_at).not.toBeNull()
						}).pipe(Effect.provide(sdkLayer))

						// 4. Verify authentication rejection with bad API key
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

								const receipt = await client.sessions.events.send(session.id, {
									events: [
										{
											type: "user.message",
											content: [{ type: "text", text: "Ping" }],
										},
									],
								})
								expect(receipt.data[0]?.type).toBe("user.message")

								// Live stream via Promise facade
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

								// Auto-paginated for-await over historical events
								const allEvents: Array<JsonSessionEvent> = []
								for await (const event of client.sessions.events.list(session.id, { limit: 2 })) {
									allEvents.push(event)
								}
								expect(allEvents.length).toBeGreaterThanOrEqual(seen.length)

								// Auto-paginated for-await over an automation's runs, with and without an order
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
								const listedIds: Array<string> = []
								for await (const entry of client.automations.list({ limit: 1 })) {
									listedIds.push(entry.id)
								}
								expect(listedIds).toContain(automation.id)

								// 404 unwraps directly to NotFoundError
								await expect(client.sessions.retrieve("sess_does_not_exist")).rejects.toThrow(
									NotFoundError,
								)

								// 202 Pending check
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
						// Zero wait timeout forces agents.create to return 202 Pending while the read
						// endpoint still resolves once projected.
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

	it.live(
		"stores a credential in a vault and never gets its token back",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { layer } = makePiDurableTestLayer(async (model) =>
						makeAssistantReply(model, null, "ok", 2, 2),
					)
					const token = "tok_sdk_SECRET_do_not_leak"
					const rotated = "tok_sdk_ROTATED_do_not_leak"
					const bodies: Array<string> = []

					yield* Effect.gen(function* () {
						const { fetch: apiFetch } = yield* makeApiHandler
						const services = yield* Effect.context<never>()
						const bridgeFetch = makeFetchBridge(Effect.runPromiseWith(services), apiFetch)
						const recordingFetch: typeof globalThis.fetch = async (input, init) => {
							const response = await bridgeFetch(input, init)
							bodies.push(await response.clone().text())
							return response
						}
						const sdkLayer = CheckfuClient.layerFetch({
							apiKey: TEST_API_KEY,
							baseUrl: "http://localhost:1337",
							fetch: recordingFetch,
							maxRetries: 0,
						})

						yield* Effect.gen(function* () {
							const client = yield* CheckfuClient
							const vault = yield* client.vaults.create({ display_name: "Alice" })
							if (isPendingResource(vault)) {
								return yield* Effect.die("vault creation stayed pending")
							}
							expect(vault.type).toBe("vault")

							const credential = yield* client.vaults.credentials.create(vault.id, {
								auth: {
									type: "static_bearer",
									token: Redacted.make(token),
									mcp_server_url: "https://mcp.example.com/mcp",
								},
								display_name: "Alice's token",
							})
							if (isPendingResource(credential)) {
								return yield* Effect.die("credential creation stayed pending")
							}
							expect(credential.auth).toEqual({
								type: "static_bearer",
								mcp_server_url: "https://mcp.example.com/mcp",
							})

							const fetched = yield* client.vaults.credentials.retrieve(vault.id, credential.id)
							expect(fetched.id).toBe(credential.id)
							const listed = yield* client.vaults.credentials.list(vault.id)
							expect(listed.data.map((item) => item.id)).toEqual([credential.id])

							yield* client.vaults.credentials.update(vault.id, credential.id, {
								auth: { type: "static_bearer", token: Redacted.make(rotated) },
							})
							const duplicate = yield* Effect.flip(
								client.vaults.credentials.create(vault.id, {
									auth: {
										type: "static_bearer",
										token: Redacted.make(token),
										mcp_server_url: "https://mcp.example.com/mcp",
									},
								}),
							)
							expect(duplicate).toBeInstanceOf(ConflictError)

							yield* client.vaults.credentials.archive(vault.id, credential.id)
							expect((yield* client.vaults.credentials.list(vault.id)).data).toEqual([])
							expect((yield* client.vaults.delete(vault.id)).type).toBe("vault_deleted")
							expect(yield* Effect.flip(client.vaults.retrieve(vault.id))).toBeInstanceOf(
								NotFoundError,
							)
						}).pipe(Effect.provide(sdkLayer))
					}).pipe(Effect.provide(layer))

					expect(bodies.length).toBeGreaterThan(6)
					expect(bodies.join("\n")).not.toContain(token)
					expect(bodies.join("\n")).not.toContain(rotated)
				}),
			),
		{ timeout: 15_000 },
	)

	it.live(
		"reads a tool call and an approval pause through the event stream, and answers it",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const posted: Array<string> = []
					const desk: Extension = {
						name: "desk",
						tools: [
							{
								name: "post",
								description: "Post a message.",
								parameters: { type: "object", properties: { text: { type: "string" } } },
								execute: (args: { readonly text?: string }) => {
									posted.push(args.text ?? "")
									return Promise.resolve({ output: [{ type: "text", text: "posted" }] })
								},
							},
							{
								name: "peek",
								description: "Read the board.",
								parameters: { type: "object", properties: {} },
								execute: () => Promise.resolve({ output: [{ type: "text", text: "board" }] }),
							},
						],
					}
					const sandboxes: Array<CodemodeSandbox> = []
					const base = makePiDurableTestLayer(
						(model, context) =>
							Promise.resolve(
								context.messages.some((message) => message.role === "toolResult")
									? makeAssistantReply(model, null, "done", 2, 2)
									: {
											...makeAssistantReply(model, null, "", 3, 2),
											content: [
												{ type: "toolCall" as const, id: "call_peek", name: "peek", arguments: {} },
												{
													type: "toolCall" as const,
													id: "call_post",
													name: "post",
													arguments: { text: "hi" },
												},
											],
											stopReason: "toolUse" as const,
										},
							),
						undefined,
						undefined,
						() => {
							const sandbox = withScriptDeadline(new CodemodeSandbox(), {
								defaultMs: 2000,
								maxMs: 2000,
							})
							sandboxes.push(sandbox)
							const registry = createCheckfuRegistry()
							for (const extension of withToolSurface(sandbox, [desk])) {
								registry.install(extension)
							}
							return registry
						},
						undefined,
						(tool) => (tool === "post" ? { server: "desk", tool: "post", ask: true } : undefined),
					)
					yield* Effect.addFinalizer(() =>
						Effect.promise(() => base.closeAll()).pipe(
							Effect.andThen(
								Effect.forEach(sandboxes, (sandbox) => Effect.promise(() => sandbox.close()), {
									discard: true,
								}),
							),
						),
					)

					yield* Effect.gen(function* () {
						const { fetch: apiFetch } = yield* makeApiHandler
						const services = yield* Effect.context<never>()
						const sdkLayer = CheckfuClient.layerFetch({
							apiKey: TEST_API_KEY,
							baseUrl: "http://localhost:1337",
							fetch: makeFetchBridge(Effect.runPromiseWith(services), apiFetch),
							maxRetries: 0,
						})

						yield* Effect.gen(function* () {
							const client = yield* CheckfuClient
							const agent = yield* client.waitForPending(
								yield* client.agents.create({ name: "Desk", model: "gpt-4o-mini" }),
							)
							const environment = yield* client.waitForPending(
								yield* client.environments.create({
									name: "default",
									config: { type: "cloud", networking: { type: "unrestricted" } },
								}),
							)
							const session = yield* client.waitForPending(
								yield* client.sessions.create({
									agent: { id: agent.id, version: agent.version },
									environment_id: environment.id,
								}),
							)
							yield* client.sessions.events.send(session.id, {
								events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }],
							})

							const untilIdle = (after?: number) =>
								client.sessions.events
									.stream(session.id, after === undefined ? {} : { after })
									.pipe(
										Stream.takeUntil((event: SessionEvent) => event.type === "session.status_idle"),
										Stream.runCollect,
										Effect.map((events) => Array.from(events)),
									)

							const paused = yield* untilIdle()
							const waiting = paused.filter((event) => event.type === "agent.tool_use")
							expect(
								waiting.map((event) =>
									event.type === "agent.tool_use"
										? [event.tool_use_id, event.name, event.input]
										: event,
								),
							).toEqual([
								["call_peek", "peek", {}],
								["call_post", "post", { text: "hi" }],
							])
							const pause = paused.at(-1)
							expect(
								pause?.type === "session.status_idle" &&
									pause.stop_reason.type === "requires_action"
									? pause.stop_reason.event_ids
									: pause,
							).toEqual(["call_post"])
							expect(posted).toEqual([])

							const receipt = yield* client.sessions.events.send(session.id, {
								events: [
									{ type: "user.tool_confirmation", tool_use_id: "call_post", result: "allow" },
								],
							})
							expect(receipt.data).toEqual([
								{ type: "user.tool_confirmation", tool_use_id: "call_post", result: "allow" },
							])

							const resumed = yield* untilIdle(pause?.seq)
							const confirmation = resumed.find((event) => event.type === "user.tool_confirmation")
							expect(
								confirmation?.type === "user.tool_confirmation"
									? confirmation.result
									: confirmation,
							).toBe("allow")
							const result = resumed.find((event) => event.type === "agent.tool_result")
							expect(
								result?.type === "agent.tool_result"
									? [result.tool_use_id, result.content, result.is_error]
									: result,
							).toEqual(["call_post", [{ type: "text", text: "posted" }], false])
							const end = resumed.at(-1)
							expect(end?.type === "session.status_idle" ? end.stop_reason : end).toEqual({
								type: "end_turn",
							})
							expect(posted).toEqual(["hi"])
						}).pipe(Effect.provide(sdkLayer))
					}).pipe(Effect.provide(base.layer))
				}),
			),
		{ timeout: 20_000 },
	)
})
