import * as v8 from "node:v8"
import { ArtifactBytesKept } from "@checkfu/domain/Artifact/ArtifactBytes.external"
import { FileBytesKept } from "@checkfu/domain/File/FileBytes.external"
import { SessionOutputsUnpublished } from "@checkfu/domain/Session/SessionOutputs.external"
import * as Domain from "@alchemy.run/domain"
import * as DurableObjects from "@alchemy.run/domain/DurableObjects"
import { MAX_MODEL_ID_LENGTH } from "@checkfu/pi-providers/catalog"
import { Agent } from "@checkfu/domain/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/domain/Agent/AgentVersion.id"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { AgentView } from "@checkfu/domain/Agent/AgentView.view"
import { CreateAgent } from "@checkfu/domain/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/domain/Agent/CreateAgent.decision"
import { UpdateAgent } from "@checkfu/domain/Agent/UpdateAgent.command"
import { UpdateAgentDecision } from "@checkfu/domain/Agent/UpdateAgent.decision"
import { Agents } from "@checkfu/domain/Agents.model"
import {
	NO_AGENT_TOOLS,
	NO_MCP_SERVERS,
	MAX_AGENT_TOOLS_TEXT_LENGTH,
	MAX_MCP_SERVERS_TEXT_LENGTH,
} from "@checkfu/domain/Mcp/McpServers"
import {
	MAX_AGENT_DESCRIPTION_LENGTH,
	MAX_AGENT_NAME_LENGTH,
	MAX_AGENT_SYSTEM_LENGTH,
} from "@checkfu/domain/Agent/AgentTypes"
import {
	MAX_CUSTOM_TOOLS,
	MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH,
	MAX_MCP_SERVERS,
	MAX_MCP_SERVER_NAME_LENGTH,
	MAX_MCP_SERVER_URL_LENGTH,
} from "@checkfu/sdk/Schemas"
import { CreateEnvironment } from "@checkfu/domain/Environment/CreateEnvironment.command"
import { DeleteEnvironment } from "@checkfu/domain/Environment/DeleteEnvironment.command"
import { Environment } from "@checkfu/domain/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { EnvironmentView } from "@checkfu/domain/Environment/EnvironmentView.view"
import { UpdateEnvironment } from "@checkfu/domain/Environment/UpdateEnvironment.command"
import { Environments } from "@checkfu/domain/Environments.model"
import {
	MAX_ENVIRONMENT_DESCRIPTION_LENGTH,
	MAX_ENVIRONMENT_NAME_LENGTH,
} from "@checkfu/domain/Environment/EnvironmentTypes"
import { Harness } from "@checkfu/domain/Session/Harness.external"
import { AdmitSessionWithMessages } from "@checkfu/domain/Session/AdmitSession.command"
import { AdmitSessionWithMessagesDecision } from "@checkfu/domain/Session/AdmitSessionWithMessages.decision"
import { encodeInitialMessages } from "@checkfu/domain/Session/InitialMessages"
import {
	RecordInitialMessages,
	RecordInitialMessagesLive,
} from "@checkfu/domain/Session/RecordInitialMessages.policy"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { SessionResources } from "@checkfu/domain/Session/SessionResource"
import { TurnInput } from "@checkfu/domain/Session/TurnInput.view"
import { MAX_SESSION_INITIAL_MESSAGES_BYTES } from "@checkfu/sdk/Limits"
import { describe, expect, it } from "@effect/vitest"
import { RuntimeContext } from "alchemy/RuntimeContext"
import type { BaseRuntimeContext } from "alchemy/RuntimeContext"
import { storageCallbacks } from "alchemy/Workers/StorageCallbacks"
import * as Clock from "effect/Clock"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiClient from "effect/http-api/HttpApiClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import { WebhookEventsNoop } from "@checkfu/domain/Webhook/WebhookEvents.external"
import { makeWebhooksTestSupport } from "../src/Webhooks/WebhookTestLayer.ts"
import { AgentResource, CheckfuApi, ListAgentVersionsResponse } from "../src/Http/Api.ts"
import {
	AgentVersionWaitTimeout,
	IsSupportedAgentModel,
	makeApiHandler,
} from "../src/Http/Router.ts"
import { MAX_AGENT_BODY_BYTES, MAX_REQUEST_BODY_BYTES } from "../src/Http/HttpHelpers.ts"
import { LIST_PAGE_BYTES, hydratePage } from "../src/Http/Listing.ts"
import {
	AgentVersionLookupTimeout,
	HarnessCallFailed,
	HarnessLimits,
	PiDurableHarnessLive,
	makePiTurnExecutorLayer,
} from "../src/Pi/PiDurableHarness.ts"
import { recoverPiDurableTurn, runPiDurableTurn } from "../src/Pi/PiDurableEngine.ts"
import {
	AUTH_HEADERS,
	extractLastUserText,
	makeApiTestClient,
	makeApiTestHttpClient,
	makeAssistantReply,
	makePiDurableTestLayer,
	makeScriptedPiModels,
	openApiDocument,
	readSseUntil,
	sendAndSettle,
	sendRequest,
	TEST_API_KEY,
	TestRuntimeContext,
} from "./helpers/ApiHarness.ts"
import { makeArtifactStoreMemory } from "../src/Artifacts/ArtifactStoreMemory.ts"
import { makeFileStoreMemory } from "../src/Files/FileStoreMemory.ts"
import { ArtifactLinksTest } from "../src/Content/ArtifactLinks.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"
import { VaultsTestLive } from "./helpers/VaultsHarness.ts"
import {
	fullAsciiInitialMessages,
	mixedInitialMessagesAt,
} from "./helpers/SessionInitialMessages.ts"

class SessionAdmissionStorage extends Domain.Model("SessionAdmissionStorage", {
	aggregates: [Agent, Environment, Session],
	decisions: [CreateAgentDecision, AdmitSessionWithMessagesDecision],
	views: [TurnInput],
	policies: [RecordInitialMessages],
}) {}

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

					const customAgentId = AgentId.make("agent_custom_001")
					const customVersionId = AgentVersionId.make("aver_custom_001")
					yield* createAgent.send(
						new CreateAgent({
							mcp_servers: NO_MCP_SERVERS,
							tools: NO_AGENT_TOOLS,
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

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: {
							agent: { type: "agent", id: customAgentId, version: 1 },
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

	it("keeps every turn after the last published reply out of the model's context, even one that never reached Pi", async () => {
		const contexts: Array<string> = []
		const { layer, closeAll } = makePiDurableTestLayer(async (model, context) => {
			contexts.push(
				context.messages
					.map((m) =>
						typeof m.content === "string"
							? m.content
							: m.content.map((p) => (p.type === "text" ? p.text : "")).join(""),
					)
					.join(" | "),
			)
			return makeAssistantReply(model, null, `Echo ${extractLastUserText(context)}`, 1, 1)
		})
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const provider = yield* Harness
					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Abandoned", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
					const turn = (number: number, text: string, last_reply_turn: number, agent_version = 1) =>
						provider.runTurn({
							segment: 1,
							session_id: SessionId.make("sess_abandoned_context"),
							agent_id: agent.id,
							agent_version,
							environment_id: "env_1",
							resources: [],
							turn: number,
							input: [text],
							last_reply_turn,
						})
					yield* turn(1, "lost", 0)
					yield* Effect.flip(
						turn(2, "missing version", 0, 99).pipe(
							Effect.provideService(AgentVersionLookupTimeout, "10 millis"),
						),
					)
					yield* turn(3, "kept", 0)
					yield* turn(4, "next", 3)
					expect(contexts).toEqual(["lost", "kept", "kept | Echo kept | next"])
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
					const provider = yield* Harness

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
						body: { system: "V2 prompt" },
					})
					const original = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/agents/${agentV1.id}?version=1`,
						headers: AUTH_HEADERS,
					})
					expect(original.status).toBe(200)
					expect(yield* Effect.promise(() => original.json())).toMatchObject({
						id: agentV1.id,
						version: 1,
						system: "V1 prompt",
					})
					const missingVersion = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/agents/${agentV1.id}?version=99`,
						headers: AUTH_HEADERS,
					})
					expect(missingVersion.status).toBe(404)

					const versions = (page?: string) =>
						sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/agents/${agentV1.id}/versions?limit=1${page === undefined ? "" : `&page=${encodeURIComponent(page)}`}`,
							headers: AUTH_HEADERS,
						})
					const headPage = yield* versions()
					expect(headPage.status).toBe(200)
					const latest = (yield* Effect.promise(() => headPage.json())) as {
						data: ReadonlyArray<{ version: number }>
						next_page: string
					}
					expect(latest.data.map(({ version }) => version)).toEqual([2])
					const earlierPage = yield* versions(latest.next_page)
					expect(earlierPage.status).toBe(200)
					expect(yield* Effect.promise(() => earlierPage.json())).toMatchObject({
						data: [{ version: 1, system: "V1 prompt" }],
						next_page: null,
					})
					expect((yield* versions("wrong-page")).status).toBe(400)

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const obsoleteFields = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: {
							agent: { type: "agent", id: agentV1.id, version: 1 },
							agent_version: 2,
							environment_id: env.id,
						},
					})
					expect(obsoleteFields.status).toBe(400)

					const pinnedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: {
							agent: { type: "agent", id: agentV1.id, version: 1 },
							environment_id: env.id,
						},
					})
					expect(pinnedRes.status).toBe(201)
					const pinnedSession = (yield* Effect.promise(() => pinnedRes.json())) as {
						id: string
						agent: { id: string; version: number }
					}
					expect(pinnedSession.agent).toMatchObject({
						type: "agent",
						id: agentV1.id,
						version: 1,
						system: "V1 prompt",
					})

					const reply = yield* provider.runTurn({
						last_reply_turn: 0,
						segment: 1,
						session_id: SessionId.make("sess_pinned_version"),
						agent_id: agentV1.id,
						agent_version: 1,
						environment_id: env.id,
						resources: [],
						turn: 1,
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

	it("bounds agent version pages by bytes and resumes at the first omitted revision", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const views = yield* AgentVersionByNumberView
					const reads: Array<string> = []
					const observed: typeof views = {
						...views,
						get: (key, options) =>
							Effect.sync(() => reads.push(String(key))).pipe(
								Effect.andThen(views.get(key, options)),
							),
					}
					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentVersionByNumberView, observed),
						Effect.provideService(IsSupportedAgentModel, (id) => id === "fixture-model"),
					)
					const decodeAgent = Schema.decodeUnknownEffect(Schema.toCodecJson(AgentResource))
					const decodeHistory = Schema.decodeUnknownEffect(
						Schema.toCodecJson(ListAgentVersionsResponse),
					)
					const utf8 = new TextEncoder()
					const bytesOf = (value: unknown) => utf8.encode(JSON.stringify(value)).byteLength
					const create = (name: string) =>
						sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/agents",
							headers: AUTH_HEADERS,
							body: { name, model: "fixture-model", system: "Version 1" },
						})
					const created = yield* create("Historian")
					expect(created.status).toBe(201)
					const agent = yield* Effect.promise(() => created.json()).pipe(
						Effect.flatMap(decodeAgent),
					)
					const endpoint = `/v1/agents/${agent.id}`
					const update = (system: string) =>
						sendRequest(apiFetch, {
							method: "POST",
							path: endpoint,
							headers: AUTH_HEADERS,
							body: { system },
						})
					const history = (limit: number, cursor?: string) => {
						const query = new URLSearchParams({ limit: String(limit) })
						if (cursor !== undefined) {
							query.set("page", cursor)
						}
						return sendRequest(apiFetch, {
							method: "GET",
							path: `${endpoint}/versions?${query}`,
							headers: AUTH_HEADERS,
						})
					}
					const readPage = (limit: number, cursor?: string) =>
						Effect.gen(function* () {
							const response = yield* history(limit, cursor)
							expect(response.status).toBe(200)
							return yield* Effect.promise(() => response.json()).pipe(
								Effect.flatMap(decodeHistory),
							)
						})
					const head = 40
					const boundaryVersion = 27
					const largeSystem = "界".repeat(MAX_AGENT_SYSTEM_LENGTH - 2)
					const systemFor = (version: number) => `${largeSystem}${version}`
					const larger = Array.from({ length: head - boundaryVersion }, (_, index) => {
						const version = head - index
						return { ...agent, version, system: systemFor(version) }
					})
					const boundaryLength =
						LIST_PAGE_BYTES -
						bytesOf([...larger, { ...agent, version: boundaryVersion, system: "" }])
					expect(boundaryLength).toBeGreaterThan(0)
					expect(boundaryLength).toBeLessThanOrEqual(MAX_AGENT_SYSTEM_LENGTH)
					for (let version = 2; version <= head; version++) {
						const system =
							version > boundaryVersion
								? systemFor(version)
								: version === boundaryVersion
									? "x".repeat(boundaryLength)
									: `Version ${version}`
						const response = yield* update(system)
						expect(response.status, `version ${version}`).toBe(200)
						yield* Effect.promise(() => response.arrayBuffer())
					}
					const control = yield* readPage(2)
					expect(control.data.map(({ version }) => version)).toEqual([40, 39])
					reads.length = 0
					const first = yield* readPage(50)
					const firstVersions = Array.from(
						{ length: head - boundaryVersion + 1 },
						(_, index) => head - index,
					)
					expect(bytesOf(first.data)).toBe(LIST_PAGE_BYTES)
					expect(first.data.map(({ version }) => version)).toEqual(firstVersions)
					expect(first.next_page).toBe(
						`page_${encodeURIComponent(agent.id)}:${boundaryVersion - 1}`,
					)
					expect(reads).toContain(agentVersionLookupKey(agent.id, boundaryVersion - 1))
					expect(reads.length).toBeLessThanOrEqual(firstVersions.length + 11)
					const advanced = yield* update("A new head after the first page")
					expect(advanced.status).toBe(200)
					expect(yield* Effect.promise(() => advanced.json())).toMatchObject({ version: head + 1 })
					const seen = [...firstVersions]
					let cursor = first.next_page
					while (cursor !== null && seen.length <= head) {
						const page = yield* readPage(7, cursor)
						expect(bytesOf(page.data)).toBeLessThanOrEqual(LIST_PAGE_BYTES)
						expect(page.data.length).toBeGreaterThan(0)
						seen.push(...page.data.map(({ version }) => version))
						cursor = page.next_page
					}
					expect(seen).toEqual(Array.from({ length: head }, (_, index) => head - index))
					expect(cursor).toBeNull()
					const other = yield* create("Another agent")
					const foreign = yield* Effect.promise(() => other.json()).pipe(
						Effect.flatMap(decodeAgent),
					)
					reads.length = 0
					expect((yield* history(50, "not-a-cursor")).status).toBe(400)
					expect((yield* history(50, `page_${encodeURIComponent(foreign.id)}:1`)).status).toBe(400)
					expect(reads).toEqual([])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	}, 30_000)

	it.effect("keeps a history page moving past an individually oversized item", () =>
		Effect.gen(function* () {
			const oversized = "x".repeat(LIST_PAGE_BYTES)
			const page = yield* hydratePage([2, 1], (version) =>
				Effect.succeed({ version, system: version === 2 ? oversized : "Earlier version" }),
			)
			expect(page.data.map(({ version }) => version)).toEqual([2])
			expect(page.firstOmitted).toBe(1)
		}),
	)

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

					const laggingAgentViews: typeof realAgentViews = {
						...realAgentViews,
						get: (ref, options) =>
							options?.atLeast === undefined
								? Effect.succeedNone
								: Effect.fail(
										new Domain.ConsistencyTimeout({
											view: "AgentView",
											key: ref.id,
											stream: options.atLeast.stream,
											version: options.atLeast.version,
										}),
									),
					}
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
							return envGetCalls === 1 ? Effect.succeedNone : realEnvViews.get(ref)
						},
					}

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AgentView, laggingAgentViews),
						Effect.provideService(EnvironmentView, laggingEnvViews),
					)

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

					const staleAgent = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agentId}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Stale" },
					})
					expect(staleAgent.status).toBe(409)

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
						request_id: updateRes.headers.get("request-id"),
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
									const v3Receipt = yield* updateAgent.send(
										new UpdateAgent({
											agent_id: ref.id,
											expected_version: 2,
											next_version_id: AgentVersionId.make("aver_writer_b_v3"),
											changes: {
												name: "Writer B v3",
												model: { id: "gpt-4o" },
												system: "System B",
												description: "Desc B",
											},
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

	it("requires an agent reference in the session create contract", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					const spec = openApiDocument<{
						paths: Record<
							string,
							{
								post?: {
									requestBody?: {
										content?: {
											"application/json"?: {
												schema?: {
													required?: ReadonlyArray<string>
													properties?: { agent?: { description?: string } }
												}
											}
										}
									}
								}
							}
						>
					}>()
					const sessionBodySchema =
						spec.paths["/v1/sessions"]?.post?.requestBody?.content?.["application/json"]?.schema
					expect(sessionBodySchema?.required).toEqual(["agent", "environment_id"])
					expect(sessionBodySchema?.properties).not.toHaveProperty("agent_id")
					expect(sessionBodySchema?.properties).not.toHaveProperty("agent_version")

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

					const obsoleteFields = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent_id: "agent_2", environment_id: "env_1" },
					})
					expect(obsoleteFields.status).toBe(400)
					expect(yield* Effect.promise(() => obsoleteFields.json())).toMatchObject({
						type: "error",
						error: {
							type: "invalid_request_error",
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
									const v3Receipt = yield* environments.send(
										new UpdateEnvironment({
											environment_id: ref.id,
											expected_version: 2,
											changes: {
												name: "Writer B Env v3",
												description: "Desc B",
												config: { type: "cloud", networking: { type: "unrestricted" } },
											},
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

	it("reads a no-op agent update's version at the agent's own commit, so a lagging AgentVersionByNumberView cannot fail it", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realVersionsByNumber = yield* AgentVersionByNumberView
					let lagging = false
					let stalled = false
					const stalledTimeouts: Array<unknown> = []
					let waitCalls = 0
					const checkpoints: Array<unknown> = []
					const laggingVersionsByNumber = {
						...realVersionsByNumber,
						get: (
							key: Parameters<typeof realVersionsByNumber.get>[0],
							options?: Parameters<typeof realVersionsByNumber.get>[1],
						) => {
							if (lagging) {
								checkpoints.push(options?.atLeast)
								if (options?.atLeast === undefined) {
									return Effect.succeedNone
								}
								if (stalled) {
									stalledTimeouts.push(options.timeout)
									return Effect.sleep(options.timeout ?? "10 seconds").pipe(
										Effect.andThen(
											Effect.fail(
												new Domain.ConsistencyTimeout({
													view: "AgentVersionByNumberView",
													key: String(key),
													...options.atLeast,
												}),
											),
										),
									)
								}
							}
							return realVersionsByNumber.get(key, options)
						},
						waitFor: (
							key: Parameters<typeof realVersionsByNumber.waitFor>[0],
							filter: Parameters<typeof realVersionsByNumber.waitFor>[1],
							options: Parameters<typeof realVersionsByNumber.waitFor>[2],
						) => {
							waitCalls += 1
							if (lagging) {
								return Effect.fail(
									new Domain.WaitTimeout({ view: "AgentVersionByNumberView", key: String(key) }),
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
						body: { name: "No-op Agent", model: "gpt-4o-mini", system: "Keep steady." },
					})
					expect(createRes.status).toBe(201)
					const created = (yield* Effect.promise(() => createRes.json())) as { id: string }

					lagging = true
					const noOpRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${created.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "No-op Agent" },
					})
					expect(noOpRes.status).toBe(200)
					expect(yield* Effect.promise(() => noOpRes.json())).toMatchObject({
						id: created.id,
						version: 1,
						name: "No-op Agent",
					})
					expect(waitCalls).toBe(0)
					expect(checkpoints).toEqual([expect.objectContaining({ stream: `Agent/${created.id}` })])

					stalled = true
					const stalledRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${created.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "No-op Agent" },
					})
					expect(stalledRes.status).toBe(202)
					expect(stalledTimeouts).toEqual(["50 millis"])
					expect(yield* Effect.promise(() => stalledRes.json())).toEqual({
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

	it("decides partial environment updates in the domain and maps each refusal", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const limited = {
						type: "cloud",
						networking: {
							type: "limited",
							allow_mcp_servers: false,
							allow_package_managers: true,
							allowed_hosts: ["api.openai.com"],
						},
					}
					const unrestricted = { type: "cloud", networking: { type: "unrestricted" } }
					const update = (id: string, body: unknown) =>
						sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/environments/${id}`,
							headers: AUTH_HEADERS,
							body,
						})
					const errorOf = (res: Response) =>
						Effect.map(
							Effect.promise(() => res.json()),
							(body) => (body as { error: { type: string; message: string } }).error,
						)

					const createRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Sandbox", description: "First draft", config: limited },
					})
					expect(createRes.status).toBe(201)
					const env = (yield* Effect.promise(() => createRes.json())) as { id: string }

					const steps = [
						[{ name: "Renamed" }, { name: "Renamed", description: "First draft", config: limited }],
						[
							{ description: "Second draft" },
							{ name: "Renamed", description: "Second draft", config: limited },
						],
						[
							{ config: unrestricted },
							{ name: "Renamed", description: "Second draft", config: unrestricted },
						],
						[{ description: null }, { name: "Renamed", description: null, config: unrestricted }],
						[
							{ name: "Locked Down", config: limited },
							{ name: "Locked Down", description: null, config: limited },
						],
						[{}, { name: "Locked Down", description: null, config: limited }],
					] as const
					for (const [index, [fields, expected]] of steps.entries()) {
						const res = yield* update(env.id, { version: index + 1, ...fields })
						expect(res.status).toBe(200)
						expect(yield* Effect.promise(() => res.json())).toMatchObject({
							id: env.id,
							version: index + 2,
							archived_at: null,
							...expected,
						})
					}

					const missing = yield* update("env_never_created", { version: 1, name: "Missing" })
					expect(missing.status).toBe(404)
					expect(yield* errorOf(missing)).toEqual({
						type: "not_found_error",
						message: "Environment does not exist.",
					})

					const stale = yield* update(env.id, { version: 1, name: "Stale" })
					expect(stale.status).toBe(409)
					expect((yield* errorOf(stale)).message).toBe("Environment version does not match.")

					const archiveRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${env.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(archiveRes.status).toBe(200)
					const archived = yield* update(env.id, { version: 7, name: "After Archive" })
					expect(archived.status).toBe(409)
					expect((yield* errorOf(archived)).message).toBe(
						"Environment is archived and cannot be modified.",
					)

					const getRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/environments/${env.id}`,
						headers: AUTH_HEADERS,
					})
					expect(yield* Effect.promise(() => getRes.json())).toMatchObject({
						version: 7,
						name: "Locked Down",
						description: null,
						config: limited,
					})

					const deleteRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: `/v1/environments/${env.id}`,
						headers: AUTH_HEADERS,
					})
					expect(deleteRes.status).toBe(200)
					expect((yield* update(env.id, { version: 7, name: "After Delete" })).status).toBe(404)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("decides partial agent updates in the domain and maps each refusal", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const update = (id: string, body: unknown) =>
						sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/agents/${id}`,
							headers: AUTH_HEADERS,
							body,
						})
					const errorOf = (res: Response) =>
						Effect.map(
							Effect.promise(() => res.json()),
							(body) => (body as { error: { type: string; message: string } }).error,
						)

					const createRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: {
							name: "Planner",
							model: "gpt-4o-mini",
							system: "Plan.",
							description: "Plans work",
						},
					})
					expect(createRes.status).toBe(201)
					const agent = (yield* Effect.promise(() => createRes.json())) as { id: string }

					const mini = { id: "gpt-4o-mini" }
					const full = { id: "gpt-4o" }
					const steps = [
						[
							{ name: "Planner II" },
							{ name: "Planner II", model: mini, system: "Plan.", description: "Plans work" },
						],
						[
							{ model: "gpt-4o" },
							{ name: "Planner II", model: full, system: "Plan.", description: "Plans work" },
						],
						[
							{ system: "Plan well." },
							{ name: "Planner II", model: full, system: "Plan well.", description: "Plans work" },
						],
						[
							{ description: "Plans all" },
							{ name: "Planner II", model: full, system: "Plan well.", description: "Plans all" },
						],
						[
							{ system: null },
							{ name: "Planner II", model: full, system: null, description: "Plans all" },
						],
						[
							{ description: null },
							{ name: "Planner II", model: full, system: null, description: null },
						],
						[
							{ name: "Planner III", model: mini, system: "" },
							{ name: "Planner III", model: mini, system: "", description: null },
						],
					] as const
					for (const [index, [fields, expected]] of steps.entries()) {
						const res = yield* update(agent.id, { version: index + 1, ...fields })
						expect(res.status).toBe(200)
						expect(yield* Effect.promise(() => res.json())).toMatchObject({
							id: agent.id,
							version: index + 2,
							archived_at: null,
							...expected,
						})
					}

					const head = { name: "Planner III", model: mini, system: "", description: null }
					for (const fields of [{}, { name: "Planner III" }, { model: mini, description: null }]) {
						const res = yield* update(agent.id, { version: 8, ...fields })
						expect(res.status).toBe(200)
						expect(yield* Effect.promise(() => res.json())).toMatchObject({
							id: agent.id,
							version: 8,
							...head,
						})
					}

					const unsupported = yield* update(agent.id, { version: 8, model: "not-a-model" })
					expect(unsupported.status).toBe(400)
					expect((yield* errorOf(unsupported)).message).toBe('Unsupported model "not-a-model".')

					const oversizedModel = yield* update(agent.id, {
						version: 8,
						model: `openai/${"a".repeat(MAX_MODEL_ID_LENGTH)}`,
					})
					expect(oversizedModel.status).toBe(400)
					expect((yield* errorOf(oversizedModel)).message).toBe(
						`Model id must be at most ${MAX_MODEL_ID_LENGTH} characters.`,
					)

					const missing = yield* update("agent_never_created", { version: 1, name: "Missing" })
					expect(missing.status).toBe(404)
					expect(yield* errorOf(missing)).toEqual({
						type: "not_found_error",
						message: "Agent does not exist.",
					})

					const stale = yield* update(agent.id, { version: 1, name: "Stale" })
					expect(stale.status).toBe(409)
					expect((yield* errorOf(stale)).message).toBe("Agent version does not match.")

					const archiveRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agent.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(archiveRes.status).toBe(200)
					const archived = yield* update(agent.id, { version: 8, name: "After Archive" })
					expect(archived.status).toBe(409)
					expect((yield* errorOf(archived)).message).toBe(
						"Agent is archived and cannot be modified.",
					)

					const getRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/agents/${agent.id}`,
						headers: AUTH_HEADERS,
					})
					expect(yield* Effect.promise(() => getRes.json())).toMatchObject({ version: 8, ...head })
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("runs turns whatever allowed_hosts says and keeps a session running after its environment is archived or deleted", async () => {
		const calledProviders: Array<string> = []
		const { layer, closeAll } = makePiDurableTestLayer(async (model, context) => {
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
					const write = (method: string, path: string, body?: unknown) =>
						sendRequest(apiFetch, { method, path, body, headers: AUTH_HEADERS })

					const agentRes = yield* write("POST", "/v1/agents", {
						name: "Anthropic Agent",
						model: "anthropic/claude-sonnet-4-5",
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* write("POST", "/v1/environments", {
						name: "OpenAI-Only Sandbox",
						config: {
							type: "cloud",
							networking: {
								type: "limited",
								allow_mcp_servers: false,
								allow_package_managers: false,
								allowed_hosts: ["api.openai.com"],
							},
						},
					})
					expect(envRes.status).toBe(201)
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const sessRes = yield* write("POST", "/v1/sessions", {
						agent: agent.id,
						environment_id: env.id,
					})
					expect(sessRes.status).toBe(201)
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					yield* sendAndSettle(apiFetch, session.id, ["while limited"], 1)
					expect(calledProviders).toEqual(["anthropic"])

					expect((yield* write("POST", `/v1/environments/${env.id}/archive`)).status).toBe(200)
					yield* sendAndSettle(apiFetch, session.id, ["after archive"], 2)
					expect(calledProviders).toEqual(["anthropic", "anthropic"])

					expect((yield* write("DELETE", `/v1/environments/${env.id}`)).status).toBe(200)
					yield* sendAndSettle(apiFetch, session.id, ["after delete"], 3)
					expect(calledProviders).toEqual(["anthropic", "anthropic", "anthropic"])

					const sessionRes = yield* write("GET", `/v1/sessions/${session.id}`)
					expect(yield* Effect.promise(() => sessionRes.json())).toMatchObject({
						status: "idle",
						turn: 3,
					})
					const eventsRes = yield* write("GET", `/v1/sessions/${session.id}/events`)
					const events = (yield* Effect.promise(() => eventsRes.json())) as {
						data: ReadonlyArray<{ type: string; content?: ReadonlyArray<{ text?: string }> }>
					}
					expect(events.data.filter((e) => e.type === "session.error")).toHaveLength(0)
					expect(
						events.data.filter((e) => e.type === "agent.message").map((e) => e.content?.[0]?.text),
					).toEqual([
						"ok:anthropic:while limited",
						"ok:anthropic:after archive",
						"ok:anthropic:after delete",
					])

					const refused = yield* write("POST", "/v1/sessions", {
						agent: agent.id,
						environment_id: env.id,
					})
					expect(refused.status).toBe(404)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
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
					const backend = yield* Effect.promise(() => backendFor(name))
					return yield* recoverPiDurableTurn(backend, operationId)
				}),
			runTurn: (name, request) =>
				Effect.gen(function* () {
					runTurnCalls += 1
					const backend = yield* Effect.promise(() => backendFor(name))
					yield* runPiDurableTurn(backend, request)
					return yield* new HarnessCallFailed({ cause: "final RPC receipt lost" })
				}),
			abortTurn: (name, operationId) =>
				Effect.flatMap(
					Effect.promise(() => backendFor(name)),
					(backend) => Effect.asVoid(backend.abort(operationId)),
				),
		})

		const CheckfuLive = Checkfu.layer(
			CheckfuHandlersLive.pipe(
				Layer.provide(ArtifactBytesKept),
				Layer.provide(FileBytesKept),
				Layer.provide(SessionOutputsUnpublished),
				Layer.provide(ListingStore.memory),
				Layer.provide(WebhookEventsNoop),
				Layer.provide(Layer.fresh(PiDurableHarnessLive)),
			),
		).pipe(Layer.provide(executorLayer))
		const HarnessLive = PiDurableHarnessLive.pipe(
			Layer.provide(executorLayer),
			Layer.provide(CheckfuLive),
		)
		const layer = Layer.mergeAll(makeWebhooksTestSupport().layer, CheckfuLive, HarnessLive).pipe(
			Layer.provide(Domain.InMemory),
			Layer.provideMerge(
				Layer.succeed(HarnessLimits, {
					attempts: 1,
					baseDelay: "5 millis",
					interruptTimeout: "5 seconds",
					settleMargin: "5 seconds",
				}),
			),
			Layer.provideMerge(makeArtifactStoreMemory().layer),
			Layer.provideMerge(makeFileStoreMemory().layer),
			Layer.provideMerge(ArtifactLinksTest),
			Layer.provideMerge(VaultsTestLive),
			Layer.provideMerge(TestRuntimeContext),
			Layer.provideMerge(Digest.layerWebCrypto),
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

	it("retries a failed call whatever happened to the environment during backoff, without running an admitted turn twice", async () => {
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
						const backend = yield* Effect.promise(() => backendFor(name))
						return yield* recoverPiDurableTurn(backend, operationId)
					}),
				runTurn: (name, request) =>
					Effect.gen(function* () {
						runTurnCalls += 1
						const backend = yield* Effect.promise(() => backendFor(name))
						if (runTurnCalls === 1) {
							if (mode === "admitted") {
								yield* runPiDurableTurn(backend, request)
							}
							if (mutateDuringBackoff !== null) {
								const mutate = mutateDuringBackoff
								mutateDuringBackoff = null
								yield* mutate()
							}
							return yield* new HarnessCallFailed({ cause: "simulated RPC drop" })
						}
						return yield* runPiDurableTurn(backend, request)
					}),
				abortTurn: (name, operationId) =>
					Effect.flatMap(
						Effect.promise(() => backendFor(name)),
						(backend) => Effect.asVoid(backend.abort(operationId)),
					),
			})

			const CheckfuLive = Checkfu.layer(
				CheckfuHandlersLive.pipe(
					Layer.provide(ArtifactBytesKept),
					Layer.provide(FileBytesKept),
					Layer.provide(SessionOutputsUnpublished),
					Layer.provide(ListingStore.memory),
					Layer.provide(WebhookEventsNoop),
					Layer.provide(Layer.fresh(PiDurableHarnessLive)),
				),
			).pipe(Layer.provide(executorLayer))
			const HarnessLive = PiDurableHarnessLive.pipe(
				Layer.provide(executorLayer),
				Layer.provide(CheckfuLive),
			)
			const layer = Layer.mergeAll(makeWebhooksTestSupport().layer, CheckfuLive, HarnessLive).pipe(
				Layer.provide(Domain.InMemory),
				Layer.provideMerge(makeArtifactStoreMemory().layer),
				Layer.provideMerge(makeFileStoreMemory().layer),
				Layer.provideMerge(ArtifactLinksTest),
				Layer.provideMerge(
					Layer.succeed(HarnessLimits, {
						attempts: 3,
						baseDelay: "5 millis",
						interruptTimeout: "5 seconds",
						settleMargin: "5 seconds",
					}),
				),
				Layer.provideMerge(VaultsTestLive),
				Layer.provideMerge(TestRuntimeContext),
				Layer.provideMerge(Digest.layerWebCrypto),
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

						const targetId = envIdToMutate
						const triggerMutation = () =>
							Effect.gen(function* () {
								const receipt =
									mode === "unadmitted-delete"
										? yield* environments.send(new DeleteEnvironment({ environment_id: targetId }))
										: yield* environments.send(
												new UpdateEnvironment({
													environment_id: targetId,
													expected_version: 1,
													changes: {
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
													},
												}),
											)
								yield* envViews.get(Environment.ref(targetId), { atLeast: receipt })
							}).pipe(Effect.orDie)

						mutateDuringBackoff = triggerMutation

						const sendRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/sessions/${session.id}/events`,
							headers: AUTH_HEADERS,
							body: {
								events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }],
							},
						})
						expect(sendRes.status).toBe(200)

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
							if (current.status === "idle" && current.turn === 1) {
								settled = true
								break
							}
							yield* Effect.sleep("5 millis")
						}
						expect(settled).toBe(true)

						expect(recoverTurnCalls).toBe(1)
						expect(runTurnCalls).toBe(2)

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
						expect(modelCalls).toBe(1)
						expect(
							events.data.filter((e) => e.type === "session.error").map((e) => e.error?.type),
						).toEqual([])
						expect(
							events.data
								.filter((e) => e.type === "agent.message")
								.map((e) => e.content?.[0]?.text),
						).toEqual(["Echo: hello"])
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

	it("enforces Idempotency-Key deduplication and payload conflict checks on agent and environment creates", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realCreateAgent = yield* CreateAgentDecision
					const realEnvironments = yield* Environment
					const agents = yield* Agent

					const sentAgentIds: Array<string> = []
					const sentEnvironmentIds: Array<string> = []
					let dropNextAgentReceipt = false
					let failNextAgentBeforeCommit = false
					let dropNextEnvReceipt = false

					const wrappedCreateAgent: typeof realCreateAgent = {
						...realCreateAgent,
						send: (command, options) => {
							if (failNextAgentBeforeCommit) {
								failNextAgentBeforeCommit = false
								return Effect.die(new Error("failed before commit"))
							}
							sentAgentIds.push(command.agent_id)
							const call = realCreateAgent.send(command, options)
							if (dropNextAgentReceipt) {
								dropNextAgentReceipt = false
								return call.pipe(Effect.andThen(Effect.die(new Error("receipt lost"))))
							}
							return call
						},
					}

					const wrappedEnvironments: typeof realEnvironments = {
						...realEnvironments,
						send: ((
							command: Parameters<typeof realEnvironments.send>[0],
							options?: Parameters<typeof realEnvironments.send>[1],
						) => {
							if (command._tag === "CreateEnvironment") {
								sentEnvironmentIds.push(command.environment_id)
								const call = realEnvironments.send(command, options)
								if (dropNextEnvReceipt) {
									dropNextEnvReceipt = false
									return call.pipe(Effect.andThen(Effect.die(new Error("receipt lost"))))
								}
								return call
							}
							return realEnvironments.send(command, options)
						}) as typeof realEnvironments.send,
					}

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(CreateAgentDecision, wrappedCreateAgent),
						Effect.provideService(Environment, wrappedEnvironments),
					)

					const spec = openApiDocument<{
						paths: Record<
							string,
							{
								post?: {
									parameters?: ReadonlyArray<{
										readonly name: string
										readonly in: string
										readonly required?: boolean
									}>
								}
							}
						>
					}>()
					const eventsIdempotencyParam = spec.paths[
						"/v1/sessions/{session_id}/events"
					]?.post?.parameters?.find((p) => p.name === "idempotency-key" && p.in === "header")
					expect(eventsIdempotencyParam).toBeDefined()
					for (const path of ["/v1/agents", "/v1/environments", "/v1/sessions"]) {
						const param = spec.paths[path]?.post?.parameters?.find(
							(p) => p.name === "idempotency-key" && p.in === "header",
						)
						expect(param).toEqual(eventsIdempotencyParam)
					}

					const badKeyRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "   " },
						body: { name: "Bad Key", model: "gpt-4o-mini" },
					})
					expect(badKeyRes.status).toBe(400)
					expect(sentAgentIds).toHaveLength(0)

					const badModelRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: { name: "Bad Model", model: "unsupported/model" },
					})
					expect(badModelRes.status).toBe(400)
					expect(sentAgentIds).toHaveLength(0)

					const agentPayload = {
						name: "Idempotent Agent",
						model: "gpt-4o-mini",
						system: "Stay deterministic.",
					}
					dropNextAgentReceipt = true
					const lostAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: agentPayload,
					})
					expect(lostAgentRes.status).toBe(500)

					const retryAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: agentPayload,
					})
					expect(retryAgentRes.status).toBe(201)
					const agent1 = (yield* Effect.promise(() => retryAgentRes.json())) as {
						id: string
						version: number
						created_at: string
					}
					expect(agent1.id).toMatch(/^agent_/)
					expect(agent1.version).toBe(1)

					const repeatAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: agentPayload,
					})
					expect(repeatAgentRes.status).toBe(201)
					const agent1Repeat = (yield* Effect.promise(() => repeatAgentRes.json())) as {
						id: string
						version: number
						created_at: string
					}
					expect(agent1Repeat.id).toBe(agent1.id)
					expect(agent1Repeat.version).toBe(1)
					expect(agent1Repeat.created_at).toBe(agent1.created_at)
					expect(new Set(sentAgentIds)).toEqual(new Set([agent1.id]))
					expect((yield* agents.get(AgentId.make(agent1.id))).version).toBe(1)

					const updatedAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agent1.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Idempotent Agent v2" },
					})
					expect(updatedAgentRes.status).toBe(200)

					const archiveAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agent1.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(archiveAgentRes.status).toBe(200)

					const retryAfterUpdateRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: agentPayload,
					})
					expect(retryAfterUpdateRes.status).toBe(201)
					expect(yield* Effect.promise(() => retryAfterUpdateRes.json())).toEqual(agent1)
					expect(new Set(sentAgentIds)).toEqual(new Set([agent1.id]))

					failNextAgentBeforeCommit = true
					const uncommittedAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-uncommitted" },
						body: agentPayload,
					})
					expect(uncommittedAgentRes.status).toBe(500)

					const { fetch: retiredCatalogFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(CreateAgentDecision, wrappedCreateAgent),
						Effect.provideService(IsSupportedAgentModel, (modelId) => modelId !== "gpt-4o-mini"),
					)

					const retryAfterCatalogRemovalRes = yield* sendRequest(retiredCatalogFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: agentPayload,
					})
					expect(retryAfterCatalogRemovalRes.status).toBe(201)
					expect(yield* Effect.promise(() => retryAfterCatalogRemovalRes.json())).toEqual(agent1)
					expect(new Set(sentAgentIds)).toEqual(new Set([agent1.id]))

					const retiredConflictRes = yield* sendRequest(retiredCatalogFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: { ...agentPayload, name: "Mismatched Retired" },
					})
					expect(retiredConflictRes.status).toBe(409)

					const uncommittedRetiredRes = yield* sendRequest(retiredCatalogFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-uncommitted" },
						body: agentPayload,
					})
					expect(uncommittedRetiredRes.status).toBe(400)

					const newRetiredKeyedRes = yield* sendRequest(retiredCatalogFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-retired-new" },
						body: agentPayload,
					})
					expect(newRetiredKeyedRes.status).toBe(400)

					const newRetiredUnkeyedRes = yield* sendRequest(retiredCatalogFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: agentPayload,
					})
					expect(newRetiredUnkeyedRes.status).toBe(400)
					expect(new Set(sentAgentIds)).toEqual(new Set([agent1.id]))

					const recoveredRetiredKeyRes = yield* sendRequest(retiredCatalogFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-retired-new" },
						body: { ...agentPayload, model: "gpt-4o" },
					})
					expect(recoveredRetiredKeyRes.status).toBe(201)

					const agentBeforeConflict = yield* agents.get(AgentId.make(agent1.id))
					const conflictAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: { ...agentPayload, name: "Different Agent Name" },
					})
					expect(conflictAgentRes.status).toBe(409)
					expect(yield* Effect.promise(() => conflictAgentRes.json())).toMatchObject({
						type: "error",
						error: {
							type: "conflict_error",
							message: "Idempotency-Key was already used for a different request.",
						},
					})
					expect(yield* agents.get(AgentId.make(agent1.id))).toEqual(agentBeforeConflict)

					const unkeyedAgent1Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: agentPayload,
					})
					const unkeyedAgent2Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: agentPayload,
					})
					expect(unkeyedAgent1Res.status).toBe(201)
					expect(unkeyedAgent2Res.status).toBe(201)
					const unkeyedAgent1 = (yield* Effect.promise(() => unkeyedAgent1Res.json())) as {
						id: string
					}
					const unkeyedAgent2 = (yield* Effect.promise(() => unkeyedAgent2Res.json())) as {
						id: string
					}
					expect(unkeyedAgent1.id).not.toBe(unkeyedAgent2.id)
					expect(unkeyedAgent1.id).not.toBe(agent1.id)

					const envPayload = {
						name: "Idempotent Env",
						description: "Scoped env",
						config: {
							type: "cloud",
							networking: {
								type: "limited",
								allow_mcp_servers: false,
								allow_package_managers: true,
								allowed_hosts: ["api.openai.com"],
							},
						},
					}
					dropNextEnvReceipt = true
					const lostEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: envPayload,
					})
					expect(lostEnvRes.status).toBe(500)

					const retryEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: {
							name: "Idempotent Env",
							description: "Scoped env",
							config: {
								networking: {
									allowed_hosts: ["api.openai.com"],
									allow_package_managers: true,
									allow_mcp_servers: false,
									type: "limited",
								},
								type: "cloud",
							},
						},
					})
					expect(retryEnvRes.status).toBe(201)
					const env1 = (yield* Effect.promise(() => retryEnvRes.json())) as {
						id: string
						version: number
						created_at: string
					}
					expect(env1.id).toMatch(/^env_/)
					expect(env1.version).toBe(1)

					const repeatEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: envPayload,
					})
					expect(repeatEnvRes.status).toBe(201)
					expect(yield* Effect.promise(() => repeatEnvRes.json())).toEqual(env1)
					expect(new Set(sentEnvironmentIds)).toEqual(new Set([env1.id]))
					expect((yield* realEnvironments.get(EnvironmentId.make(env1.id))).version).toBe(1)

					const updatedEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${env1.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Mutated Env v2" },
					})
					expect(updatedEnvRes.status).toBe(200)

					const archiveEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${env1.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(archiveEnvRes.status).toBe(200)

					const deleteEnvRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: `/v1/environments/${env1.id}`,
						headers: AUTH_HEADERS,
					})
					expect(deleteEnvRes.status).toBe(200)

					const getDeletedEnvRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/environments/${env1.id}`,
						headers: AUTH_HEADERS,
					})
					expect(getDeletedEnvRes.status).toBe(404)

					const retryAfterDeleteEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: envPayload,
					})
					expect(retryAfterDeleteEnvRes.status).toBe(201)
					expect(yield* Effect.promise(() => retryAfterDeleteEnvRes.json())).toEqual(env1)
					expect(new Set(sentEnvironmentIds)).toEqual(new Set([env1.id]))

					const stillDeletedEnvRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/environments/${env1.id}`,
						headers: AUTH_HEADERS,
					})
					expect(stillDeletedEnvRes.status).toBe(404)

					const envBeforeConflict = yield* realEnvironments.get(EnvironmentId.make(env1.id))
					const conflictEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: { ...AUTH_HEADERS, "idempotency-key": "agent-key-1" },
						body: { ...envPayload, name: "Different Env Name" },
					})
					expect(conflictEnvRes.status).toBe(409)
					expect(yield* Effect.promise(() => conflictEnvRes.json())).toMatchObject({
						type: "error",
						error: {
							type: "conflict_error",
							message: "Idempotency-Key was already used for a different request.",
						},
					})
					expect(yield* realEnvironments.get(EnvironmentId.make(env1.id))).toEqual(
						envBeforeConflict,
					)

					const unkeyedEnv1Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: envPayload,
					})
					const unkeyedEnv2Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: envPayload,
					})
					expect(unkeyedEnv1Res.status).toBe(201)
					expect(unkeyedEnv2Res.status).toBe(201)
					const unkeyedEnv1 = (yield* Effect.promise(() => unkeyedEnv1Res.json())) as {
						id: string
					}
					const unkeyedEnv2 = (yield* Effect.promise(() => unkeyedEnv2Res.json())) as {
						id: string
					}
					expect(unkeyedEnv1.id).not.toBe(unkeyedEnv2.id)
					expect(unkeyedEnv1.id).not.toBe(env1.id)

					const generatedClient = yield* makeApiTestClient(apiFetch)
					const clientAgent = yield* generatedClient.agents.create({
						headers: {},
						payload: { name: "Generated Client Agent", model: "gpt-4o-mini" },
					})
					expect("pending" in clientAgent).toBe(false)
					expect(clientAgent.id).toMatch(/^agent_/)
					const directRawClient = yield* HttpApiClient.makeWith(CheckfuApi, {
						baseUrl: "http://localhost",
						httpClient: makeApiTestHttpClient(apiFetch),
					})
					const clientAgentUnkeyed2 = yield* directRawClient.agents.create({
						headers: {},
						payload: { name: "Generated Client Agent", model: "gpt-4o-mini" },
					})
					expect(clientAgentUnkeyed2.id).not.toBe(clientAgent.id)

					const clientEnv = yield* directRawClient.environments.create({
						headers: {},
						payload: { name: "Generated Client Env" },
					})
					expect("pending" in clientEnv).toBe(false)
					expect(clientEnv.id).toMatch(/^env_/)
					const clientSession = yield* directRawClient.sessions.create({
						headers: {},
						payload: { agent: clientAgent.id, environment_id: clientEnv.id },
					})
					expect("pending" in clientSession).toBe(false)
					expect(clientSession.id).toMatch(/^sess_/)

					const agentCountBeforeClientKey = new Set(sentAgentIds).size
					dropNextAgentReceipt = true
					const lostClientAgent = yield* generatedClient.agents
						.create({
							headers: { "idempotency-key": "client-agent-key-1" },
							payload: { name: "Client Keyed Agent", model: "gpt-4o-mini" },
						})
						.pipe(Effect.flip)
					expect(lostClientAgent).toMatchObject({
						type: "error",
						error: { type: "internal_error" },
					})
					const [clientKeyedAgent1, clientKeyedAgentRes] = yield* generatedClient.agents.create({
						headers: { "idempotency-key": "client-agent-key-1" },
						payload: { name: "Client Keyed Agent", model: "gpt-4o-mini" },
						responseMode: "decoded-and-response",
					})
					expect(clientKeyedAgentRes.status).toBe(201)
					const clientKeyedAgent2 = yield* generatedClient.agents.create({
						headers: { "idempotency-key": "client-agent-key-1" },
						payload: { name: "Client Keyed Agent", model: "gpt-4o-mini" },
					})
					expect(clientKeyedAgent2).toEqual(clientKeyedAgent1)
					expect(new Set(sentAgentIds).size).toBe(agentCountBeforeClientKey + 1)
					const clientKeyedAgentConflict = yield* generatedClient.agents
						.create({
							headers: { "idempotency-key": "client-agent-key-1" },
							payload: { name: "Different Client Keyed Agent", model: "gpt-4o-mini" },
						})
						.pipe(Effect.flip)
					expect(clientKeyedAgentConflict).toMatchObject({
						type: "error",
						error: { type: "conflict_error" },
					})

					const agentSendsBeforeBadClientKey = sentAgentIds.length
					const invalidClientKey = yield* generatedClient.agents
						.create({
							headers: { "idempotency-key": "  bad  " },
							payload: { name: "Invalid Client Key Agent", model: "gpt-4o-mini" },
						})
						.pipe(Effect.flip)
					expect(invalidClientKey).toMatchObject({ _tag: "SchemaError" })
					const invalidResponseOnlyKey = yield* generatedClient.agents
						.create({
							payload: { name: "Invalid Response-Only Key Agent", model: "gpt-4o-mini" },
							headers: { "idempotency-key": "  bad  " },
							responseMode: "response-only",
						})
						.pipe(Effect.flip)
					expect(invalidResponseOnlyKey).toMatchObject({ _tag: "SchemaError" })
					expect(sentAgentIds).toHaveLength(agentSendsBeforeBadClientKey)

					const envCountBeforeClientKey = new Set(sentEnvironmentIds).size
					dropNextEnvReceipt = true
					const lostClientEnv = yield* generatedClient.environments
						.create({
							headers: { "idempotency-key": "client-env-key-1" },
							payload: { name: "Client Keyed Env" },
						})
						.pipe(Effect.flip)
					expect(lostClientEnv).toMatchObject({
						type: "error",
						error: { type: "internal_error" },
					})
					const clientKeyedEnv1 = yield* generatedClient.environments.create({
						headers: { "idempotency-key": "client-env-key-1" },
						payload: { name: "Client Keyed Env" },
					})
					const clientKeyedEnv2 = yield* generatedClient.environments.create({
						headers: { "idempotency-key": "client-env-key-1" },
						payload: { name: "Client Keyed Env" },
					})
					expect(clientKeyedEnv2).toEqual(clientKeyedEnv1)
					expect(new Set(sentEnvironmentIds).size).toBe(envCountBeforeClientKey + 1)
					const clientKeyedEnvConflict = yield* generatedClient.environments
						.create({
							headers: { "idempotency-key": "client-env-key-1" },
							payload: { name: "Different Client Keyed Env" },
						})
						.pipe(Effect.flip)
					expect(clientKeyedEnvConflict).toMatchObject({
						type: "error",
						error: { type: "conflict_error" },
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})
})

describe("Agent and environment field length limits", () => {
	const cases = [
		{
			label: "agent name",
			path: "/v1/agents",
			field: "name",
			limit: MAX_AGENT_NAME_LENGTH,
			makeCreateBody: (value: string) => ({ name: value, model: "gpt-4o-mini" }),
			makeUpdateBody: (value: string) => ({ version: 1, name: value }),
		},
		{
			label: "agent description",
			path: "/v1/agents",
			field: "description",
			limit: MAX_AGENT_DESCRIPTION_LENGTH,
			makeCreateBody: (value: string) => ({
				name: "Agent",
				model: "gpt-4o-mini",
				description: value,
			}),
			makeUpdateBody: (value: string) => ({ version: 1, description: value }),
		},
		{
			label: "agent system",
			path: "/v1/agents",
			field: "system",
			limit: MAX_AGENT_SYSTEM_LENGTH,
			makeCreateBody: (value: string) => ({
				name: "Agent",
				model: "gpt-4o-mini",
				system: value,
			}),
			makeUpdateBody: (value: string) => ({ version: 1, system: value }),
		},
		{
			label: "environment name",
			path: "/v1/environments",
			field: "name",
			limit: MAX_ENVIRONMENT_NAME_LENGTH,
			makeCreateBody: (value: string) => ({ name: value }),
			makeUpdateBody: (value: string) => ({ version: 1, name: value }),
		},
		{
			label: "environment description",
			path: "/v1/environments",
			field: "description",
			limit: MAX_ENVIRONMENT_DESCRIPTION_LENGTH,
			makeCreateBody: (value: string) => ({ name: "Environment", description: value }),
			makeUpdateBody: (value: string) => ({ version: 1, description: value }),
		},
	] as const

	for (const testCase of cases) {
		it(`enforces the ${testCase.limit}-character limit on ${testCase.label}`, async () => {
			const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
				makeAssistantReply(model, null, "ok", 1, 1),
			)
			try {
				await Effect.runPromise(
					Effect.gen(function* () {
						const { fetch: apiFetch } = yield* makeApiHandler
						const atLimit = "😀".repeat(testCase.limit)
						const overLimit = "😀".repeat(testCase.limit + 1)
						expect(atLimit.length).toBe(testCase.limit * 2)

						const createOk = yield* sendRequest(apiFetch, {
							method: "POST",
							path: testCase.path,
							headers: AUTH_HEADERS,
							body: testCase.makeCreateBody(atLimit),
						})
						expect(createOk.status).toBe(201)
						const created = (yield* Effect.promise(() => createOk.json())) as {
							readonly id: string
							readonly name?: string
							readonly description?: string | null
							readonly system?: string | null
						}
						expect(created[testCase.field]).toBe(atLimit)

						const createTooLong = yield* sendRequest(apiFetch, {
							method: "POST",
							path: testCase.path,
							headers: AUTH_HEADERS,
							body: testCase.makeCreateBody(overLimit),
						})
						expect(createTooLong.status).toBe(400)
						const createErr = (yield* Effect.promise(() => createTooLong.json())) as {
							type: string
							error: { type: string; message: string }
						}
						expect(createErr.type).toBe("error")
						expect(createErr.error.type).toBe("invalid_request_error")
						expect(createErr.error.message).toContain(testCase.field)
						expect(createErr.error.message).toContain(String(testCase.limit))

						const updatedAtLimit = "🚀".repeat(testCase.limit)
						const updatedOverLimit = "🚀".repeat(testCase.limit + 1)
						const resourceId = created.id

						const updateTooLong = yield* sendRequest(apiFetch, {
							method: "POST",
							path: `${testCase.path}/${resourceId}`,
							headers: AUTH_HEADERS,
							body: testCase.makeUpdateBody(updatedOverLimit),
						})
						expect(updateTooLong.status).toBe(400)
						const updateErr = (yield* Effect.promise(() => updateTooLong.json())) as {
							type: string
							error: { type: string; message: string }
						}
						expect(updateErr.type).toBe("error")
						expect(updateErr.error.type).toBe("invalid_request_error")
						expect(updateErr.error.message).toContain(testCase.field)
						expect(updateErr.error.message).toContain(String(testCase.limit))

						const updateOk = yield* sendRequest(apiFetch, {
							method: "POST",
							path: `${testCase.path}/${resourceId}`,
							headers: AUTH_HEADERS,
							body: testCase.makeUpdateBody(updatedAtLimit),
						})
						expect(updateOk.status).toBe(200)
						const updated = (yield* Effect.promise(() => updateOk.json())) as {
							readonly name?: string
							readonly description?: string | null
							readonly system?: string | null
						}
						expect(updated[testCase.field]).toBe(updatedAtLimit)
					}).pipe(Effect.scoped, Effect.provide(layer)),
				)
			} finally {
				await closeAll()
			}
		})
	}

	it("accepts a full-size agent sent with every character escaped, its MCP servers included", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		const escaped = (text: string) =>
			Array.from(
				{ length: text.length },
				(_, index) => `\\u${text.charCodeAt(index).toString(16).padStart(4, "0")}`,
			).join("")
		const servers = Array.from({ length: MAX_MCP_SERVERS }, (_, index) => {
			const name = `s${index}`.padEnd(MAX_MCP_SERVER_NAME_LENGTH, "a")
			const prefix = `https://mcp${index}.example/`
			const url = prefix + "a".repeat(MAX_MCP_SERVER_URL_LENGTH - prefix.length)
			return `{"type":"url","name":"${escaped(name)}","url":"${escaped(url)}"}`
		})
		const rawBody = `{"name":"${escaped("😀".repeat(MAX_AGENT_NAME_LENGTH))}","model":"gpt-4o-mini","description":"${escaped(
			"😀".repeat(MAX_AGENT_DESCRIPTION_LENGTH),
		)}","system":"${escaped("😀".repeat(MAX_AGENT_SYSTEM_LENGTH))}","mcp_servers":[${servers.join(",")}]}`
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					expect(new TextEncoder().encode(rawBody).length).toBeLessThan(MAX_AGENT_BODY_BYTES)
					expect(
						new TextEncoder().encode(rawBody).length -
							servers.reduce((total, server) => total + server.length, 0),
					).toBeGreaterThan(MAX_REQUEST_BODY_BYTES)
					const created = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						rawBody,
					})
					expect(created.status).toBe(201)
					const body = (yield* Effect.promise(() => created.json())) as {
						readonly mcp_servers: ReadonlyArray<unknown>
					}
					expect(body.mcp_servers).toHaveLength(MAX_MCP_SERVERS)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("accepts a full-size agent sent with every character escaped, its tool declarations included", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		const escaped = (text: string) =>
			Array.from(
				{ length: text.length },
				(_, index) => `\\u${text.charCodeAt(index).toString(16).padStart(4, "0")}`,
			).join("")
		const tools: Array<{
			readonly type: "custom"
			readonly name: string
			readonly description: string
		}> = []
		const next = (index: number) => ({
			type: "custom" as const,
			name: `c${index}`,
			description: "a".repeat(MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH),
		})
		const withSchema = (list: ReadonlyArray<unknown>) =>
			JSON.stringify(
				list.map((tool) => ({ ...(tool as object), input_schema: { type: "object" } })),
			)
		while (
			tools.length < MAX_CUSTOM_TOOLS &&
			withSchema([...tools, next(tools.length)]).length < MAX_AGENT_TOOLS_TEXT_LENGTH - 1024
		) {
			tools.push(next(tools.length))
		}
		const rawTools = tools
			.map(
				(tool) =>
					`{"type":"custom","name":"${tool.name}","description":"${escaped(tool.description)}","input_schema":{"type":"object"}}`,
			)
			.join(",")
		const rawBody = `{"name":"${escaped("😀".repeat(MAX_AGENT_NAME_LENGTH))}","model":"gpt-4o-mini","description":"${escaped(
			"😀".repeat(MAX_AGENT_DESCRIPTION_LENGTH),
		)}","system":"${escaped("😀".repeat(MAX_AGENT_SYSTEM_LENGTH))}","tools":[${rawTools}]}`
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					expect(withSchema(tools).length).toBeGreaterThan(MAX_AGENT_TOOLS_TEXT_LENGTH - 8192)
					expect(new TextEncoder().encode(rawBody).length).toBeLessThanOrEqual(MAX_AGENT_BODY_BYTES)
					const created = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						rawBody,
					})
					expect(created.status).toBe(201)
					const body = (yield* Effect.promise(() => created.json())) as {
						readonly tools: ReadonlyArray<unknown>
					}
					expect(body.tools).toHaveLength(tools.length)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("accepts a full-size non-ASCII agent payload past 160 KiB and advertises every limit in OpenAPI", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const body = {
						name: "😀".repeat(MAX_AGENT_NAME_LENGTH),
						model: "gpt-4o-mini",
						description: "😀".repeat(MAX_AGENT_DESCRIPTION_LENGTH),
						system: "😀".repeat(MAX_AGENT_SYSTEM_LENGTH),
					}
					const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).length
					expect(bodyBytes).toBeGreaterThan(MAX_REQUEST_BODY_BYTES)
					expect(bodyBytes).toBeLessThan(MAX_AGENT_BODY_BYTES)

					const createdRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents/",
						headers: AUTH_HEADERS,
						body,
					})
					expect(createdRes.status).toBe(201)
					const created = (yield* Effect.promise(() => createdRes.json())) as {
						id: string
						name: string
						description: string
						system: string
					}
					expect(created.name).toBe(body.name)
					expect(created.description).toBe(body.description)
					expect(created.system).toBe(body.system)

					const tooLargeRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${created.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, system: "x".repeat(MAX_AGENT_BODY_BYTES + 1) },
					})
					expect(tooLargeRes.status).toBe(413)

					const spec = openApiDocument<{
						paths: Record<
							string,
							Record<
								string,
								{
									requestBody?: { content?: { "application/json"?: { schema?: unknown } } }
									responses?: Record<
										string,
										{ content?: { "application/json"?: { schema?: unknown } } }
									>
								}
							>
						>
					}>()
					const schemaJson = (path: string, method: string) =>
						JSON.stringify(
							spec.paths[path]?.[method]?.requestBody?.content?.["application/json"]?.schema,
						)
					for (const json of [
						schemaJson("/v1/agents", "post"),
						schemaJson("/v1/agents/{agent_id}", "post"),
					]) {
						expect(json).toContain(`"maxLength":${MAX_AGENT_NAME_LENGTH}`)
						expect(json).toContain(`"maxLength":${MAX_AGENT_DESCRIPTION_LENGTH}`)
						expect(json).toContain(`"maxLength":${MAX_AGENT_SYSTEM_LENGTH}`)
					}
					for (const json of [
						schemaJson("/v1/environments", "post"),
						schemaJson("/v1/environments/{environment_id}", "post"),
					]) {
						expect(json).toContain(`"maxLength":${MAX_ENVIRONMENT_NAME_LENGTH}`)
						expect(json).toContain(`"maxLength":${MAX_ENVIRONMENT_DESCRIPTION_LENGTH}`)
					}
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	const makeDurableObjectsPlatform = (
		testScope: Scope.Scope,
		backingStore: Map<string, Map<string, Uint8Array>>,
		onWrite?: (write: {
			readonly className: string
			readonly objectId: string
			readonly key: string
			readonly bytes: number
		}) => void,
	) => {
		const makeStorage = (className: string, objectId: string): DurableObjects.ObjectStorage => {
			const storeKey = `${className}:${objectId}`
			let data = backingStore.get(storeKey)
			if (data === undefined) {
				data = new Map<string, Uint8Array>()
				backingStore.set(storeKey, data)
			}
			const recordWrite = (key: string, value: unknown) => {
				const encoded = v8.serialize(value)
				onWrite?.({ className, objectId, key, bytes: encoded.byteLength })
				data.set(key, encoded)
			}
			return {
				get: <T>(key: string) =>
					Effect.sync(() => {
						const raw = data.get(key)
						return raw === undefined ? undefined : (v8.deserialize(raw) as T)
					}),
				put: (keyOrEntries: unknown, value?: unknown) =>
					Effect.sync(() => {
						if (typeof keyOrEntries === "string") {
							recordWrite(keyOrEntries, value)
						} else if (typeof keyOrEntries === "object" && keyOrEntries !== null) {
							for (const [key, entry] of Object.entries(keyOrEntries)) {
								recordWrite(key, entry)
							}
						}
					}),
				delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
					Effect.sync(() => {
						if (typeof keyOrKeys === "string") {
							return data.delete(keyOrKeys)
						}
						let removed = 0
						for (const key of keyOrKeys) {
							if (data.delete(key)) {
								removed += 1
							}
						}
						return removed
					})) as DurableObjects.ObjectStorage["delete"],
				list: <T>(options?: DurableObjects.ListOptions) =>
					Effect.sync(() => {
						let keys = [...data.keys()].sort()
						if (options?.prefix !== undefined) {
							keys = keys.filter((key) => key.startsWith(options.prefix!))
						}
						if (options?.start !== undefined) {
							keys = keys.filter((key) => key >= options.start!)
						}
						if (options?.startAfter !== undefined) {
							keys = keys.filter((key) => key > options.startAfter!)
						}
						if (options?.end !== undefined) {
							keys = keys.filter((key) => key < options.end!)
						}
						if (options?.reverse) {
							keys.reverse()
						}
						if (options?.limit !== undefined) {
							keys = keys.slice(0, options.limit)
						}
						return new Map(keys.map((key) => [key, v8.deserialize(data.get(key)!) as T]))
					}),
				transaction: (effect) => effect,
			}
		}

		const host: DurableObjects.Host = {
			claimKey: Effect.succeed({}),
			declare: (_model, className, impl) =>
				Effect.sync((): DurableObjects.Namespace => {
					const instances = new Map<string, Effect.Effect<object, never, never>>()
					const getInstance = (objectId: string) => {
						let existing = instances.get(objectId)
						if (existing === undefined) {
							const storage = makeStorage(className, objectId)
							const gate = Semaphore.makeUnsafe(1)
							let alarmAt: number | null = null
							let fireAlarm: Effect.Effect<void> = Effect.void
							const { callbacks, fire } = storageCallbacks(storage, {
								get: Effect.sync(() => alarmAt),
								set: (at) =>
									Effect.gen(function* () {
										alarmAt = at
										const delay = Math.max(0, at - (yield* Clock.currentTimeMillis))
										yield* Effect.forkIn(
											Effect.sleep(Duration.millis(delay)).pipe(
												Effect.andThen(
													Effect.suspend(() => {
														alarmAt = null
														return fireAlarm
													}),
												),
											),
											testScope,
										)
									}),
							})
							fireAlarm = fire
							const runtimeContext: BaseRuntimeContext = {
								Type: "Test",
								id: `${className}:${objectId}`,
								env: {},
								get: () => Effect.undefined,
								set: (id) => Effect.succeed(id),
							}
							const objectState: DurableObjects.ObjectStateShape = {
								storage,
								exclusive: (effect) => gate.withPermit(effect),
								waitUntil: (effect) => Effect.forkIn(effect, testScope).pipe(Effect.asVoid),
							}
							const built = impl.pipe(
								Effect.provideService(DurableObjects.ObjectState, objectState),
								Effect.provideService(RuntimeContext, runtimeContext),
								Effect.provide(callbacks),
								Effect.provideService(Scope.Scope, testScope),
							)
							existing = Effect.runSync(Effect.cached(built))
							instances.set(objectId, existing)
						}
						return existing
					}
					return {
						getByName: (objectId) =>
							new Proxy(
								{},
								{
									get:
										(_target, prop) =>
										(...args: ReadonlyArray<unknown>) =>
											Effect.flatMap(getInstance(objectId), (methods) => {
												const entry = Object.entries(methods).find(([key]) => key === String(prop))
												const fn = entry?.[1] as (
													...callArgs: ReadonlyArray<unknown>
												) => Effect.Effect<unknown>
												return fn(...args)
											}),
								},
							),
					}
				}),
		}

		return DurableObjects.makePlatform(host).pipe(Layer.provide(SecureRandom.layerWebCrypto))
	}

	const makeAgentEnvironmentLayer = (...args: Parameters<typeof makeDurableObjectsPlatform>) =>
		Layer.mergeAll(Agents.layer(Layer.empty), Environments.layer(Layer.empty)).pipe(
			Layer.provide(makeDurableObjectsPlatform(...args)),
			Layer.provide(SecureRandom.layerWebCrypto),
		)

	it("keeps every persisted Durable Object value for worst-case agent decisions and environment commands below 2 MiB in V8 structured clone", async () => {
		const DO_ROW_LIMIT_BYTES = 2 * 1024 * 1024
		const ENVELOPE_HEADROOM_BYTES = 64 * 1024
		const MAX_ROW_BYTES = DO_ROW_LIMIT_BYTES - ENVELOPE_HEADROOM_BYTES
		const writes: Array<{
			readonly className: string
			readonly objectId: string
			readonly key: string
			readonly bytes: number
		}> = []

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const testScope = yield* Scope.Scope
					const layer = makeAgentEnvironmentLayer(testScope, new Map(), (write) => {
						writes.push(write)
					})

					yield* Effect.gen(function* () {
						const createAgent = yield* CreateAgentDecision
						const updateAgent = yield* UpdateAgentDecision
						const agentViews = yield* AgentView
						const byNumberViews = yield* AgentVersionByNumberView
						const environments = yield* Environment
						const envViews = yield* EnvironmentView

						const commitFor = (
							commits: ReadonlyArray<{ readonly stream: string; readonly version: number }>,
							stream: string,
						) => commits.find((commit) => commit.stream === stream)!

						const agentId = AgentId.make("agent_do_size_emoji")
						const v1Id = AgentVersionId.make("aver_do_size_emoji_1")
						const v2Id = AgentVersionId.make("aver_do_size_emoji_2")

						const maxLengthModelId = (char: string) => {
							const prefix = "openai/"
							const remainingUnits = MAX_MODEL_ID_LENGTH - prefix.length
							const repeatCount = Math.floor(remainingUnits / char.length)
							const pad = "a".repeat(remainingUnits - repeatCount * char.length)
							return `${prefix}${pad}${char.repeat(repeatCount)}`
						}

						const createReceipt = yield* createAgent.send(
							new CreateAgent({
								agent_id: agentId,
								version_id: v1Id,
								name: "😀".repeat(MAX_AGENT_NAME_LENGTH),
								model: { id: maxLengthModelId("😀") },
								system: "😀".repeat(MAX_AGENT_SYSTEM_LENGTH),
								description: "😀".repeat(MAX_AGENT_DESCRIPTION_LENGTH),
								mcp_servers: "漢".repeat(MAX_MCP_SERVERS_TEXT_LENGTH),
								tools: "漢".repeat(MAX_AGENT_TOOLS_TEXT_LENGTH),
							}),
						)
						expect(
							Option.isSome(
								yield* agentViews.get(Agent.ref(agentId), {
									atLeast: commitFor(createReceipt.commits, `Agent/${agentId}`),
								}),
							),
						).toBe(true)
						expect(
							Option.isSome(
								yield* byNumberViews.get(agentVersionLookupKey(agentId, 1), {
									atLeast: commitFor(createReceipt.commits, `Agent/${agentId}`),
								}),
							),
						).toBe(true)

						const updateReceipt = yield* updateAgent.send(
							new UpdateAgent({
								agent_id: agentId,
								expected_version: 1,
								next_version_id: v2Id,
								changes: {
									name: "🚀".repeat(MAX_AGENT_NAME_LENGTH),
									model: { id: maxLengthModelId("🚀") },
									system: "🚀".repeat(MAX_AGENT_SYSTEM_LENGTH),
									description: "🚀".repeat(MAX_AGENT_DESCRIPTION_LENGTH),
									mcp_servers: "語".repeat(MAX_MCP_SERVERS_TEXT_LENGTH),
									tools: "語".repeat(MAX_AGENT_TOOLS_TEXT_LENGTH),
								},
							}),
						)
						expect(
							Option.isSome(
								yield* agentViews.get(Agent.ref(agentId), {
									atLeast: commitFor(updateReceipt.commits, `Agent/${agentId}`),
								}),
							),
						).toBe(true)

						for (const [suffix, char] of [
							["bmp", "漢"],
							["nul", "\u0000"],
						] as const) {
							const id = AgentId.make(`agent_do_size_${suffix}`)
							const versionId = AgentVersionId.make(`aver_do_size_${suffix}_1`)
							const receipt = yield* createAgent.send(
								new CreateAgent({
									mcp_servers: NO_MCP_SERVERS,
									tools: NO_AGENT_TOOLS,
									agent_id: id,
									version_id: versionId,
									name: char.repeat(MAX_AGENT_NAME_LENGTH),
									model: { id: maxLengthModelId(char) },
									system: char.repeat(MAX_AGENT_SYSTEM_LENGTH),
									description: char.repeat(MAX_AGENT_DESCRIPTION_LENGTH),
								}),
							)
							expect(
								Option.isSome(
									yield* agentViews.get(Agent.ref(id), {
										atLeast: commitFor(receipt.commits, `Agent/${id}`),
									}),
								),
							).toBe(true)
						}

						const envId = EnvironmentId.make("env_do_size_emoji")
						const envCreateReceipt = yield* environments.send(
							new CreateEnvironment({
								environment_id: envId,
								name: "😀".repeat(MAX_ENVIRONMENT_NAME_LENGTH),
								description: "😀".repeat(MAX_ENVIRONMENT_DESCRIPTION_LENGTH),
								config: {
									type: "cloud",
									networking: {
										type: "limited",
										allow_mcp_servers: false,
										allow_package_managers: true,
										allowed_hosts: ["api.openai.com"],
									},
								},
							}),
						)
						expect(
							Option.isSome(
								yield* envViews.get(Environment.ref(envId), { atLeast: envCreateReceipt }),
							),
						).toBe(true)

						const envUpdateReceipt = yield* environments.send(
							new UpdateEnvironment({
								environment_id: envId,
								expected_version: 1,
								changes: {
									name: "🚀".repeat(MAX_ENVIRONMENT_NAME_LENGTH),
									description: "🚀".repeat(MAX_ENVIRONMENT_DESCRIPTION_LENGTH),
									config: { type: "cloud", networking: { type: "unrestricted" } },
								},
							}),
						)
						expect(
							Option.isSome(
								yield* envViews.get(Environment.ref(envId), { atLeast: envUpdateReceipt }),
							),
						).toBe(true)
					}).pipe(Effect.provide(layer))
				}),
			),
		)

		const primaryIntents = writes.filter(
			(write) => write.className === "AgentAggregate" && write.key === "intent",
		)
		expect(primaryIntents.length).toBeGreaterThanOrEqual(4)
		expect(Math.max(...primaryIntents.map((write) => write.bytes))).toBeGreaterThan(1_800_000)
		expect(writes.some((write) => write.key.startsWith("decided:"))).toBe(true)
		expect(writes.some((write) => write.key.startsWith("receipt:"))).toBe(true)
		expect(writes.some((write) => write.key.startsWith("event:"))).toBe(true)
		expect(writes.some((write) => write.key === "meta")).toBe(true)
		expect(writes.some((write) => write.key === "snapshot")).toBe(true)
		const largest = Math.max(...writes.map((write) => write.bytes))
		expect(largest).toBeLessThan(MAX_ROW_BYTES)
	})

	it("measures durable admission and bootstrap envelopes for maximum initial messages", async () => {
		const ROW_LIMIT_BYTES = 8_000_000
		const ENVELOPE_HEADROOM_BYTES = 64 * 1024
		const writes: Array<{
			readonly className: string
			readonly key: string
			readonly bytes: number
		}> = []
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Scope.Scope
					const platform = makeDurableObjectsPlatform(scope, new Map(), (write) => {
						writes.push(write)
					})
					const layer = SessionAdmissionStorage.layer(RecordInitialMessagesLive).pipe(
						Layer.provide(platform),
						Layer.provide(SecureRandom.layerWebCrypto),
					)
					yield* Effect.gen(function* () {
						const createAgent = yield* CreateAgentDecision
						const environments = yield* Environment
						const admit = yield* AdmitSessionWithMessagesDecision
						const turns = yield* TurnInput
						const agent_id = AgentId.make("agent_initial_messages_storage")
						const environment_id = EnvironmentId.make("env_initial_messages_storage")
						yield* createAgent.send(
							new CreateAgent({
								mcp_servers: NO_MCP_SERVERS,
								tools: NO_AGENT_TOOLS,
								agent_id,
								version_id: AgentVersionId.make("aver_initial_messages_storage"),
								name: "Reporter",
								model: { id: "fixture-model" },
								system: null,
								description: null,
							}),
						)
						yield* environments.send(
							new CreateEnvironment({
								environment_id,
								name: "Cloud",
								description: null,
								config: { type: "cloud", networking: { type: "unrestricted" } },
							}),
						)
						const resources = yield* Schema.decodeUnknownEffect(SessionResources)(
							Array.from({ length: 8 }, (_, index) => ({
								id: `sesrsc_size_${index}`,
								type: "memory_store",
								memory_store_id: `memst_size_${index}`,
								access: "read_write",
								instructions: "漢".repeat(4096),
								name: `Reports ${index}`,
								description: "漢".repeat(1024),
								mount_path: `/mnt/memory/reports-${index}`,
							})),
						)
						const max = MAX_SESSION_INITIAL_MESSAGES_BYTES
						const samples = [
							["ascii", fullAsciiInitialMessages()],
							["under", mixedInitialMessagesAt(max - 1)],
							["exact", mixedInitialMessagesAt(max)],
						] as const
						const encoder = new TextEncoder()
						for (const [label, messages] of samples) {
							const session_id = SessionId.make(`sess_initial_messages_${label}`)
							const encoded = encodeInitialMessages(messages)
							const before = writes.length
							const receipt = yield* admit.send(
								new AdmitSessionWithMessages({
									session_id,
									agent_id,
									agent_version: 1,
									environment_id,
									title: "漢".repeat(1024),
									resources,
									mcp_server_credentials: "[]",
									initial_messages: { count: messages.length, messages: encoded },
								}),
							)
							expect(receipt.events[0]?.initial_messages?.messages === encoded, label).toBe(true)
							const turn = yield* turns.waitFor(
								Session.ref(session_id),
								{ turn: 1 },
								{ timeout: "5 seconds" },
							)
							expect(turn?.input.length, label).toBe(messages.length)
							expect(
								turn?.input.every((text, index) => text === messages[index]),
								label,
							).toBe(true)
							const rows = writes.slice(before)
							const primaryIntent = rows.find(
								({ className, key }) => className === "AgentAggregate" && key === "intent",
							)
							const creation = rows.find(
								({ className, key }) =>
									className === "SessionAggregate" && key.startsWith("event:"),
							)
							expect(creation?.bytes, label).toBeGreaterThan(encoder.encode(encoded).byteLength)
							expect(primaryIntent?.bytes, label).toBeGreaterThan(
								2 * (creation?.bytes ?? 0) - 64 * 1024,
							)
							expect(Math.max(...rows.map(({ bytes }) => bytes)), label).toBeLessThan(
								ROW_LIMIT_BYTES - ENVELOPE_HEADROOM_BYTES,
							)
							if (label === "exact") {
								expect(primaryIntent?.bytes).toBeGreaterThan(4 * 1024 * 1024)
							}
						}
					}).pipe(Effect.provide(layer))
				}),
			),
		)
	}, 30_000)
})
