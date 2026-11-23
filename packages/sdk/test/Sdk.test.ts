import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIPromise,
	APIUserAbortError,
	AuthenticationError,
	BadRequestError,
	Checkfu,
	CheckfuClient,
	CheckfuConfigError,
	CheckfuError,
	ConflictError,
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
} from "../src/index.ts"
import type { BodyOf, JsonResultOf, JsonSessionEvent, Op, ResultOf } from "../src/index.ts"

const ISO_NOW = "2026-11-23T18:00:00.000Z"

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

const sampleEnvironment = (overrides?: {
	readonly id?: string
	readonly version?: number
	readonly name?: string
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
}) => ({
	id: "sess_1",
	type: "session" as const,
	status: "idle" as const,
	agent: { id: "agent_1", version: 1 },
	environment_id: "env_1",
	title: "Demo",
	turn: 0,
	usage: { input_tokens: 0, output_tokens: 0 },
	created_at: ISO_NOW,
	updated_at: ISO_NOW,
	archived_at: null,
	...overrides,
})

const sampleUserMessageEvent = (seq: number, text = `msg-${seq}`) => ({
	id: `evt_${seq}`,
	seq,
	type: "user.message",
	created_at: ISO_NOW,
	content: [{ type: "text", text }],
})

const sampleArchivedEvent = (seq: number) => ({
	id: `evt_${seq}`,
	seq,
	type: "session.archived",
	created_at: ISO_NOW,
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
										turn: 1,
										queued: false,
										content: [{ type: "text", text: "hi" }],
									},
									{ type: "user.interrupt" },
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
								accepted: [{ type: "user.interrupt" }],
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
							expect(err.accepted).toEqual([{ type: "user.interrupt" }])
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
					const after = url.searchParams.get("after")
					if (url.pathname.includes("sess_stalled")) {
						return jsonResponse({
							data: [sampleUserMessageEvent(2)],
							has_more: true,
							next_cursor: 2,
						})
					}
					if (after === null) {
						return jsonResponse({
							data: [sampleUserMessageEvent(1), sampleUserMessageEvent(2)],
							has_more: true,
							next_cursor: 2,
						})
					}
					if (after === "2") {
						return jsonResponse({
							data: [sampleUserMessageEvent(3)],
							has_more: false,
							next_cursor: null,
						})
					}
					return jsonResponse({ data: [], has_more: false, next_cursor: null })
				}) as typeof globalThis.fetch

				yield* Effect.gen(function* () {
					const client = yield* CheckfuClient
					const all = yield* Stream.runCollect(
						client.sessions.events.listStream("sess_1", { limit: 2 }),
					)
					expect(Array.from(all).map((e) => e.seq)).toEqual([1, 2, 3])

					const stalledErr = yield* Effect.flip(
						Stream.runDrain(client.sessions.events.listStream("sess_stalled", { after: 2 })),
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
						// Replay seq 1 and emit seq 2 + terminal archived seq 3
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

						// Non-pending value returns immediately without polling
						const passthrough = yield* client.waitForPending(ready)
						expect(passthrough).toBe(ready)
						expect(polls).toBe(3)
					}).pipe(Effect.provide(makeEffectLayer(mockFetch, { maxRetries: 0 })))
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
						has_more: true,
						next_cursor: 2,
					})
				}
				const after = url.searchParams.get("after")
				if (after === null) {
					return jsonResponse({
						data: [sampleUserMessageEvent(1), sampleUserMessageEvent(2)],
						has_more: true,
						next_cursor: 2,
					})
				}
				return jsonResponse({
					data: [sampleUserMessageEvent(3)],
					has_more: false,
					next_cursor: null,
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
				const secondPage = await firstPage.getNextPage()
				expect(secondPage.data.map((e) => e.seq)).toEqual([3])
				expect(secondPage.hasNextPage()).toBe(false)

				const all: Array<JsonSessionEvent> = []
				for await (const event of client.sessions.events.list("sess_1", { limit: 2 })) {
					all.push(event)
				}
				expect(all.map((e) => e.seq)).toEqual([1, 2, 3])
				expect(typeof all[0]?.created_at).toBe("string")

				await expect(
					(async () => {
						for await (const _event of client.sessions.events.list("sess_cycle", { after: 2 })) {
							// iterates until cycle guard triggers
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
				// 1. Eager 404 on await before entering for-await
				await expect(client.sessions.events.stream("sess_missing")).rejects.toThrow(NotFoundError)

				// 2. Direct for-await without extra await
				const directEvents: Array<JsonSessionEvent> = []
				for await (const ev of client.sessions.events.stream("sess_ok")) {
					directEvents.push(ev)
				}
				expect(directEvents.map((e) => e.seq)).toEqual([1, 2])
				expect(typeof directEvents[0]?.created_at).toBe("string")

				// 3. tee() splits one underlying connection into two independent streams
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

				// 4. toReadableStream yields UTF-8 JSONL
				const readableStream = (await client.sessions.events.stream("sess_ok")).toReadableStream()
				const jsonlText = await new Response(readableStream).text()
				const parsedLines = jsonlText
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { readonly seq: number })
				expect(parsedLines.map((l) => l.seq)).toEqual([1, 2])

				// 5. controller.abort() aborts a live stream with APIUserAbortError
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

				// 6. waitForPending on Promise facade
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
			expect(SDK_OPERATION_BINDINGS.length).toBe(15)
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

			// Compile-time assertions for Op / BodyOf / ResultOf / JsonResultOf type helpers
			const sampleBody: BodyOf<Op<"agents.create">> = { name: "Bot", model: "gpt-6.2-sol" }
			expect(sampleBody.name).toBe("Bot")
			type EffectRetrieveAgent = ResultOf<Op<"agents.retrieve">>
			type JsonRetrieveAgent = JsonResultOf<Op<"agents.retrieve">>
			const checkTypes: readonly [EffectRetrieveAgent["type"]?, JsonRetrieveAgent["created_at"]?] =
				["agent", ISO_NOW]
			expect(checkTypes[0]).toBe("agent")
		})
	})
})
