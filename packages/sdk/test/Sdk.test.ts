import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { AgentResource, SessionResource, SessionStatusRunningEvent } from "../src/Api.ts"
import { INTERNAL_EFFECT_RUNTIME } from "../src/Client.ts"
import {
	executePaginatedPromise,
	executeSseStreamPromise,
	executeUnaryPromise,
	makePromiseSdkRuntime,
} from "../src/PromiseRuntime.ts"
import { attachPendingReadiness } from "../src/Runtime.ts"
import { makeAuthorizedHttpClient } from "../src/Transport.ts"
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIPromise,
	APIUserAbortError,
	AuthenticationError,
	BadRequestError,
	Checkfu,
	CheckfuApi,
	CheckfuClient,
	CheckfuConfigError,
	CheckfuError,
	ConflictError,
	EffectAgentsResource,
	EffectSessionsEventsResource,
	InternalServerError,
	NotFoundError,
	PaginationCursorCycleError,
	PayloadTooLargeError,
	PermissionDeniedError,
	RateLimitError,
	SDK_OPERATION_BINDINGS,
	ServiceUnavailableError,
	UnexpectedStatusError,
	UnprocessableEntityError,
	UnsupportedMediaTypeError,
	isAPIError,
	isPendingResource,
	normalizeApiUrl,
	streamApiSse,
} from "../src/index.ts"
import type {
	BodyOf,
	JsonResultOf,
	JsonSessionEvent,
	Op,
	PendingArtifact,
	PendingArtifactVersion,
	ResultOf,
} from "../src/index.ts"

const ISO_NOW = "2026-11-23T18:00:00.000Z"

const expectNotCallable =
	<Fn>(_fn: Fn) =>
	<Args extends ReadonlyArray<unknown>>(
		..._check: Fn extends (...args: Args) => void ? [never] : []
	): void => {}

const toWebRequest = (input: RequestInfo | URL, init?: RequestInit): Request =>
	new Request(input, init)

const jsonResponse = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"request-id": "req_test_123",
			...headers,
		},
	})

const apiErrorBody = (
	type:
		| "invalid_request_error"
		| "authentication_error"
		| "not_found_error"
		| "conflict_error"
		| "payload_too_large"
		| "unsupported_media_type"
		| "rate_limit_error"
		| "internal_error"
		| "service_unavailable",
	message: string,
	extra?: {
		readonly accepted?: ReadonlyArray<unknown>
		readonly failed_index?: number
		readonly unconfirmed_index?: number
	},
) => ({
	type: "error",
	error: { type, message },
	request_id: "req_err_456",
	...extra,
})

const sampleAgent = (overrides?: {
	readonly id?: string
	readonly version?: number
	readonly name?: string
	readonly archived_at?: string | null
}) => ({
	id: "agent_1",
	type: "agent" as const,
	mcp_servers: [],
	tools: [],
	version: 1,
	name: "Assistant",
	model: { id: "gpt-6.2-sol" },
	system: "Be concise.",
	description: null,
	created_at: ISO_NOW,
	updated_at: ISO_NOW,
	archived_at: null,
	...overrides,
})

const sampleAutomation = (overrides?: {
	readonly id?: string
	readonly status?: "active" | "paused" | "archived"
	readonly archived_at?: string | null
}) => ({
	id: "auto_1",
	type: "automation" as const,
	name: "Morning report",
	description: null,
	agent: { id: "agent_1", version: 1 },
	environment_id: "env_1",
	initial_events: [
		{ type: "user.message" as const, content: [{ type: "text" as const, text: "Report." }] },
	],
	schedule: { type: "cron" as const, expression: "0 9 * * *", timezone: "UTC" },
	status: "active" as const,
	pause_reason: null,
	run_count: 0,
	last_run_at: null,
	upcoming_runs_at: [],
	created_at: ISO_NOW,
	updated_at: ISO_NOW,
	archived_at: null,
	...overrides,
})

const sampleEnvironment = (overrides?: {
	readonly id?: string
	readonly version?: number
	readonly name?: string
	readonly archived_at?: string | null
}) => ({
	id: "env_1",
	type: "environment" as const,
	version: 1,
	name: "default",
	description: null,
	config: { type: "cloud" as const, networking: { type: "unrestricted" as const } },
	created_at: ISO_NOW,
	updated_at: ISO_NOW,
	archived_at: null,
	...overrides,
})

const sampleSession = (overrides?: {
	readonly id?: string
	readonly status?: "idle" | "running" | "terminated"
	readonly archived_at?: string | null
}) => ({
	id: "sess_1",
	type: "session" as const,
	mcp_server_credentials: [],
	status: "idle" as const,
	agent: sampleAgent(),
	environment_id: "env_1",
	title: "Demo",
	resources: [],
	turn: 0,
	usage: { input_tokens: 0, output_tokens: 0 },
	created_at: ISO_NOW,
	updated_at: ISO_NOW,
	archived_at: null,
	...overrides,
})

const sampleArtifactFiles = [
	{ path: "index.html", sha256: "a".repeat(64), size: 14, content_type: "text/html" },
]

const sampleArtifact = (overrides?: { readonly id?: string; readonly version?: number }) => ({
	id: "art_1",
	type: "artifact" as const,
	name: "Report",
	version: 1,
	file_count: 1,
	total_bytes: 14,
	files: sampleArtifactFiles,
	publication: null,
	created_at: ISO_NOW,
	updated_at: ISO_NOW,
	...overrides,
})

const sampleArtifactVersion = (overrides?: {
	readonly artifact_id?: string
	readonly version?: number
}) => ({
	type: "artifact_version" as const,
	artifact_id: "art_1",
	version: 1,
	file_count: 1,
	total_bytes: 14,
	files: sampleArtifactFiles,
	publication: null,
	created_at: ISO_NOW,
	...overrides,
})

const sampleUserMessageEvent = (seq: number, text = `msg-${seq}`) => ({
	id: `evt_${seq}`,
	seq,
	type: "user.message",
	created_at: ISO_NOW,
	processed_at: ISO_NOW,
	content: [{ type: "text", text }],
})

const sampleArchivedEvent = (seq: number) => ({
	id: `evt_${seq}`,
	seq,
	type: "session.archived",
	created_at: ISO_NOW,
	processed_at: ISO_NOW,
})

const sseFrame = (event: { readonly seq: number; readonly type: string }) =>
	`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

const makeEffectLayer = (
	fetchImpl: typeof globalThis.fetch,
	config?: {
		readonly apiKey?: string
		readonly baseUrl?: string
		readonly maxRetries?: number
		readonly timeout?: number | null
		readonly defaultHeaders?: Readonly<Record<string, string | null | undefined>>
		readonly autoIdempotencyKey?: boolean
	},
) =>
	CheckfuClient.layerFetch({
		apiKey: config?.apiKey ?? "ck_test_key",
		baseUrl: config?.baseUrl ?? "http://localhost:1337",
		...(config?.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
		...(config?.timeout === undefined ? {} : { timeout: config.timeout }),
		...(config?.defaultHeaders === undefined ? {} : { defaultHeaders: config.defaultHeaders }),
		...(config?.autoIdempotencyKey === undefined
			? {}
			: { autoIdempotencyKey: config.autoIdempotencyKey }),
		fetch: fetchImpl,
	})

describe("Resource responses", () => {
	it("requires the server and tool arrays and the session's credential bindings", () => {
		const { mcp_servers: _servers, ...withoutServers } = sampleAgent()
		const { tools: _tools, ...withoutTools } = sampleAgent()
		const { mcp_server_credentials: _credentials, ...withoutCredentials } = sampleSession()
		const readAgent = Schema.decodeUnknownSync(Schema.toCodecJson(AgentResource))
		const readSession = Schema.decodeUnknownSync(Schema.toCodecJson(SessionResource))
		expect(() => readAgent(withoutServers)).toThrow(/mcp_servers/u)
		expect(() => readAgent(withoutTools)).toThrow(/tools/u)
		expect(() => readSession(withoutCredentials)).toThrow(/mcp_server_credentials/u)
		const bound = [
			{ mcp_server_name: "docs", credential_id: "cred_1" },
			{ mcp_server_name: "files", credential_id: "cred_2", vault_id: "vlt_1" },
		]
		expect(
			readSession({ ...sampleSession(), mcp_server_credentials: bound }).mcp_server_credentials,
		).toEqual(bound)
	})
	it("requires a turn number on a running status event", () => {
		const read = Schema.decodeUnknownSync(Schema.toCodecJson(SessionStatusRunningEvent))
		const event = {
			id: "evt_1",
			seq: 1,
			type: "session.status_running",
			created_at: ISO_NOW,
			processed_at: ISO_NOW,
		}
		expect(() => read(event)).toThrow(/turn/u)
		expect(read({ ...event, turn: 1 }).turn).toBe(1)
	})
})

describe("@checkfu/sdk", () => {
	describe("config & URL security", () => {
		it.effect("normalizes valid base URLs and rejects insecure or malformed URLs", () =>
			Effect.gen(function* () {
				expect(yield* normalizeApiUrl("http://localhost:1337/v1/")).toBe("http://localhost:1337")
				expect(yield* normalizeApiUrl("https://api.checkfu.dev/prefix/v1")).toBe(
					"https://api.checkfu.dev/prefix",
				)
				expect(
					yield* normalizeApiUrl("http://internal.example.test/v1", { allowInsecureHttp: true }),
				).toBe("http://internal.example.test")

				const emptyErr = yield* Effect.flip(normalizeApiUrl("   "))
				expect(emptyErr._tag).toBe("CheckfuConfigError")
				expect(emptyErr).toBeInstanceOf(CheckfuError)

				const insecureErr = yield* Effect.flip(normalizeApiUrl("http://api.checkfu.dev"))
				expect(insecureErr._tag).toBe("CheckfuConfigError")
				expect(insecureErr.message).toContain("insecure HTTP")

				const credsErr = yield* Effect.flip(normalizeApiUrl("https://user:pass@api.checkfu.dev"))
				expect(credsErr.message).toContain("credentials")

				const queryErr = yield* Effect.flip(normalizeApiUrl("https://api.checkfu.dev?foo=bar"))
				expect(queryErr.message).toContain("query")

				const schemeErr = yield* Effect.flip(normalizeApiUrl("ftp://api.checkfu.dev"))
				expect(schemeErr.message).toContain("Unsupported")
			}),
		)

		it.effect(
			"resolves layerFromEnv using CHECKFU_API_KEY and CHECKFU_BASE_URL > CHECKFU_API_URL > CHECKFU_URL",
			() =>
				Effect.gen(function* () {
					const primary = yield* CheckfuClient
					expect(primary.baseUrl).toBe("https://base.checkfu.dev")
				}).pipe(
					Effect.provide(
						CheckfuClient.layerFromEnv().pipe(
							Layer.provide(
								Layer.mergeAll(
									FetchHttpClient.layer,
									SecureRandom.layerWebCrypto,
									ConfigProvider.layer(
										ConfigProvider.fromUnknown({
											CHECKFU_API_KEY: "ck_env_key",
											CHECKFU_BASE_URL: "https://base.checkfu.dev/v1",
											CHECKFU_API_URL: "https://primary.checkfu.dev/v1",
											CHECKFU_URL: "https://fallback.checkfu.dev",
										}),
									),
								),
							),
						),
					),
				),
		)

		it.effect("falls back to CHECKFU_API_URL > CHECKFU_URL when CHECKFU_BASE_URL is unset", () =>
			Effect.gen(function* () {
				const client = yield* CheckfuClient
				expect(client.baseUrl).toBe("https://primary.checkfu.dev")
			}).pipe(
				Effect.provide(
					CheckfuClient.layerFromEnv().pipe(
						Layer.provide(
							Layer.mergeAll(
								FetchHttpClient.layer,
								SecureRandom.layerWebCrypto,
								ConfigProvider.layer(
									ConfigProvider.fromUnknown({
										CHECKFU_API_KEY: "ck_env_key",
										CHECKFU_API_URL: "https://primary.checkfu.dev/v1",
										CHECKFU_URL: "https://fallback.checkfu.dev",
									}),
								),
							),
						),
					),
				),
			),
		)

		it("validates Checkfu constructor config eagerly and supports baseURL alias", () => {
			expect(() => new Checkfu({ apiKey: "   " })).toThrow(CheckfuConfigError)
			expect(
				() =>
					new Checkfu({
						apiKey: "ck_test",
						baseUrl: "https://a.checkfu.dev",
						baseURL: "https://b.checkfu.dev",
					}),
			).toThrow(CheckfuConfigError)
			expect(() => new Checkfu({ apiKey: "ck_test", maxRetries: -1 })).toThrow(CheckfuConfigError)
			expect(() => new Checkfu({ apiKey: "ck_test", timeout: 0 })).toThrow(CheckfuConfigError)

			const client = new Checkfu({
				apiKey: "ck_test",
				baseURL: "https://api.checkfu.dev/v1/",
			})
			expect(client.baseUrl).toBe("https://api.checkfu.dev")
			void client.close()
		})
	})

	describe("Effect-native CheckfuClient", () => {
		it.effect(
			"supports full resource operations, DateTime.Utc decoding, headers, and withResponse",
			() =>
				Effect.gen(function* () {
					const seen: Array<{
						readonly method: string
						readonly url: string
						readonly auth: string | null
						readonly custom: string | null
						readonly removed: string | null
						readonly idempotencyKey: string | null
					}> = []

					const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						seen.push({
							method: req.method,
							url: req.url,
							auth: req.headers.get("authorization"),
							custom: req.headers.get("x-custom"),
							removed: req.headers.get("x-default-remove"),
							idempotencyKey: req.headers.get("idempotency-key"),
						})
						const url = new URL(req.url)
						if (req.method === "POST" && url.pathname === "/v1/agents") {
							return jsonResponse(sampleAgent(), 201)
						}
						if (req.method === "GET" && url.pathname === "/v1/agents/agent_1") {
							return jsonResponse(sampleAgent())
						}
						if (req.method === "POST" && url.pathname === "/v1/agents/agent_1") {
							return jsonResponse(sampleAgent({ version: 2, name: "Renamed" }))
						}
						if (req.method === "POST" && url.pathname === "/v1/agents/agent_1/archive") {
							return jsonResponse(sampleAgent({ archived_at: ISO_NOW }))
						}
						if (req.method === "DELETE" && url.pathname === "/v1/environments/env_1") {
							return jsonResponse({ id: "env_1", type: "environment_deleted" })
						}
						if (req.method === "POST" && url.pathname === "/v1/sessions/sess_1/events") {
							return jsonResponse({
								data: [
									{
										type: "user.message",
										id: "evt_c1",
										processed_at: null,
										turn: 1,
										queued: false,
										content: [{ type: "text", text: "hi" }],
									},
									{ type: "user.interrupt", id: "evt_interrupt", processed_at: null },
								],
							})
						}
						return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
					}) as typeof globalThis.fetch

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const created = yield* client.agents.create(
							{ name: "Assistant", model: "gpt-6.2-sol" },
							{
								withResponse: true,
								headers: { "x-custom": "override", "x-default-remove": null },
							},
						)
						expect(created.status).toBe(201)
						expect(created.requestId).toBe("req_test_123")
						expect(isPendingResource(created.data)).toBe(false)
						if (!isPendingResource(created.data)) {
							expect(DateTime.isDateTime(created.data.created_at)).toBe(true)
							expect(DateTime.formatIso(created.data.created_at)).toBe(ISO_NOW)
						}
						expect(seen[0]?.auth).toBe("Bearer ck_test_key")
						expect(seen[0]?.custom).toBe("override")
						expect(seen[0]?.removed).toBeNull()
						expect(seen[0]?.idempotencyKey).toMatch(/^sdk_[0-9a-f]{24}$/)

						const retrieved = yield* client.agents.retrieve("agent_1")
						expect(retrieved.id).toBe("agent_1")

						const updated = yield* client.agents.update("agent_1", { version: 1, name: "Renamed" })
						expect(!isPendingResource(updated) && updated.version).toBe(2)

						const archived = yield* client.agents.archive("agent_1")
						expect(!isPendingResource(archived) && archived.archived_at !== null).toBe(true)

						const requestsBefore = seen.length
						expectNotCallable(client.agents.archive)<[number]>()
						expectNotCallable(client.agents.retrieve)<[]>()
						const looseAgents = client.agents as unknown as {
							archive(id: unknown): ReturnType<typeof client.agents.archive>
							retrieve(): ReturnType<typeof client.agents.retrieve>
						}
						const numericId = yield* Effect.flip(looseAgents.archive(123))
						const missingId = yield* Effect.flip(looseAgents.retrieve())
						expect([numericId._tag, missingId._tag]).toEqual(["BadRequestError", "BadRequestError"])
						expect(seen.length).toBe(requestsBefore)

						const deleted = yield* client.environments.delete("env_1")
						expect(deleted).toEqual({ id: "env_1", type: "environment_deleted" })

						const sent = yield* client.sessions.events.send(
							"sess_1",
							{
								events: [
									{ id: "evt_c1", type: "user.message", content: [{ type: "text", text: "hi" }] },
									{ type: "user.interrupt" },
								],
							},
							{ idempotencyKey: "explicit-key-1" },
						)
						expect(sent.data).toHaveLength(2)
						expect(sent.data[0]?.type).toBe("user.message")
						expect(sent.data[1]?.type).toBe("user.interrupt")
						expect(seen.at(-1)?.idempotencyKey).toBe("explicit-key-1")
					}).pipe(
						Effect.provide(
							makeEffectLayer(mockFetch, {
								defaultHeaders: { "x-custom": "default", "x-default-remove": "yes" },
							}),
						),
					)
				}),
		)

		it.effect(
			"maps all HTTP status codes to Data.TaggedError subclasses and preserves metadata",
			() =>
				Effect.gen(function* () {
					const cases = [
						{
							status: 400,
							body: apiErrorBody("invalid_request_error", "bad"),
							tag: "BadRequestError",
							cls: BadRequestError,
						},
						{
							status: 401,
							body: apiErrorBody("authentication_error", "unauth"),
							tag: "AuthenticationError",
							cls: AuthenticationError,
						},
						{
							status: 403,
							body: "forbidden",
							tag: "PermissionDeniedError",
							cls: PermissionDeniedError,
						},
						{
							status: 404,
							body: apiErrorBody("not_found_error", "missing"),
							tag: "NotFoundError",
							cls: NotFoundError,
						},
						{
							status: 409,
							body: apiErrorBody("conflict_error", "conflict"),
							tag: "ConflictError",
							cls: ConflictError,
						},
						{
							status: 413,
							body: apiErrorBody("payload_too_large", "too big"),
							tag: "PayloadTooLargeError",
							cls: PayloadTooLargeError,
						},
						{
							status: 415,
							body: apiErrorBody("unsupported_media_type", "bad ct"),
							tag: "UnsupportedMediaTypeError",
							cls: UnsupportedMediaTypeError,
						},
						{
							status: 429,
							body: apiErrorBody("rate_limit_error", "slow down", {
								accepted: [{ type: "user.interrupt", id: "evt_interrupt", processed_at: null }],
								failed_index: 1,
							}),
							tag: "RateLimitError",
							cls: RateLimitError,
						},
						{
							status: 500,
							body: apiErrorBody("internal_error", "boom"),
							tag: "InternalServerError",
							cls: InternalServerError,
						},
						{
							status: 503,
							body: apiErrorBody("service_unavailable", "down"),
							tag: "ServiceUnavailableError",
							cls: ServiceUnavailableError,
						},
						{
							status: 302,
							body: "",
							tag: "UnexpectedStatusError",
							cls: UnexpectedStatusError,
						},
					] as const

					for (const entry of cases) {
						const mockFetch = (async () =>
							typeof entry.body === "string"
								? new Response(entry.body, {
										status: entry.status,
										headers: { "request-id": "req_hdr_999" },
									})
								: jsonResponse(entry.body, entry.status)) as typeof globalThis.fetch

						const err = yield* Effect.gen(function* () {
							const client = yield* CheckfuClient
							return yield* Effect.flip(
								client.agents.create({ name: "A", model: "gpt-6.2-sol" }, { maxRetries: 0 }),
							)
						}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 0 })))

						expect(err._tag).toBe(entry.tag)
						expect(err).toBeInstanceOf(entry.cls)
						expect(err).toBeInstanceOf(APIError)
						expect(err).toBeInstanceOf(CheckfuError)
						if (err._tag === "RateLimitError") {
							expect(err.requestId).toBe("req_err_456")
							expect(err.requestID).toBe("req_err_456")
							expect(err.accepted).toEqual([
								{ type: "user.interrupt", id: "evt_interrupt", processed_at: null },
							])
							expect(err.failedIndex).toBe(1)
						}
					}
				}),
		)

		it.live(
			"retries 429/503 with Retry-After-Ms and reuses the same Idempotency-Key across attempts",
			() =>
				Effect.gen(function* () {
					const seenKeys: Array<string | null> = []
					let attempts = 0
					const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						seenKeys.push(req.headers.get("idempotency-key"))
						attempts += 1
						if (attempts === 1) {
							return jsonResponse(apiErrorBody("rate_limit_error", "rate limited"), 429, {
								"retry-after-ms": "1",
							})
						}
						if (attempts === 2) {
							return jsonResponse(apiErrorBody("service_unavailable", "retry me"), 503, {
								"retry-after-ms": "1",
							})
						}
						return jsonResponse(sampleAgent(), 201)
					}) as typeof globalThis.fetch

					const agent = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* client.agents.create({ name: "Assistant", model: "gpt-6.2-sol" })
					}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 2 })))

					expect(attempts).toBe(3)
					expect(seenKeys[0]).toBeTruthy()
					expect(seenKeys).toEqual([seenKeys[0], seenKeys[0], seenKeys[0]])
					expect(isPendingResource(agent)).toBe(false)
				}),
		)

		it.effect("respects x-should-retry: false and avoids unsafe 500 retries on update", () =>
			Effect.gen(function* () {
				let noRetryCalls = 0
				const noRetryFetch = (async () => {
					noRetryCalls += 1
					return jsonResponse(apiErrorBody("rate_limit_error", "no retry"), 429, {
						"x-should-retry": "false",
					})
				}) as typeof globalThis.fetch

				const err1 = yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					return yield* Effect.flip(client.agents.retrieve("agent_1"))
				}).pipe(Effect.provide(makeEffectLayer(noRetryFetch, { maxRetries: 3 })))
				expect(err1._tag).toBe("RateLimitError")
				expect(noRetryCalls).toBe(1)

				let update500Calls = 0
				const update500Fetch = (async () => {
					update500Calls += 1
					return jsonResponse(apiErrorBody("internal_error", "maybe committed"), 500)
				}) as typeof globalThis.fetch

				const err2 = yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					return yield* Effect.flip(client.agents.update("agent_1", { version: 1, name: "X" }))
				}).pipe(Effect.provide(makeEffectLayer(update500Fetch, { maxRetries: 3 })))
				expect(err2._tag).toBe("InternalServerError")
				expect(update500Calls).toBe(1)
			}),
		)

		it.live("resends a publish or an unpublish whose response was lost with the same key", () =>
			Effect.gen(function* () {
				const seen: Array<string> = []
				const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					seen.push(
						`${req.method} ${new URL(req.url).pathname} ${req.headers.get("idempotency-key") ?? ""}`,
					)
					return seen.length % 2 === 1
						? jsonResponse(apiErrorBody("internal_error", "maybe committed"), 500, {
								"retry-after-ms": "1",
							})
						: jsonResponse(sampleArtifact())
				}) as typeof globalThis.fetch

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					yield* client.artifacts.publish("art_1", { version: "latest" })
					yield* client.artifacts.unpublish("art_1")
				}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 1 })))
				const [publish = "", publishRetry, unpublish = "", unpublishRetry] = seen
				expect(publish).toMatch(/^POST \/v1\/artifacts\/art_1\/publication \S+$/)
				expect(unpublish).toMatch(/^DELETE \/v1\/artifacts\/art_1\/publication \S+$/)
				expect([publishRetry, unpublishRetry]).toEqual([publish, unpublish])
				expect(publish.split(" ")[2]).not.toBe(unpublish.split(" ")[2])
			}),
		)

		it.live("does not resend a publish or an unpublish that may have landed without a key", () =>
			Effect.gen(function* () {
				const seen: Array<string> = []
				const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					seen.push(`${req.method} ${req.headers.get("idempotency-key") ?? "no key"}`)
					return jsonResponse(apiErrorBody("internal_error", "maybe committed"), 500, {
						"retry-after-ms": "1",
					})
				}) as typeof globalThis.fetch

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					yield* Effect.flip(client.artifacts.publish("art_1", {}))
					yield* Effect.flip(client.artifacts.unpublish("art_1"))
				}).pipe(
					Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 2, autoIdempotencyKey: false })),
				)
				expect(seen).toEqual(["POST no key", "DELETE no key"])
			}),
		)

		it.effect(
			"rejects invalid path segments client-side with BadRequestError without calling fetch",
			() =>
				Effect.gen(function* () {
					let calls = 0
					const mockFetch = (async () => {
						calls += 1
						return jsonResponse(sampleAgent())
					}) as typeof globalThis.fetch

					const err = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Effect.flip(client.agents.retrieve("../escape"))
					}).pipe(Effect.provide(makeEffectLayer(mockFetch)))

					expect(err._tag).toBe("BadRequestError")
					expect(calls).toBe(0)
				}),
		)

		it.live("enforces per-request timeouts as APIConnectionTimeoutError", () =>
			Effect.gen(function* () {
				const slowFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							reject(new DOMException("Aborted", "AbortError"))
						})
					})) as typeof globalThis.fetch

				const err = yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					return yield* Effect.flip(
						client.agents.retrieve("agent_1", { timeout: "20 millis", maxRetries: 0 }),
					)
				}).pipe(Effect.provide(makeEffectLayer(slowFetch)))

				expect(err._tag).toBe("APIConnectionTimeoutError")
				expect(err).toBeInstanceOf(APIConnectionTimeoutError)
			}),
		)

		it.effect("auto-paginates sessions.events.listStream and detects cursor cycles", () =>
			Effect.gen(function* () {
				const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = new URL(toWebRequest(input, init).url)
					const token = url.searchParams.get("page")
					if (url.pathname.includes("sess_stalled")) {
						return jsonResponse({
							data: [sampleUserMessageEvent(2)],
							next_page: "2",
						})
					}
					if (token === null) {
						return jsonResponse({
							data: [sampleUserMessageEvent(1), sampleUserMessageEvent(2)],
							next_page: "2",
						})
					}
					if (token === "2") {
						return jsonResponse({
							data: [sampleUserMessageEvent(3)],
							next_page: null,
						})
					}
					return jsonResponse({ data: [], next_page: null })
				}) as typeof globalThis.fetch

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					const all = yield* Stream.runCollect(
						client.sessions.events.listStream("sess_1", { limit: 2 }),
					)
					expect(Array.from(all).map((e) => e.seq)).toEqual([1, 2, 3])

					const stalledErr = yield* Effect.flip(
						Stream.runDrain(client.sessions.events.listStream("sess_stalled", { page: "2" })),
					)
					expect(stalledErr._tag).toBe("PaginationCursorCycleError")
					expect(stalledErr).toBeInstanceOf(PaginationCursorCycleError)
					expect(stalledErr.message).toContain("cursor did not advance")
				}).pipe(Effect.provide(makeEffectLayer(mockFetch)))
			}),
		)

		it.live(
			"streams typed SessionEvents with reconnect deduplication and clean 204/archive stop",
			() =>
				Effect.gen(function* () {
					const lastEventIds: Array<string | null> = []
					let calls = 0
					const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						const url = new URL(req.url)
						if (url.pathname.includes("sess_204")) {
							return new Response(null, { status: 204 })
						}
						lastEventIds.push(req.headers.get("last-event-id"))
						calls += 1
						if (calls === 1) {
							return new Response(sseFrame(sampleUserMessageEvent(1)), {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							})
						}
						return new Response(
							`${sseFrame(sampleUserMessageEvent(1))}${sseFrame(sampleUserMessageEvent(2))}${sseFrame(sampleArchivedEvent(3))}`,
							{
								status: 200,
								headers: { "content-type": "text/event-stream" },
							},
						)
					}) as typeof globalThis.fetch

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const events = yield* Stream.runCollect(
							client.sessions.events.stream("sess_1", undefined, {
								baseReconnectDelayMs: 1,
							}),
						)
						const list = Array.from(events)
						expect(list.map((e) => e.seq)).toEqual([1, 2, 3])
						expect(DateTime.isDateTime(list[0]?.created_at)).toBe(true)
						expect(lastEventIds).toEqual([null, "1"])

						const empty = yield* Stream.runCollect(client.sessions.events.stream("sess_204"))
						expect(Array.from(empty)).toEqual([])
					}).pipe(Effect.provide(makeEffectLayer(mockFetch)))
				}),
		)

		it.live(
			"waitForPending resolves pending resources across projection lag and honors until",
			() =>
				Effect.gen(function* () {
					let polls = 0
					const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						const url = new URL(req.url)
						if (req.method === "POST" && url.pathname === "/v1/agents") {
							return jsonResponse({ id: "agent_pending", type: "agent", pending: true }, 202)
						}
						if (req.method === "GET" && url.pathname === "/v1/agents/agent_pending") {
							polls += 1
							if (polls === 1) {
								return jsonResponse(apiErrorBody("service_unavailable", "projection warming"), 503)
							}
							if (polls === 2) {
								return jsonResponse(sampleAgent({ id: "agent_pending", version: 1 }))
							}
							return jsonResponse(sampleAgent({ id: "agent_pending", version: 2 }))
						}
						return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
					}) as typeof globalThis.fetch

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const created = yield* client.agents.create({ name: "Assistant", model: "gpt-6.2-sol" })
						expect(isPendingResource(created)).toBe(true)

						const ready = yield* client.waitForPending(created, {
							initialDelay: "1 millis",
							maxDelay: "5 millis",
							timeout: "2 seconds",
							until: (a) => a.version >= 2,
							requestOptions: { maxRetries: 0 },
						})
						expect(ready.id).toBe("agent_pending")
						expect(ready.version).toBe(2)
						expect(polls).toBe(3)

						const passthrough = yield* client.waitForPending(ready)
						expect(passthrough).toBe(ready)
						expect(polls).toBe(3)
					}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 0 })))
				}),
		)

		it.live(
			"waitForPending resolves a pending artifact and reads a pending version at its committed number",
			() =>
				Effect.gen(function* () {
					const reads: Array<string> = []
					let artifactPolls = 0
					let versionPolls = 0
					const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						const url = new URL(req.url)
						if (req.method === "POST" && url.pathname === "/v1/artifacts") {
							return jsonResponse({ id: "art_pending", type: "artifact", pending: true }, 202)
						}
						if (req.method === "POST" && url.pathname === "/v1/artifacts/art_pending/versions") {
							return jsonResponse(
								{ id: "art_pending", type: "artifact_version", version: 2, pending: true },
								202,
							)
						}
						reads.push(url.pathname)
						if (req.method === "GET" && url.pathname === "/v1/artifacts/art_pending") {
							artifactPolls += 1
							return artifactPolls === 1
								? jsonResponse(apiErrorBody("service_unavailable", "projection warming"), 503)
								: jsonResponse(sampleArtifact({ id: "art_pending" }))
						}
						if (req.method === "GET" && url.pathname === "/v1/artifacts/art_pending/versions/2") {
							versionPolls += 1
							return versionPolls === 1
								? jsonResponse(apiErrorBody("not_found_error", "not yet"), 404)
								: jsonResponse(sampleArtifactVersion({ artifact_id: "art_pending", version: 2 }))
						}
						return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
					}) as typeof globalThis.fetch
					const pollOpts = {
						initialDelay: "1 millis" as const,
						maxDelay: "2 millis" as const,
						timeout: "2 seconds" as const,
						requestOptions: { maxRetries: 0 },
					}

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const created = yield* client.artifacts.create({
							name: "Report",
							files: [{ path: "index.html", content: "<h1>Hello</h1>" }],
						})
						expect(isPendingResource(created)).toBe(true)
						const artifact = yield* client.waitForPending(created, pollOpts)
						expect(artifact.id).toBe("art_pending")
						expect(artifactPolls).toBe(2)

						const added = yield* client.artifacts.versions.create("art_pending", {
							version: 1,
							files: [{ path: "index.html", content: "<h1>Again</h1>" }],
						})
						expect(isPendingResource(added) && added.version).toBe(2)
						const version = yield* client.waitForPending(added, pollOpts)
						expect(version.version).toBe(2)
						expect(versionPolls).toBe(2)

						const copied = yield* client.waitForPending({ ...added }, pollOpts)
						expect(copied.version).toBe(2)
					}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 0 })))

					artifactPolls = 0
					versionPolls = 0
					yield* Effect.promise(async () => {
						const promiseClient = new Checkfu({
							apiKey: "ck_test_key",
							baseUrl: "http://localhost:1337",
							maxRetries: 0,
							fetch: mockFetch,
						})
						try {
							const created = await promiseClient.artifacts.create({
								name: "Report",
								files: [{ path: "index.html", content: "<h1>Hello</h1>" }],
							})
							const artifact = await promiseClient.waitForPending(created, pollOpts)
							expect(artifact.created_at).toBe(ISO_NOW)
							const added = await promiseClient.artifacts.versions.create("art_pending", {
								version: 1,
								files: [{ path: "index.html", content: "<h1>Again</h1>" }],
							})
							const version = await promiseClient.waitForPending(added, pollOpts)
							expect(version.version).toBe(2)
							expect(version.created_at).toBe(ISO_NOW)
						} finally {
							await promiseClient.close()
						}
					})
					expect(new Set(reads)).toEqual(
						new Set(["/v1/artifacts/art_pending", "/v1/artifacts/art_pending/versions/2"]),
					)
				}),
		)

		it.live("waitForPending settles a credential archive only once its secret is erased", () =>
			Effect.gen(function* () {
				let polls = 0
				const credential = {
					id: "vcrd_archived",
					type: "vault_credential",
					vault_id: "vlt_1",
					auth: { type: "static_bearer", mcp_server_url: "https://mcp.example/mcp" },
					display_name: null,
					created_at: ISO_NOW,
					updated_at: ISO_NOW,
					archived_at: ISO_NOW,
				}
				const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					const url = new URL(req.url)
					if (
						req.method === "POST" &&
						url.pathname === "/v1/vaults/vlt_1/credentials/vcrd_archived/archive"
					) {
						return jsonResponse(
							{ id: "vcrd_archived", type: "vault_credential", vault_id: "vlt_1", pending: true },
							202,
						)
					}
					if (
						req.method === "GET" &&
						url.pathname === "/v1/vaults/vlt_1/credentials/vcrd_archived"
					) {
						polls += 1
						return jsonResponse({ ...credential, custody: polls === 1 ? "erasing" : "erased" })
					}
					return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
				}) as typeof globalThis.fetch

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					const archived = yield* client.vaults.credentials.archive("vlt_1", "vcrd_archived")
					expect(isPendingResource(archived)).toBe(true)
					const ready = yield* client.waitForPending(archived, {
						initialDelay: "1 millis",
						maxDelay: "2 millis",
						timeout: "2 seconds",
						requestOptions: { maxRetries: 0 },
					})
					expect(ready.custody).toBe("erased")
					expect(polls).toBe(2)
				}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 0 })))
			}),
		)

		it.live("waitForPending settles a vault archive only once every custody count is 0", () =>
			Effect.gen(function* () {
				let polls = 0
				const vault = {
					id: "vlt_archived",
					type: "vault",
					display_name: "Ops",
					created_at: ISO_NOW,
					updated_at: ISO_NOW,
					archived_at: ISO_NOW,
				}
				const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					const url = new URL(req.url)
					if (req.method === "POST" && url.pathname === "/v1/vaults/vlt_archived/archive") {
						return jsonResponse({ id: "vlt_archived", type: "vault", pending: true }, 202)
					}
					if (req.method === "GET" && url.pathname === "/v1/vaults/vlt_archived") {
						polls += 1
						return jsonResponse({
							...vault,
							custody: { storing: 0, held: 0, erasing: polls === 1 ? 2 : 0 },
						})
					}
					return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
				}) as typeof globalThis.fetch

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					const archived = yield* client.vaults.archive("vlt_archived")
					expect(isPendingResource(archived)).toBe(true)
					const ready = yield* client.waitForPending(archived, {
						initialDelay: "1 millis",
						maxDelay: "2 millis",
						timeout: "2 seconds",
						requestOptions: { maxRetries: 0 },
					})
					expect(ready.custody).toEqual({ storing: 0, held: 0, erasing: 0 })
					expect(polls).toBe(2)
				}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 0 })))
			}),
		)

		it.effect("waitForPending fails with a configuration error for an unknown receipt type", () =>
			Effect.gen(function* () {
				const client = yield* CheckfuClient
				const unknown = { id: "res_1", type: "widget", pending: true } as unknown as Parameters<
					typeof client.waitForPending
				>[0]
				const error = yield* Effect.flip(
					client.waitForPending(unknown, { until: () => true, timeout: "1 second" }),
				)
				expect(error._tag).toBe("CheckfuConfigError")
			}).pipe(
				Effect.provide(
					makeEffectLayer(
						async () => jsonResponse(apiErrorBody("not_found_error", "not found"), 404),
						{ maxRetries: 0 },
					),
				),
			),
		)

		it.live("waitForPending settles a credential create only once its secret is held", () =>
			Effect.gen(function* () {
				let polls = 0
				const credential = {
					id: "vcrd_storing",
					type: "vault_credential",
					vault_id: "vlt_1",
					auth: { type: "static_bearer", mcp_server_url: "https://mcp.example/mcp" },
					display_name: null,
					created_at: ISO_NOW,
					updated_at: ISO_NOW,
					archived_at: null,
				}
				const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					const url = new URL(req.url)
					if (req.method === "POST" && url.pathname === "/v1/vaults/vlt_1/credentials") {
						return jsonResponse(
							{ id: "vcrd_storing", type: "vault_credential", vault_id: "vlt_1", pending: true },
							202,
						)
					}
					if (
						req.method === "GET" &&
						url.pathname === "/v1/vaults/vlt_1/credentials/vcrd_storing"
					) {
						polls += 1
						return jsonResponse({ ...credential, custody: polls === 1 ? "storing" : "held" })
					}
					return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
				}) as typeof globalThis.fetch

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					const created = yield* client.vaults.credentials.create("vlt_1", {
						auth: {
							type: "static_bearer",
							token: Redacted.make("tok_test_value"),
							mcp_server_url: "https://mcp.example/mcp",
						},
					})
					expect(isPendingResource(created)).toBe(true)
					const ready = yield* client.waitForPending(created, {
						initialDelay: "1 millis",
						maxDelay: "2 millis",
						timeout: "2 seconds",
						requestOptions: { maxRetries: 0 },
					})
					expect(ready.custody).toBe("held")
					expect(polls).toBe(2)
				}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 0 })))
			}),
		)

		it.live("waitForPending settles a pending credential create without an until", () =>
			Effect.gen(function* () {
				let polls = 0
				const credential = {
					id: "vcrd_pending",
					type: "vault_credential",
					vault_id: "vlt_1",
					auth: { type: "static_bearer", mcp_server_url: "https://mcp.example/mcp" },
					display_name: null,
					custody: "held",
					created_at: ISO_NOW,
					updated_at: ISO_NOW,
					archived_at: null,
				}
				const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					const url = new URL(req.url)
					if (req.method === "POST" && url.pathname === "/v1/vaults/vlt_1/credentials") {
						return jsonResponse(
							{ id: "vcrd_pending", type: "vault_credential", vault_id: "vlt_1", pending: true },
							202,
						)
					}
					if (
						req.method === "GET" &&
						url.pathname === "/v1/vaults/vlt_1/credentials/vcrd_pending"
					) {
						polls += 1
						return polls === 1
							? jsonResponse(apiErrorBody("service_unavailable", "projection warming"), 503)
							: jsonResponse(credential)
					}
					return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
				}) as typeof globalThis.fetch

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					const created = yield* client.vaults.credentials.create("vlt_1", {
						auth: {
							type: "static_bearer",
							token: Redacted.make("tok_test_value"),
							mcp_server_url: "https://mcp.example/mcp",
						},
					})
					expect(isPendingResource(created)).toBe(true)
					const ready = yield* client.waitForPending(created, {
						initialDelay: "1 millis",
						maxDelay: "2 millis",
						timeout: "2 seconds",
						requestOptions: { maxRetries: 0 },
					})
					expect(ready.id).toBe("vcrd_pending")
					expect(polls).toBe(2)
				}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 0 })))
			}),
		)

		it.live("waitForPending times out on artifacts and refuses receipts it cannot resolve", () =>
			Effect.gen(function* () {
				let fetches = 0
				const unavailable = (async () => {
					fetches += 1
					return jsonResponse(apiErrorBody("service_unavailable", "projection warming"), 503)
				}) as typeof globalThis.fetch
				const pollOpts = {
					initialDelay: "1 millis" as const,
					maxDelay: "5 millis" as const,
					timeout: "40 millis" as const,
					requestOptions: { maxRetries: 0 },
				}

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					const artifactTimeout = yield* Effect.flip(
						client.waitForPending(
							attachPendingReadiness(
								{ id: "art_slow", type: "artifact" as const, pending: true as const },
								{ kind: "create" },
							),
							pollOpts,
						),
					)
					expect(artifactTimeout._tag).toBe("APIConnectionTimeoutError")
					expect(artifactTimeout.message).toContain('pending artifact "art_slow"')

					const versionTimeout = yield* Effect.flip(
						client.waitForPending(
							{ id: "art_slow", type: "artifact_version", version: 3, pending: true },
							pollOpts,
						),
					)
					expect(versionTimeout._tag).toBe("APIConnectionTimeoutError")
					expect(versionTimeout.message).toContain('pending artifact_version "art_slow"')

					const polled = fetches
					const wrongType = yield* Effect.flip(
						client.waitForPending(
							{ id: "art_1", type: "artifact_file", pending: true } as unknown as PendingArtifact,
							pollOpts,
						),
					)
					expect(wrongType._tag).toBe("CheckfuConfigError")
					expect(wrongType.message).toContain("artifact_file")

					const noVersion = yield* Effect.flip(
						client.waitForPending(
							{
								id: "art_1",
								type: "artifact_version",
								pending: true,
							} as unknown as PendingArtifactVersion,
							pollOpts,
						),
					)
					expect(noVersion._tag).toBe("CheckfuConfigError")
					expect(noVersion.message).toContain("version")
					expect(fetches).toBe(polled)
				}).pipe(Effect.provide(makeEffectLayer(unavailable, { maxRetries: 0 })))

				const promiseClient = new Checkfu({
					apiKey: "ck_test_key",
					baseUrl: "http://localhost:1337",
					maxRetries: 0,
					fetch: unavailable,
				})
				yield* Effect.promise(async () => {
					try {
						await expect(
							promiseClient.waitForPending(
								{ id: "art_slow", type: "artifact_version", version: 3, pending: true },
								pollOpts,
							),
						).rejects.toThrow(APIConnectionTimeoutError)
						await expect(
							promiseClient.waitForPending(
								{ id: "art_1", type: "artifact_file", pending: true } as unknown as PendingArtifact,
								pollOpts,
							),
						).rejects.toThrow(CheckfuConfigError)
					} finally {
						await promiseClient.close()
					}
				})
			}),
		)
	})

	describe("Promise / AsyncIterable Checkfu facade", () => {
		it("supports ISO dates, single-request withResponse/asResponse, raw error unwrapping, and withOptions", async () => {
			let createCalls = 0
			let lastCustomHeader: string | null = null
			const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const req = toWebRequest(input, init)
				const url = new URL(req.url)
				lastCustomHeader = req.headers.get("x-tenant")
				if (req.method === "POST" && url.pathname === "/v1/agents") {
					createCalls += 1
					return jsonResponse(sampleAgent(), 201)
				}
				if (req.method === "GET" && url.pathname === "/v1/agents/missing") {
					return jsonResponse(apiErrorBody("not_found_error", "Agent missing not found."), 404)
				}
				return jsonResponse(sampleEnvironment(), 201)
			}) as typeof globalThis.fetch

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
				maxRetries: 0,
			})

			try {
				const createCall = client.agents.create({ name: "Assistant", model: "gpt-6.2-sol" })
				expect(createCall).toBeInstanceOf(APIPromise)
				expect(createCall).toBeInstanceOf(Promise)
				const { data, response, status, headers, requestId, request_id } =
					await createCall.withResponse()
				expect(createCalls).toBe(1)
				expect(status).toBe(201)
				expect(requestId).toBe("req_test_123")
				expect(request_id).toBe("req_test_123")
				expect(headers.get("request-id")).toBe("req_test_123")
				expect(response).toBeInstanceOf(Response)
				expect(isPendingResource(data)).toBe(false)
				if (!isPendingResource(data)) {
					expect(typeof data.created_at).toBe("string")
					expect(data.created_at).toBe(ISO_NOW)
				}

				const rawResp = await client.environments.create({ name: "default" }).asResponse()
				expect(rawResp.status).toBe(201)

				const derived = client.withOptions({ defaultHeaders: { "x-tenant": "acme" } })
				try {
					await expect(derived.agents.retrieve("missing")).rejects.toThrow(NotFoundError)
					expect(lastCustomHeader).toBe("acme")
					try {
						await derived.agents.retrieve("missing")
					} catch (error) {
						expect(error).toBeInstanceOf(Checkfu.NotFoundError)
						expect(error).toBeInstanceOf(Checkfu.APIError)
						expect(error).toBeInstanceOf(Checkfu.CheckfuError)
						if (isAPIError(error)) {
							expect(error.status).toBe(404)
							expect(error.requestID).toBe("req_err_456")
						}
					}
				} finally {
					await derived.close()
				}
			} finally {
				await client.close()
			}
		})

		it("supports AbortSignal cancellation as APIUserAbortError", async () => {
			let fetchCalls = 0
			const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
				fetchCalls += 1
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"))
					})
				})
			}) as typeof globalThis.fetch

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
				maxRetries: 0,
			})

			try {
				const alreadyAborted = new AbortController()
				alreadyAborted.abort()
				await expect(
					client.agents.retrieve("agent_1", { signal: alreadyAborted.signal }),
				).rejects.toThrow(APIUserAbortError)
				expect(fetchCalls).toBe(0)

				const liveController = new AbortController()
				const pending = client.agents.retrieve("agent_1", { signal: liveController.signal })
				liveController.abort()
				await expect(pending).rejects.toThrow(APIUserAbortError)
			} finally {
				await client.close()
			}
		})

		it("supports PagePromise single-page await, auto-paginating for-await, and cursor cycle fencing", async () => {
			const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(toWebRequest(input, init).url)
				if (url.pathname.includes("sess_cycle")) {
					return jsonResponse({
						data: [sampleUserMessageEvent(2)],
						next_page: "2",
					})
				}
				const token = url.searchParams.get("page")
				if (token === null) {
					return jsonResponse({
						data: [sampleUserMessageEvent(1), sampleUserMessageEvent(2)],

						next_page: "2",
					})
				}
				return jsonResponse({
					data: [sampleUserMessageEvent(3)],
					next_page: null,
				})
			}) as typeof globalThis.fetch

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
			})

			try {
				const firstPage = await client.sessions.events.list("sess_1", { limit: 2 })
				expect(firstPage.data.map((e) => e.seq)).toEqual([1, 2])
				expect(firstPage.hasNextPage()).toBe(true)
				expect(firstPage.next_page).toBe("2")
				const secondPage = await firstPage.getNextPage()
				expect(secondPage.data.map((e) => e.seq)).toEqual([3])
				expect(secondPage.hasNextPage()).toBe(false)
				const selected = await client.sessions.events.list("sess_1", { page: "2" })
				expect(selected.data.map((event) => event.seq)).toEqual([3])

				const all: Array<JsonSessionEvent> = []
				for await (const event of client.sessions.events.list("sess_1", { limit: 2 })) {
					all.push(event)
				}
				expect(all.map((e) => e.seq)).toEqual([1, 2, 3])
				expect(typeof all[0]?.created_at).toBe("string")

				await expect(
					(async () => {
						const seen: Array<unknown> = []
						for await (const event of client.sessions.events.list("sess_cycle", { page: "2" })) {
							seen.push(event)
						}
					})(),
				).rejects.toThrow(PaginationCursorCycleError)
			} finally {
				await client.close()
			}
		})

		it("supports EventStream eager 404 rejection, direct for-await, tee(), controller.abort, and toReadableStream", async () => {
			const encoder = new TextEncoder()
			let okStreamFetches = 0
			const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const req = toWebRequest(input, init)
				const url = new URL(req.url)
				if (url.pathname.includes("sess_missing")) {
					return jsonResponse(apiErrorBody("not_found_error", "Session not found."), 404)
				}
				if (url.pathname.includes("sess_abort")) {
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(sseFrame(sampleUserMessageEvent(1))))
						},
					})
					return new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				}
				if (url.pathname.includes("sess_tee")) {
					okStreamFetches += 1
				}
				return new Response(
					`${sseFrame(sampleUserMessageEvent(1))}${sseFrame(sampleArchivedEvent(2))}`,
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				)
			}) as typeof globalThis.fetch

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
			})

			try {
				await expect(client.sessions.events.stream("sess_missing")).rejects.toThrow(NotFoundError)

				const directEvents: Array<JsonSessionEvent> = []
				for await (const ev of client.sessions.events.stream("sess_ok")) {
					directEvents.push(ev)
				}
				expect(directEvents.map((e) => e.seq)).toEqual([1, 2])
				expect(typeof directEvents[0]?.created_at).toBe("string")

				const liveStream = await client.sessions.events.stream("sess_tee")
				const [leftStream, rightStream] = liveStream.tee()
				const [leftSeqs, rightSeqs] = await Promise.all([
					(async () => {
						const seqs: Array<number> = []
						for await (const ev of leftStream) {
							seqs.push(ev.seq)
						}
						return seqs
					})(),
					(async () => {
						const seqs: Array<number> = []
						for await (const ev of rightStream) {
							seqs.push(ev.seq)
						}
						return seqs
					})(),
				])
				expect(leftSeqs).toEqual([1, 2])
				expect(rightSeqs).toEqual([1, 2])
				expect(okStreamFetches).toBe(1)

				const readableStream = (await client.sessions.events.stream("sess_ok")).toReadableStream()
				const jsonlText = await new Response(readableStream).text()
				const parsedLines = jsonlText
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { readonly seq: number })
				expect(parsedLines.map((l) => l.seq)).toEqual([1, 2])

				const abortable = await client.sessions.events.stream("sess_abort")
				const seenBeforeAbort: Array<number> = []
				await expect(
					(async () => {
						for await (const ev of abortable) {
							seenBeforeAbort.push(ev.seq)
							abortable.controller.abort()
						}
					})(),
				).rejects.toThrow(APIUserAbortError)
				expect(seenBeforeAbort).toEqual([1])

				const session = sampleSession()
				const pendingCheck = await client.waitForPending({
					...session,
					created_at: ISO_NOW,
					updated_at: ISO_NOW,
					archived_at: null,
				})
				expect(pendingCheck.id).toBe("sess_1")
			} finally {
				await client.close()
			}
		})
	})

	describe("error guard parity & generated operation bindings", () => {
		it("checks APIConnectionError instanceof CheckfuError without matching APIError", () => {
			const conn = new APIConnectionError({ message: "offline" })
			expect(conn).toBeInstanceOf(CheckfuError)
			expect(conn).not.toBeInstanceOf(APIError)
			expect(conn.retryable).toBe(true)

			const unprocessable = new UnprocessableEntityError({ status: 422, message: "invalid" })
			expect(unprocessable).toBeInstanceOf(APIError)
			expect(unprocessable).toBeInstanceOf(CheckfuError)
			expect(unprocessable.retryable).toBe(false)
		})

		it("exports complete Forge-generated SDK_OPERATION_BINDINGS and Op type helpers", () => {
			const ungenerated = new Set(["health", "auth"])
			const rawBytes = new Set(["artifacts.getFileContent", "artifacts.uploadBlob"])
			const expectedEndpoints = Object.entries(CheckfuApi.groups)
				.filter(([group]) => !ungenerated.has(group))
				.flatMap(([group, apiGroup]) =>
					Object.keys(apiGroup.endpoints).map((endpoint) => `${group}.${endpoint}`),
				)
				.filter((endpoint) => !rawBytes.has(endpoint))
				.sort()
			const boundEndpoints = SDK_OPERATION_BINDINGS.map(
				(binding) => `${binding.apiGroup}.${binding.apiEndpoint}`,
			).sort()
			expect(boundEndpoints).toEqual(expectedEndpoints)
			const ids = SDK_OPERATION_BINDINGS.map((b) => b.operationId)
			expect(ids).toContain("agents.create")
			expect(ids).toContain("sessions.events.list")
			expect(ids).toContain("sessions.events.stream")

			const listBinding = SDK_OPERATION_BINDINGS.find(
				(b) => b.operationId === "sessions.events.list",
			)
			expect(listBinding?.kind).toBe("paginated")
			const streamBinding = SDK_OPERATION_BINDINGS.find(
				(b) => b.operationId === "sessions.events.stream",
			)
			expect(streamBinding?.kind).toBe("sse")

			const sampleBody: BodyOf<Op<"agents.create">> = { name: "Bot", model: "gpt-6.2-sol" }
			expect(sampleBody.name).toBe("Bot")
			type EffectRetrieveAgent = ResultOf<Op<"agents.retrieve">>
			type JsonRetrieveAgent = JsonResultOf<Op<"agents.retrieve">>
			const checkTypes: readonly [EffectRetrieveAgent["type"]?, JsonRetrieveAgent["created_at"]?] =
				["agent", ISO_NOW]
			expect(checkTypes[0]).toBe("agent")
		})
	})

	describe("safety & lifecycle regression coverage", () => {
		it.live(
			"bases mutation retry safety on the effective Idempotency-Key header sent on the wire",
			() =>
				Effect.gen(function* () {
					let strippedCalls = 0
					const strippedKeys: Array<string | null> = []
					const strippedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						strippedCalls += 1
						strippedKeys.push(req.headers.get("idempotency-key"))
						throw new TypeError("socket closed after commit")
					}) as typeof globalThis.fetch

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const err = yield* Effect.flip(
							client.agents.create(
								{ name: "NoRetry", model: "gpt-6.2-sol" },
								{ headers: { "Idempotency-Key": null } },
							),
						)
						expect(err._tag).toBe("APIConnectionError")
					}).pipe(
						Effect.provide(
							CheckfuClient.layerFetch({
								apiKey: "ck_test_key",
								baseUrl: "http://localhost:1337",
								maxRetries: 2,
								fetch: strippedFetch,
							}),
						),
					)
					expect(strippedCalls).toBe(1)
					expect(strippedKeys).toEqual([null])

					let overrideCalls = 0
					const overrideKeys: Array<string | null> = []
					const overrideFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						overrideCalls += 1
						overrideKeys.push(req.headers.get("idempotency-key"))
						if (overrideCalls === 1) {
							throw new TypeError("transient drop")
						}
						return jsonResponse(sampleAgent(), 201)
					}) as typeof globalThis.fetch

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const created = yield* client.agents.create(
							{ name: "ExplicitKey", model: "gpt-6.2-sol" },
							{ idempotencyKey: "k_explicit_1" },
						)
						expect(created.type).toBe("agent")
					}).pipe(
						Effect.provide(
							CheckfuClient.layerFetch({
								apiKey: "ck_test_key",
								baseUrl: "http://localhost:1337",
								maxRetries: 2,
								defaultHeaders: { "Idempotency-Key": null },
								fetch: overrideFetch,
							}),
						),
					)
					expect(overrideCalls).toBe(2)
					expect(overrideKeys).toEqual(["k_explicit_1", "k_explicit_1"])

					let headerKeyCalls = 0
					const headerKeys: Array<string | null> = []
					const headerKeyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						headerKeyCalls += 1
						headerKeys.push(req.headers.get("idempotency-key"))
						if (headerKeyCalls === 1) {
							throw new TypeError("transient drop")
						}
						return jsonResponse(sampleAgent(), 201)
					}) as typeof globalThis.fetch

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const created = yield* client.agents.create(
							{ name: "HeaderKey", model: "gpt-6.2-sol" },
							{ headers: { "Idempotency-Key": "k_hdr_1" } },
						)
						expect(created.type).toBe("agent")
					}).pipe(
						Effect.provide(
							CheckfuClient.layerFetch({
								apiKey: "ck_test_key",
								baseUrl: "http://localhost:1337",
								maxRetries: 2,
								autoIdempotencyKey: false,
								fetch: headerKeyFetch,
							}),
						),
					)
					expect(headerKeyCalls).toBe(2)
					expect(headerKeys).toEqual(["k_hdr_1", "k_hdr_1"])
				}),
		)

		it.live(
			"does not retry partially accepted or unconfirmed batches without idempotency (even on 429/503)",
			() =>
				Effect.gen(function* () {
					let acceptedCalls = 0
					const acceptedFetch = (async () => {
						acceptedCalls += 1
						return jsonResponse(
							{
								type: "error",
								error: { type: "rate_limit_error", message: "throttled mid-batch" },
								request_id: "req_partial_429",
								accepted: [
									{
										type: "user.message",
										turn: 1,
										queued: false,
										content: [{ type: "text", text: "first" }],
									},
								],
								failed_index: 1,
							},
							429,
							{ "x-should-retry": "true", "retry-after-ms": "1" },
						)
					}) as typeof globalThis.fetch

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const err = yield* Effect.flip(
							client.sessions.events.send("sess_1", {
								events: [
									{ type: "user.message", content: [{ type: "text", text: "first" }] },
									{ type: "user.message", content: [{ type: "text", text: "second" }] },
								],
							}),
						)
						expect(err._tag).toBe("RateLimitError")
					}).pipe(
						Effect.provide(
							CheckfuClient.layerFetch({
								apiKey: "ck_test_key",
								baseUrl: "http://localhost:1337",
								maxRetries: 2,
								autoIdempotencyKey: false,
								fetch: acceptedFetch,
							}),
						),
					)
					expect(acceptedCalls).toBe(1)

					let unconfirmedCalls = 0
					const unconfirmedFetch = (async () => {
						unconfirmedCalls += 1
						return jsonResponse(
							{
								type: "error",
								error: { type: "service_unavailable", message: "outcome unknown" },
								request_id: "req_unconfirmed_503",
								unconfirmed_index: 0,
							},
							503,
							{ "retry-after-ms": "1" },
						)
					}) as typeof globalThis.fetch

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const err = yield* Effect.flip(
							client.sessions.events.send("sess_1", {
								events: [{ type: "user.message", content: [{ type: "text", text: "first" }] }],
							}),
						)
						expect(err._tag).toBe("ServiceUnavailableError")
					}).pipe(
						Effect.provide(
							CheckfuClient.layerFetch({
								apiKey: "ck_test_key",
								baseUrl: "http://localhost:1337",
								maxRetries: 2,
								autoIdempotencyKey: false,
								fetch: unconfirmedFetch,
							}),
						),
					)
					expect(unconfirmedCalls).toBe(1)

					let preCommitCalls = 0
					const preCommitFetch = (async () => {
						preCommitCalls += 1
						if (preCommitCalls === 1) {
							return jsonResponse(
								{
									type: "error",
									error: { type: "rate_limit_error", message: "try again" },
									request_id: "req_clean_429",
									failed_index: 0,
								},
								429,
								{ "retry-after-ms": "1" },
							)
						}
						return jsonResponse(
							{ data: [{ type: "user.interrupt", id: "evt_interrupt", processed_at: null }] },
							200,
						)
					}) as typeof globalThis.fetch

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const res = yield* client.sessions.events.send("sess_1", {
							events: [{ type: "user.interrupt" }],
						})
						expect(res.data).toHaveLength(1)
					}).pipe(
						Effect.provide(
							CheckfuClient.layerFetch({
								apiKey: "ck_test_key",
								baseUrl: "http://localhost:1337",
								maxRetries: 2,
								autoIdempotencyKey: false,
								fetch: preCommitFetch,
							}),
						),
					)
					expect(preCommitCalls).toBe(2)
				}),
		)

		it.live("enforces waitForPending timeout across slow in-flight requests", () =>
			Effect.gen(function* () {
				let fetchCalls = 0
				let abortedInFlight = false
				const slowFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
					fetchCalls += 1
					return await new Promise<Response>((_resolve, reject) => {
						const onAbort = () => {
							abortedInFlight = true
							reject(new DOMException("Aborted", "AbortError"))
						}
						if (init?.signal?.aborted) {
							onAbort()
							return
						}
						init?.signal?.addEventListener("abort", onAbort, { once: true })
					})
				}) as typeof globalThis.fetch

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					const err = yield* Effect.flip(
						client.waitForPending(
							{ id: "agent_slow", type: "agent", pending: true },
							{
								timeout: "40 millis",
								initialDelay: "10 millis",
								until: () => true,
								requestOptions: { timeout: null, maxRetries: 0 },
							},
						),
					)
					expect(err._tag).toBe("APIConnectionTimeoutError")
				}).pipe(
					Effect.provide(
						CheckfuClient.layerFetch({
							apiKey: "ck_test_key",
							baseUrl: "http://localhost:1337",
							timeout: null,
							maxRetries: 0,
							fetch: slowFetch,
						}),
					),
				)
				expect(fetchCalls).toBe(1)
				expect(abortedInFlight).toBe(true)
			}),
		)

		it.live("revalidates inherited baseUrl when disabling allowInsecureHttp via withOptions", () =>
			Effect.gen(function* () {
				const err = yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					return yield* Effect.flip(client.withOptions({ allowInsecureHttp: false }))
				}).pipe(
					Effect.provide(
						CheckfuClient.layerFetch({
							apiKey: "ck_test_key",
							baseUrl: "http://api.example.com",
							allowInsecureHttp: true,
							fetch: async () => jsonResponse(sampleAgent()),
						}),
					),
				)
				expect(err._tag).toBe("CheckfuConfigError")
				expect(err.message).toContain("insecure HTTP")
			}),
		)

		it("returns readable Response bodies from asResponse() and withResponse() in a single fetch", async () => {
			let fetches = 0
			const mockFetch = (async () => {
				fetches += 1
				return jsonResponse(sampleAgent({ name: "ReadableBody" }), 201, {
					"request-id": "req_readable_1",
				})
			}) as typeof globalThis.fetch

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
			})
			try {
				const asRes = await client.agents
					.create({ name: "ReadableBody", model: "gpt-6.2-sol" })
					.asResponse()
				expect(asRes.bodyUsed).toBe(false)
				expect(asRes.status).toBe(201)
				const rawText = await asRes.text()
				expect(JSON.parse(rawText)).toMatchObject({ name: "ReadableBody" })
				expect(fetches).toBe(1)

				const withRes = await client.agents
					.create({ name: "ReadableBody", model: "gpt-6.2-sol" })
					.withResponse()
				expect(withRes.response.bodyUsed).toBe(false)
				expect(await withRes.response.json()).toMatchObject({ name: "ReadableBody" })
				expect(fetches).toBe(2)
			} finally {
				await client.close()
			}
		})

		it("handles immediate aborts during Promise stream initialization without hanging or fetching", async () => {
			let fetches = 0
			const mockFetch = (async () => {
				fetches += 1
				return await new Promise<Response>(() => {})
			}) as typeof globalThis.fetch

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
			})
			try {
				const controller = new AbortController()
				const pendingStream = client.sessions.events.stream("sess_abort_init", undefined, {
					signal: controller.signal,
				})
				controller.abort()
				await expect(pendingStream).rejects.toThrow(APIUserAbortError)
				expect(fetches).toBe(0)
			} finally {
				await client.close()
			}
		})

		it("stops buffering closed tee() branches while the surviving branch drains", async () => {
			const encoder = new TextEncoder()
			let bodyCanceled = false
			const mockFetch = (async () => {
				const payload = [
					sseFrame(sampleUserMessageEvent(1)),
					sseFrame(sampleUserMessageEvent(2)),
					sseFrame(sampleUserMessageEvent(3)),
					sseFrame(sampleArchivedEvent(4)),
				].join("")
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(payload))
						controller.close()
					},
					cancel() {
						bodyCanceled = true
					},
				})
				return new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})
			}) as typeof globalThis.fetch

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
			})
			try {
				const live = await client.sessions.events.stream("sess_tee_close")
				const [left, right] = live.tee()
				const leftSeen: Array<number> = []
				for await (const ev of left) {
					leftSeen.push(ev.seq)
					if (ev.seq === 1) {
						break
					}
				}
				expect(leftSeen).toEqual([1])
				const rightSeen: Array<number> = []
				for await (const ev of right) {
					rightSeen.push(ev.seq)
				}
				expect(rightSeen).toEqual([1, 2, 3, 4])
				expect(bodyCanceled).toBe(false)
			} finally {
				await client.close()
			}
		})

		it.live(
			"does not retry ambiguous gateway 503/408/429 or Checkfu 503 on unkeyed writes, while retrying keyed writes",
			() =>
				Effect.gen(function* () {
					const ambiguousCases: ReadonlyArray<{
						readonly label: string
						readonly makeResponse: () => Response
					}> = [
						{
							label: "plain gateway 503",
							makeResponse: () => new Response("Service Unavailable", { status: 503 }),
						},
						{
							label: "plain gateway 408",
							makeResponse: () => new Response("Request Timeout", { status: 408 }),
						},
						{
							label: "plain gateway 429",
							makeResponse: () => new Response("Too Many Requests", { status: 429 }),
						},
						{
							label: "Checkfu 503 envelope",
							makeResponse: () =>
								jsonResponse(
									apiErrorBody("service_unavailable", "Timed out waiting for view consistency."),
									503,
								),
						},
					]

					for (const testCase of ambiguousCases) {
						let unkeyedCreateCalls = 0
						yield* Effect.gen(function* () {
							const client = yield* CheckfuClient
							yield* Effect.flip(client.agents.create({ name: "Unkeyed", model: "gpt-6.2-sol" }))
						}).pipe(
							Effect.provide(
								CheckfuClient.layerFetch({
									apiKey: "ck_test_key",
									baseUrl: "http://localhost:1337",
									maxRetries: 2,
									autoIdempotencyKey: false,
									fetch: async () => {
										unkeyedCreateCalls += 1
										return testCase.makeResponse()
									},
								}),
							),
						)
						expect(unkeyedCreateCalls, `${testCase.label} on unkeyed create`).toBe(1)

						let unkeyedSendCalls = 0
						yield* Effect.gen(function* () {
							const client = yield* CheckfuClient
							yield* Effect.flip(
								client.sessions.events.send("sess_1", {
									events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
								}),
							)
						}).pipe(
							Effect.provide(
								CheckfuClient.layerFetch({
									apiKey: "ck_test_key",
									baseUrl: "http://localhost:1337",
									maxRetries: 2,
									autoIdempotencyKey: false,
									fetch: async () => {
										unkeyedSendCalls += 1
										return testCase.makeResponse()
									},
								}),
							),
						)
						expect(unkeyedSendCalls, `${testCase.label} on unkeyed send`).toBe(1)
					}

					let keyedCalls = 0
					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const agent = yield* client.agents.create({ name: "Keyed", model: "gpt-6.2-sol" })
						expect(agent.type).toBe("agent")
					}).pipe(
						Effect.provide(
							CheckfuClient.layerFetch({
								apiKey: "ck_test_key",
								baseUrl: "http://localhost:1337",
								maxRetries: 2,
								autoIdempotencyKey: true,
								fetch: async () => {
									keyedCalls += 1
									if (keyedCalls === 1) {
										return new Response("Service Unavailable", {
											status: 503,
											headers: { "retry-after-ms": "1" },
										})
									}
									return jsonResponse(sampleAgent(), 201)
								},
							}),
						),
					)
					expect(keyedCalls).toBe(2)
				}),
		)

		it("settles Promise stream open and iteration cleanly when the producer fiber defects", async () => {
			const mockFetch = async () =>
				new Response(sseFrame(sampleUserMessageEvent(1)), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
			})
			try {
				await expect(
					client.sessions.events.stream("sess_defect_open", undefined, {
						onOpen: () => Effect.die(new Error("onOpen boom")),
					}),
				).rejects.toThrow("onOpen boom")
			} finally {
				await client.close()
			}

			const managed = ManagedRuntime.make(
				CheckfuClient.layerFetch({
					apiKey: "ck_test_key",
					baseUrl: "http://localhost:1337",
					fetch: mockFetch,
				}),
			)
			try {
				const promiseRuntime = makePromiseSdkRuntime(
					managed,
					Effect.map(CheckfuClient, (c) => c[INTERNAL_EFFECT_RUNTIME]),
				)
				const stream = await executeSseStreamPromise(promiseRuntime, undefined, (_rt, opts) =>
					Stream.unwrap(
						Effect.gen(function* () {
							if (opts.onOpen !== undefined) {
								yield* opts.onOpen(200)
							}
							return Stream.concat(
								Stream.make(sampleUserMessageEvent(1)),
								Stream.fromEffect(Effect.die(new Error("post-open defect"))),
							)
						}),
					),
				)
				const seen: Array<number> = []
				await expect(
					(async () => {
						for await (const ev of stream) {
							seen.push(ev.seq)
						}
					})(),
				).rejects.toThrow("post-open defect")
				expect(seen).toEqual([1])
			} finally {
				await managed.dispose()
			}
		})

		it("stops yielding buffered events immediately after abort() or iterator.return()", async () => {
			const payload = [
				sseFrame(sampleUserMessageEvent(1)),
				sseFrame(sampleUserMessageEvent(2)),
				sseFrame(sampleUserMessageEvent(3)),
				sseFrame(sampleArchivedEvent(4)),
			].join("")
			const mockFetch = async () =>
				new Response(payload, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
			})
			try {
				const abortStream = await client.sessions.events.stream("sess_buffered_abort")
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 15)
				})
				const abortIter = abortStream[Symbol.asyncIterator]()
				const first = await abortIter.next()
				expect(first.done).toBe(false)
				expect(first.value?.seq).toBe(1)
				abortStream.controller.abort()
				await expect(abortIter.next()).rejects.toThrow(APIUserAbortError)

				const returnStream = await client.sessions.events.stream("sess_buffered_return")
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 15)
				})
				const returnIter = returnStream[Symbol.asyncIterator]()
				const rFirst = await returnIter.next()
				expect(rFirst.done).toBe(false)
				expect(rFirst.value?.seq).toBe(1)
				expect(await returnIter.return?.()).toEqual({ value: undefined, done: true })
				expect(await returnIter.next()).toEqual({ value: undefined, done: true })
			} finally {
				await client.close()
			}
		})

		it.live("delivers complete SSE frames before an oversized trailing frame", () =>
			Effect.gen(function* () {
				const oversizedChunk = `${sseFrame(sampleUserMessageEvent(1))}id: 2\nevent: user.message\ndata: ${"x".repeat(10 * 1024 * 1024 + 64)}`
				const oversizedFetch = async () =>
					new Response(oversizedChunk, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})

				const deliveredBeforeError: Array<number> = []
				const oversizedErr = yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					return yield* Effect.flip(
						client.sessions.events.stream("sess_oversized").pipe(
							Stream.runForEach((ev) =>
								Effect.sync(() => {
									deliveredBeforeError.push(ev.seq)
								}),
							),
						),
					)
				}).pipe(Effect.provide(makeEffectLayer(oversizedFetch)))
				expect(deliveredBeforeError).toEqual([1])
				expect(oversizedErr._tag).toBe("APIConnectionError")
				expect(oversizedErr.message).toContain("Event stream decode failed")
			}),
		)

		it.live(
			"restricts positive x-should-retry hints to idempotent writes and refuses unkeyed replay",
			() =>
				Effect.gen(function* () {
					let unkeyedCreateCalls = 0
					const gateway503HintFetch = (async () => {
						unkeyedCreateCalls += 1
						return new Response("upstream unavailable", {
							status: 503,
							headers: {
								"content-type": "text/plain",
								"x-should-retry": "true",
								"retry-after-ms": "1",
							},
						})
					}) as typeof globalThis.fetch

					const createErr = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Effect.flip(client.agents.create({ name: "NoDup", model: "gpt-6.2-sol" }))
					}).pipe(
						Effect.provide(
							makeEffectLayer(gateway503HintFetch, {
								maxRetries: 2,
								autoIdempotencyKey: false,
							}),
						),
					)
					expect(createErr._tag).toBe("ServiceUnavailableError")
					expect(unkeyedCreateCalls).toBe(1)

					let unkeyedSendCalls = 0
					const unkeyedSendFetch = (async () => {
						unkeyedSendCalls += 1
						return new Response("gateway throttled", {
							status: 429,
							headers: {
								"content-type": "text/plain",
								"x-should-retry": "true",
								"retry-after-ms": "1",
							},
						})
					}) as typeof globalThis.fetch

					const sendErr = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Effect.flip(
							client.sessions.events.send("sess_1", {
								events: [{ type: "user.message", content: [{ type: "text", text: "once" }] }],
							}),
						)
					}).pipe(
						Effect.provide(
							makeEffectLayer(unkeyedSendFetch, {
								maxRetries: 2,
								autoIdempotencyKey: false,
							}),
						),
					)
					expect(sendErr._tag).toBe("RateLimitError")
					expect(unkeyedSendCalls).toBe(1)

					let keyedCreateCalls = 0
					const keyedRetryFetch = (async () => {
						keyedCreateCalls += 1
						if (keyedCreateCalls === 1) {
							return new Response("upstream unavailable", {
								status: 503,
								headers: {
									"content-type": "text/plain",
									"x-should-retry": "true",
									"retry-after-ms": "1",
								},
							})
						}
						return jsonResponse(sampleAgent({ id: "agent_keyed" }), 201)
					}) as typeof globalThis.fetch

					const created = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* client.agents.create({ name: "Safe", model: "gpt-6.2-sol" })
					}).pipe(
						Effect.provide(
							makeEffectLayer(keyedRetryFetch, {
								maxRetries: 2,
								autoIdempotencyKey: true,
							}),
						),
					)
					expect(created.id).toBe("agent_keyed")
					expect(keyedCreateCalls).toBe(2)

					let suppressed429Calls = 0
					const suppressed429Fetch = (async () => {
						suppressed429Calls += 1
						return jsonResponse(apiErrorBody("rate_limit_error", "quota exhausted"), 429, {
							"x-should-retry": "false",
							"retry-after-ms": "1",
						})
					}) as typeof globalThis.fetch

					const suppressedErr = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Effect.flip(
							client.agents.create({ name: "NoRetry", model: "gpt-6.2-sol" }),
						)
					}).pipe(
						Effect.provide(
							makeEffectLayer(suppressed429Fetch, {
								maxRetries: 2,
								autoIdempotencyKey: false,
							}),
						),
					)
					expect(suppressedErr._tag).toBe("RateLimitError")
					expect(suppressed429Calls).toBe(1)
				}),
		)

		it.live(
			"preserves opaque SSE frame IDs, ID-only updates, and empty ID resets for generic streams",
			() =>
				Effect.gen(function* () {
					const seenLastEventIds: Array<string | null> = []
					const seenContexts: Array<{
						readonly reconnect: boolean
						readonly cursor: string | undefined
					}> = []
					let connectionIndex = 0
					const genericFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						seenLastEventIds.push(req.headers.get("last-event-id"))
						connectionIndex += 1
						if (connectionIndex === 1) {
							return new Response('id: tok_alpha\ndata: {"n":1}\n\nid: tok_beta\n\n', {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							})
						}
						if (connectionIndex === 2) {
							return new Response('data: {"n":2}\n\nid:\n\n', {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							})
						}
						if (connectionIndex === 3) {
							return new Response('id: tok_gamma\ndata: {"n":3}\n\nid:\ndata: {"n":4}\n\n', {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							})
						}
						return new Response('id: tok_final\ndata: {"n":5,"done":true}\n\n', {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					}) as typeof globalThis.fetch

					const rawHttpClient = yield* HttpClient.HttpClient.pipe(
						Effect.provide(
							Layer.provide(
								FetchHttpClient.layer,
								Layer.succeed(FetchHttpClient.Fetch, genericFetch),
							),
						),
					)
					const defaultHeaders = { "Last-Event-ID": "tok_initial" }
					const httpClient = makeAuthorizedHttpClient(rawHttpClient, Redacted.make("ck_test_key"), {
						defaultHeaders,
					})
					const collected = yield* Stream.runCollect(
						streamApiSse<{ readonly n: number; readonly done?: boolean }>({
							open: (ctx) => {
								seenContexts.push(ctx)
								return httpClient.execute(HttpClientRequest.get("http://localhost:1337/stream"))
							},
							decodeEvent: (raw) =>
								Effect.succeed(JSON.parse(raw) as { readonly n: number; readonly done?: boolean }),
							isTerminal: (event) => event.done === true,
							defaultHeaders,
							options: {
								baseReconnectDelayMs: 1,
							},
						}),
					)
					expect(Array.from(collected).map((e) => e.n)).toEqual([1, 2, 3, 4, 5])
					expect(seenLastEventIds).toEqual(["tok_initial", "tok_beta", null, null])
					expect(seenContexts).toEqual([
						{ reconnect: false, cursor: "tok_initial" },
						{ reconnect: true, cursor: "tok_beta" },
						{ reconnect: true, cursor: undefined },
						{ reconnect: true, cursor: undefined },
					])
				}),
		)

		it.live(
			"uses the effective resume cursor across defaultHeaders, per-call Last-Event-ID, and after",
			() =>
				Effect.gen(function* () {
					const reqs1: Array<{
						readonly after: string | null
						readonly lastEventId: string | null
					}> = []
					const headerWinsFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						const url = new URL(req.url)
						const header = req.headers.get("last-event-id")
						const after = url.searchParams.get("after")
						reqs1.push({ after, lastEventId: header })
						const cursor = Number(header !== null && header.length > 0 ? header : (after ?? "0"))
						const frames = [51, 52, 100, 101]
							.flatMap((seq) =>
								seq > cursor
									? [
											seq === 101
												? sseFrame(sampleArchivedEvent(seq))
												: sseFrame(sampleUserMessageEvent(seq)),
										]
									: [],
							)
							.join("")
						return new Response(frames, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					}) as typeof globalThis.fetch

					const delivered1 = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Stream.runCollect(
							client.sessions.events.stream(
								"sess_hdr_wins",
								{ after: 100 },
								{ headers: { "Last-Event-ID": "50" } },
							),
						)
					}).pipe(Effect.provide(makeEffectLayer(headerWinsFetch)))
					expect(Array.from(delivered1).map((e) => e.seq)).toEqual([51, 52, 100, 101])
					expect(reqs1).toEqual([{ after: null, lastEventId: "50" }])

					const deliveredDefault = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Stream.runCollect(
							client.sessions.events.stream("sess_default_hdr", { after: 100 }),
						)
					}).pipe(
						Effect.provide(
							makeEffectLayer(headerWinsFetch, {
								defaultHeaders: { "Last-Event-ID": "50" },
							}),
						),
					)
					expect(Array.from(deliveredDefault).map((e) => e.seq)).toEqual([51, 52, 100, 101])

					const reqs2: Array<{
						readonly after: string | null
						readonly lastEventId: string | null
					}> = []
					let inverseCalls = 0
					const inverseFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						const url = new URL(req.url)
						reqs2.push({
							after: url.searchParams.get("after"),
							lastEventId: req.headers.get("last-event-id"),
						})
						inverseCalls += 1
						if (inverseCalls === 1) {
							return jsonResponse(apiErrorBody("service_unavailable", "retry"), 503, {
								"retry-after-ms": "1",
							})
						}
						return new Response(sseFrame(sampleArchivedEvent(101)), {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					}) as typeof globalThis.fetch

					const delivered2 = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Stream.runCollect(
							client.sessions.events.stream(
								"sess_inverse",
								{ after: 50 },
								{
									baseReconnectDelayMs: 1,
									headers: { "Last-Event-ID": "100" },
								},
							),
						)
					}).pipe(Effect.provide(makeEffectLayer(inverseFetch)))
					expect(Array.from(delivered2).map((e) => e.seq)).toEqual([101])
					expect(reqs2).toEqual([
						{ after: null, lastEventId: "100" },
						{ after: null, lastEventId: "100" },
					])
				}),
		)

		it.live("waits for pending automation receipts in both clients", () =>
			Effect.gen(function* () {
				let createPolls = 0
				const createKeys: Array<string | null> = []
				let pausePolls = 0
				let archivePolls = 0
				const pending = (id: string) => jsonResponse({ id, type: "automation", pending: true }, 202)
				const automationFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					const url = new URL(req.url)
					if (req.method === "POST" && url.pathname === "/v1/automations") {
						createKeys.push(req.headers.get("idempotency-key"))
						return pending("auto_new")
					}
					if (req.method === "GET" && url.pathname === "/v1/automations/auto_new") {
						createPolls += 1
						return createPolls < 3
							? jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
							: jsonResponse(sampleAutomation({ id: "auto_new" }))
					}
					if (req.method === "POST" && url.pathname === "/v1/automations/auto_pause/pause") {
						return pending("auto_pause")
					}
					if (req.method === "GET" && url.pathname === "/v1/automations/auto_pause") {
						pausePolls += 1
						return jsonResponse(
							sampleAutomation({ id: "auto_pause", status: pausePolls < 3 ? "active" : "paused" }),
						)
					}
					if (req.method === "POST" && url.pathname === "/v1/automations/auto_arch/archive") {
						return pending("auto_arch")
					}
					if (req.method === "GET" && url.pathname === "/v1/automations/auto_arch") {
						archivePolls += 1
						return jsonResponse(
							sampleAutomation({
								id: "auto_arch",
								status: archivePolls < 2 ? "active" : "archived",
								archived_at: archivePolls < 2 ? null : ISO_NOW,
							}),
						)
					}
					if (req.method === "POST" && url.pathname === "/v1/automations/auto_run/run") {
						return jsonResponse(
							{
								type: "automation_run",
								automation_id: "auto_run",
								run: 4,
								status: "queued",
								trigger: { type: "manual" },
							},
							201,
						)
					}
					return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
				}) as typeof globalThis.fetch
				const pollOpts = {
					initialDelay: "1 millis" as const,
					maxDelay: "2 millis" as const,
					timeout: "2 seconds" as const,
				}
				const body = {
					name: "Morning report",
					agent: "agent_1",
					environment_id: "env_1",
					initial_events: [
						{
							type: "user.message" as const,
							content: [{ type: "text" as const, text: "Report." }],
						},
					],
					schedule: { type: "cron" as const, expression: "0 9 * * *", timezone: "UTC" },
				}

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					const created = yield* client.waitForPending(
						yield* client.automations.create(body, { idempotencyKey: "effect-create" }),
						pollOpts,
					)
					expect(created.id).toBe("auto_new")
					expect(createPolls).toBe(3)

					const pausePending = yield* client.automations.pause("auto_pause")
					const needsUntil = yield* Effect.flip(client.waitForPending(pausePending, pollOpts))
					expect(needsUntil._tag).toBe("CheckfuConfigError")
					const paused = yield* client.waitForPending(pausePending, {
						...pollOpts,
						until: (automation) => automation.status === "paused",
					})
					expect(paused.status).toBe("paused")
					expect(pausePolls).toBe(3)

					const archived = yield* client.waitForPending(
						yield* client.automations.archive("auto_arch"),
						pollOpts,
					)
					expect(archived.status).toBe("archived")
					expect(archivePolls).toBe(2)

					const queued = yield* client.automations.run("auto_run")
					expect(queued).toMatchObject({ run: 4, status: "queued" })
					expect("pending" in queued).toBe(false)
				}).pipe(Effect.provide(makeEffectLayer(automationFetch, { maxRetries: 0 })))

				createPolls = 0
				archivePolls = 0
				yield* Effect.promise(async () => {
					const promiseClient = new Checkfu({
						apiKey: "ck_test_key",
						baseUrl: "http://localhost:1337",
						maxRetries: 0,
						fetch: automationFetch,
					})
					try {
						const created = await promiseClient.waitForPending(
							await promiseClient.automations.create(body, { idempotencyKey: "promise-create" }),
							pollOpts,
						)
						expect(created.id).toBe("auto_new")
						expect(created.created_at).toBe(ISO_NOW)
						expect(createPolls).toBe(3)
						const archived = await promiseClient.waitForPending(
							await promiseClient.automations.archive("auto_arch"),
							pollOpts,
						)
						expect(archived.archived_at).toBe(ISO_NOW)
						expect(archivePolls).toBe(2)
					} finally {
						await promiseClient.close()
					}
					const unkeyed = new Checkfu({
						apiKey: "ck_test_key",
						baseUrl: "http://localhost:1337",
						maxRetries: 0,
						fetch: automationFetch,
					})
					try {
						expectNotCallable(unkeyed.automations.create)<[typeof body]>()
						const looseAutomations = unkeyed.automations as unknown as {
							create(payload: typeof body): ReturnType<typeof unkeyed.automations.create>
						}
						await expect(looseAutomations.create(body)).rejects.toMatchObject({
							_tag: "BadRequestError",
						})
					} finally {
						await unkeyed.close()
					}
					expect(createKeys).toEqual(["effect-create", "promise-create"])
				})
			}),
		)

		it.live(
			"distinguishes ready archive and update mutations from stale existing projections in waitForPending",
			() =>
				Effect.gen(function* () {
					let agentArchivePolls = 0
					let agentUpdatePolls = 0
					let envUpdatePolls = 0
					let envArchivePolls = 0
					let sessionArchivePolls = 0
					const mutationFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						const url = new URL(req.url)
						if (req.method === "POST" && url.pathname === "/v1/agents/agent_arch/archive") {
							return jsonResponse({ id: "agent_arch", type: "agent", pending: true }, 202)
						}
						if (req.method === "GET" && url.pathname === "/v1/agents/agent_arch") {
							agentArchivePolls += 1
							return jsonResponse(
								sampleAgent({
									id: "agent_arch",
									archived_at: agentArchivePolls < 3 ? null : ISO_NOW,
								}),
							)
						}
						if (req.method === "POST" && url.pathname === "/v1/agents/agent_upd") {
							return jsonResponse({ id: "agent_upd", type: "agent", pending: true }, 202)
						}
						if (req.method === "GET" && url.pathname === "/v1/agents/agent_upd") {
							agentUpdatePolls += 1
							return jsonResponse(
								sampleAgent({
									id: "agent_upd",
									version: agentUpdatePolls < 3 ? 2 : 3,
									name: agentUpdatePolls < 3 ? "v2" : "v3",
								}),
							)
						}
						if (req.method === "POST" && url.pathname === "/v1/environments/env_upd") {
							return jsonResponse({ id: "env_upd", type: "environment", pending: true }, 202)
						}
						if (req.method === "GET" && url.pathname === "/v1/environments/env_upd") {
							envUpdatePolls += 1
							return jsonResponse(
								sampleEnvironment({
									id: "env_upd",
									version: envUpdatePolls < 2 ? 1 : 2,
									name: envUpdatePolls < 2 ? "old" : "new",
								}),
							)
						}
						if (req.method === "POST" && url.pathname === "/v1/environments/env_arch/archive") {
							return jsonResponse({ id: "env_arch", type: "environment", pending: true }, 202)
						}
						if (req.method === "GET" && url.pathname === "/v1/environments/env_arch") {
							envArchivePolls += 1
							return jsonResponse(
								sampleEnvironment({
									id: "env_arch",
									archived_at: envArchivePolls < 2 ? null : ISO_NOW,
								}),
							)
						}
						if (req.method === "POST" && url.pathname === "/v1/sessions/sess_arch/archive") {
							return jsonResponse({ id: "sess_arch", type: "session", pending: true }, 202)
						}
						if (req.method === "GET" && url.pathname === "/v1/sessions/sess_arch") {
							sessionArchivePolls += 1
							return jsonResponse(
								sampleSession({
									id: "sess_arch",
									archived_at: sessionArchivePolls < 2 ? null : ISO_NOW,
								}),
							)
						}
						return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
					}) as typeof globalThis.fetch

					const pollOpts = {
						initialDelay: "1 millis" as const,
						maxDelay: "2 millis" as const,
						timeout: "2 seconds" as const,
					}

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const pendingAgentArch = yield* client.agents.archive("agent_arch")
						const archivedAgent = yield* client.waitForPending(pendingAgentArch, pollOpts)
						expect(archivedAgent.archived_at).not.toBeNull()
						expect(agentArchivePolls).toBe(3)

						const pendingAgentUpd = yield* client.agents.update("agent_upd", {
							version: 2,
							name: "v3",
						})
						const updatedAgent = yield* client.waitForPending(pendingAgentUpd, pollOpts)
						expect(updatedAgent.version).toBe(3)
						expect(updatedAgent.name).toBe("v3")
						expect(agentUpdatePolls).toBe(3)

						const pendingEnvUpd = yield* client.environments.update("env_upd", {
							version: 1,
							name: "new",
						})
						const updatedEnv = yield* client.waitForPending(pendingEnvUpd, pollOpts)
						expect(updatedEnv.version).toBe(2)
						expect(envUpdatePolls).toBe(2)

						const pendingEnvArch = yield* client.environments.archive("env_arch")
						const archivedEnv = yield* client.waitForPending(pendingEnvArch, pollOpts)
						expect(archivedEnv.archived_at).not.toBeNull()
						expect(envArchivePolls).toBe(2)

						const pendingSessArch = yield* client.sessions.archive("sess_arch")
						const archivedSess = yield* client.waitForPending(pendingSessArch, pollOpts)
						expect(archivedSess.archived_at).not.toBeNull()
						expect(sessionArchivePolls).toBe(2)

						const ambiguousPending = attachPendingReadiness(
							{ id: "agent_arch", type: "agent" as const, pending: true as const },
							{ kind: "requires-until", operation: "agents.customMutation" },
						)
						const cfgErr = yield* Effect.flip(client.waitForPending(ambiguousPending, pollOpts))
						expect(cfgErr._tag).toBe("CheckfuConfigError")
						expect(cfgErr.message).toContain("until")
					}).pipe(Effect.provide(makeEffectLayer(mutationFetch, { maxRetries: 0 })))

					agentArchivePolls = 0
					agentUpdatePolls = 0
					yield* Effect.promise(async () => {
						const promiseClient = new Checkfu({
							apiKey: "ck_test_key",
							baseUrl: "http://localhost:1337",
							maxRetries: 0,
							fetch: mutationFetch,
						})
						try {
							const archivedRes = await promiseClient.agents.archive("agent_arch")
							const archived = await promiseClient.waitForPending(archivedRes, pollOpts)
							expect(archived.archived_at).toBe(ISO_NOW)
							expect(agentArchivePolls).toBe(3)

							const { data: updatePending } = await promiseClient.agents
								.update("agent_upd", { version: 2, name: "v3" })
								.withResponse()
							const updated = await promiseClient.waitForPending(updatePending, pollOpts)
							expect(updated.version).toBe(3)
							expect(agentUpdatePolls).toBe(3)
						} finally {
							await promiseClient.close()
						}
					})
				}),
		)

		it.live(
			"normalizes trailing /v1 at most once across Promise/Effect construction and withOptions",
			() =>
				Effect.gen(function* () {
					const seenUrls: Array<string> = []
					const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						seenUrls.push(req.url)
						return jsonResponse(sampleAgent())
					}) as typeof globalThis.fetch

					yield* Effect.promise(async () => {
						const client = new Checkfu({
							apiKey: "ck_test_key",
							baseUrl: "https://gateway.example/tenant/v1/v1",
							fetch: mockFetch,
						})
						const cloned = client.withOptions({ maxRetries: 3 })
						const overridden = cloned.withOptions({
							baseUrl: "https://gateway.example/other/v1/v1",
						})
						try {
							expect(client.baseUrl).toBe("https://gateway.example/tenant/v1")
							expect(cloned.baseUrl).toBe("https://gateway.example/tenant/v1")
							expect(overridden.baseUrl).toBe("https://gateway.example/other/v1")

							await client.agents.retrieve("agent_1")
							await cloned.agents.retrieve("agent_1")
							await overridden.agents.retrieve("agent_1")

							expect(seenUrls).toEqual([
								"https://gateway.example/tenant/v1/v1/agents/agent_1",
								"https://gateway.example/tenant/v1/v1/agents/agent_1",
								"https://gateway.example/other/v1/v1/agents/agent_1",
							])
						} finally {
							await overridden.close()
							await cloned.close()
							await client.close()
						}
					})

					seenUrls.length = 0
					yield* Effect.gen(function* () {
						const effectClient = yield* CheckfuClient
						const effectClone = yield* effectClient.withOptions({ maxRetries: 3 })
						expect(effectClient.baseUrl).toBe("https://gateway.example/tenant/v1")
						expect(effectClone.baseUrl).toBe("https://gateway.example/tenant/v1")
						yield* effectClient.agents.retrieve("agent_1")
						yield* effectClone.agents.retrieve("agent_1")
					}).pipe(
						Effect.provide(
							makeEffectLayer(mockFetch, {
								baseUrl: "https://gateway.example/tenant/v1/v1",
							}),
						),
					)
					expect(seenUrls).toEqual([
						"https://gateway.example/tenant/v1/v1/agents/agent_1",
						"https://gateway.example/tenant/v1/v1/agents/agent_1",
					])
				}),
		)

		it.live(
			"does not treat a keepalive connection that replays an already-seen SSE event as healthyIdle",
			() =>
				Effect.gen(function* () {
					let attempts = 0
					const encoder = new TextEncoder()
					const replayErrorFetch = (async () => {
						attempts += 1
						const body = new ReadableStream<Uint8Array>({
							async start(controller) {
								controller.enqueue(encoder.encode(": keepalive\n\n"))
								await new Promise<void>((resolve) => {
									setTimeout(resolve, 15)
								})
								controller.enqueue(encoder.encode(sseFrame(sampleUserMessageEvent(5))))
								controller.error(new TypeError("connection reset after replay"))
							},
						})
						return new Response(body, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					}) as typeof globalThis.fetch

					const err = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Effect.flip(
							Stream.runCollect(
								client.sessions.events.stream(
									"sess_replay_budget",
									{ after: 5 },
									{
										maxReconnectAttempts: 2,
										baseReconnectDelayMs: 1,
										healthyIdleDurationMs: 5,
									},
								),
							),
						)
					}).pipe(Effect.provide(makeEffectLayer(replayErrorFetch)))

					expect(err._tag).toBe("APIConnectionError")
					expect(attempts).toBe(3)
				}),
		)

		it.live(
			"requires an explicit until predicate for copied or serialized pending receipts without readiness metadata",
			() =>
				Effect.gen(function* () {
					let getPolls = 0
					const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
						const req = toWebRequest(input, init)
						const url = new URL(req.url)
						if (req.method === "POST" && url.pathname === "/v1/agents/agent_copy/archive") {
							return jsonResponse({ id: "agent_copy", type: "agent", pending: true }, 202)
						}
						if (req.method === "POST" && url.pathname === "/v1/agents") {
							return jsonResponse({ id: "agent_created", type: "agent", pending: true }, 202)
						}
						if (req.method === "GET" && url.pathname === "/v1/agents/agent_copy") {
							getPolls += 1
							return jsonResponse(
								sampleAgent({
									id: "agent_copy",
									archived_at: getPolls < 2 ? null : ISO_NOW,
								}),
							)
						}
						if (req.method === "GET" && url.pathname === "/v1/agents/agent_created") {
							getPolls += 1
							return jsonResponse(sampleAgent({ id: "agent_created" }))
						}
						return jsonResponse(apiErrorBody("not_found_error", "not found"), 404)
					}) as typeof globalThis.fetch

					const pollOpts = {
						initialDelay: "1 millis" as const,
						maxDelay: "2 millis" as const,
						timeout: "2 seconds" as const,
					}

					yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						const pendingArchive = yield* client.agents.archive("agent_copy")
						expect(isPendingResource(pendingArchive)).toBe(true)

						const copied = { ...pendingArchive }
						const cloned = structuredClone(pendingArchive)

						const copyErr = yield* Effect.flip(client.waitForPending(copied, pollOpts))
						expect(copyErr._tag).toBe("CheckfuConfigError")
						expect(copyErr.message).toContain("until")
						expect(getPolls).toBe(0)

						const versioned = { ...pendingArchive, version: 7 }
						const versionedErr = yield* Effect.flip(client.waitForPending(versioned, pollOpts))
						expect(versionedErr._tag).toBe("CheckfuConfigError")
						expect(versionedErr.message).toContain("until")
						expect(getPolls).toBe(0)

						const cloneErr = yield* Effect.flip(client.waitForPending(cloned, pollOpts))
						expect(cloneErr._tag).toBe("CheckfuConfigError")
						expect(cloneErr.message).toContain("until")
						expect(getPolls).toBe(0)

						const ready = yield* client.waitForPending(cloned, {
							...pollOpts,
							until: (agent) => agent.archived_at !== null,
						})
						expect(ready.archived_at).not.toBeNull()
						expect(getPolls).toBe(2)

						const pendingCreate = yield* client.agents.create({
							name: "Fresh",
							model: "gpt-6.2-sol",
						})
						const created = yield* client.waitForPending(pendingCreate, pollOpts)
						expect(created.id).toBe("agent_created")
					}).pipe(Effect.provide(makeEffectLayer(fetchImpl, { maxRetries: 0 })))
				}),
		)

		it("honors stream.controller.abort() immediately on lagging tee() branches before draining buffered events", async () => {
			const payload = [
				sseFrame(sampleUserMessageEvent(1)),
				sseFrame(sampleUserMessageEvent(2)),
				sseFrame(sampleUserMessageEvent(3)),
				sseFrame(sampleArchivedEvent(4)),
			].join("")
			const mockFetch = async () =>
				new Response(payload, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})

			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: mockFetch,
			})
			try {
				const stream = await client.sessions.events.stream("sess_tee_abort")
				const [fastBranch, slowBranch] = stream.tee()
				const fastIter = fastBranch[Symbol.asyncIterator]()
				const slowIter = slowBranch[Symbol.asyncIterator]()

				expect((await fastIter.next()).value?.seq).toBe(1)
				expect((await fastIter.next()).value?.seq).toBe(2)
				expect((await fastIter.next()).value?.seq).toBe(3)

				stream.controller.abort()
				await expect(slowIter.next()).rejects.toThrow(APIUserAbortError)
				await expect(fastIter.next()).rejects.toThrow(APIUserAbortError)
			} finally {
				await client.close()
			}
		})

		it.live(
			"fails immediately on HTTP 200 response schema mismatches while still retrying interrupted body reads",
			() =>
				Effect.gen(function* () {
					let mismatchCalls = 0
					const mismatchFetch = (async () => {
						mismatchCalls += 1
						return jsonResponse({})
					}) as typeof globalThis.fetch

					const mismatchErr = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Effect.flip(client.agents.retrieve("agent_1"))
					}).pipe(Effect.provide(makeEffectLayer(mismatchFetch, { maxRetries: 2 })))

					expect(mismatchErr._tag).toBe("APIConnectionError")
					expect(mismatchErr.retryable).toBe(false)
					expect(mismatchCalls).toBe(1)

					let htmlCalls = 0
					const htmlFetch = (async () => {
						htmlCalls += 1
						return new Response("<html>gateway error page</html>", {
							status: 200,
							headers: { "content-type": "application/json" },
						})
					}) as typeof globalThis.fetch

					const htmlErr = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* Effect.flip(client.agents.retrieve("agent_1"))
					}).pipe(Effect.provide(makeEffectLayer(htmlFetch, { maxRetries: 2 })))

					expect(htmlErr._tag).toBe("APIConnectionError")
					expect(htmlErr.retryable).toBe(false)
					expect(htmlCalls).toBe(1)

					let interruptedCalls = 0
					const encoder = new TextEncoder()
					const interruptedFetch = (async () => {
						interruptedCalls += 1
						if (interruptedCalls === 1) {
							const body = new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(encoder.encode('{"id":"agent_1"'))
									controller.error(new TypeError("socket closed mid-body"))
								},
							})
							return new Response(body, {
								status: 200,
								headers: { "content-type": "application/json" },
							})
						}
						return jsonResponse(sampleAgent({ id: "agent_1" }))
					}) as typeof globalThis.fetch

					const recovered = yield* Effect.gen(function* () {
						const client = yield* CheckfuClient
						return yield* client.agents.retrieve("agent_1")
					}).pipe(Effect.provide(makeEffectLayer(interruptedFetch, { maxRetries: 2 })))

					expect(recovered.id).toBe("agent_1")
					expect(interruptedCalls).toBe(2)
				}),
		)

		it("defers raw web Response reconstruction until withResponse() or asResponse() is consumed", async () => {
			let fetchCalls = 0
			const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const req = toWebRequest(input, init)
				const url = new URL(req.url)
				fetchCalls += 1
				if (url.pathname === "/v1/agents/agent_lazy") {
					return jsonResponse(sampleAgent({ id: "agent_lazy" }))
				}
				const token = url.searchParams.get("page")
				if (token === null) {
					return jsonResponse({
						data: [sampleUserMessageEvent(1)],
						next_page: "1",
					})
				}
				if (token === "1") {
					return jsonResponse({
						data: [sampleUserMessageEvent(2)],
						next_page: "2",
					})
				}
				return jsonResponse({
					data: [sampleUserMessageEvent(3)],
					next_page: null,
				})
			}) as typeof globalThis.fetch

			const managed = ManagedRuntime.make(
				CheckfuClient.layerFetch({
					apiKey: "ck_test_key",
					baseUrl: "http://localhost:1337",
					fetch: mockFetch,
				}),
			)
			try {
				let responseBodyCopies = 0
				const baseRuntime = makePromiseSdkRuntime(
					managed,
					Effect.map(CheckfuClient, (c) => c[INTERNAL_EFFECT_RUNTIME]),
				)
				const spyRuntime = {
					...baseRuntime,
					runPromise: <A>(effect: Effect.Effect<A>): Promise<A> => {
						responseBodyCopies += 1
						return baseRuntime.runPromise(effect)
					},
				}

				const agent = await executeUnaryPromise(spyRuntime, undefined, (effectRuntime, opts) =>
					new EffectAgentsResource(effectRuntime).retrieve("agent_lazy", {
						...opts,
						withResponse: true,
					}),
				)
				expect(agent.id).toBe("agent_lazy")
				expect(responseBodyCopies).toBe(0)

				const seenSeqs: Array<number> = []
				const pagePromise = executePaginatedPromise(
					spyRuntime,
					undefined,
					undefined,
					(effectRuntime, token: string | undefined, opts) =>
						new EffectSessionsEventsResource(effectRuntime).list(
							"sess_lazy",
							token === undefined ? {} : { page: token },
							{ ...opts, withResponse: true },
						),
				)
				for await (const ev of pagePromise) {
					seenSeqs.push(ev.seq)
				}
				expect(seenSeqs).toEqual([1, 2, 3])
				expect(responseBodyCopies).toBe(0)

				const callsBefore = fetchCalls
				const pendingUnary = executeUnaryPromise(spyRuntime, undefined, (effectRuntime, opts) =>
					new EffectAgentsResource(effectRuntime).retrieve("agent_lazy", {
						...opts,
						withResponse: true,
					}),
				)
				const dataOnly = await pendingUnary
				expect(dataOnly.id).toBe("agent_lazy")
				expect(responseBodyCopies).toBe(0)

				const withRes = await pendingUnary.withResponse()
				const asRes = await pendingUnary.asResponse()
				expect(fetchCalls).toBe(callsBefore + 1)
				expect(responseBodyCopies).toBe(1)
				expect(asRes).toBe(withRes.response)
				expect(asRes.bodyUsed).toBe(false)
				expect(((await asRes.json()) as { readonly id: string }).id).toBe("agent_lazy")
			} finally {
				await managed.dispose()
			}
		})
	})
})
