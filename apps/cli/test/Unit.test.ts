import { describe, expect, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as ConfigProvider from "effect/ConfigProvider"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as YAML from "yaml"
import {
	DEFAULT_API_URL,
	makeCheckfuClient,
	normalizeApiUrl,
	resolveBaseUrl,
} from "../src/Client.ts"
import {
	escapeTerminalControlCharacters,
	hasUnsafeTerminalCodePoint,
	stringifyTerminalSafeJson,
} from "../src/TerminalOutput.ts"
import { evaluateTransform, formatOutput } from "../src/Transform.ts"

const toWebRequest = (input: RequestInfo | URL, init?: RequestInit): Request =>
	typeof input === "string" || "href" in input ? new Request(input, init) : input

const getRequestHeaders = (input: RequestInfo | URL, init?: RequestInit): Headers =>
	new Headers(typeof input === "string" || "href" in input ? init?.headers : input.headers)

describe("normalizeApiUrl", () => {
	it("accepts https URLs and loopback http URLs and strips trailing / and /v1", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				expect(yield* normalizeApiUrl("https://api.checkfu.com/")).toBe("https://api.checkfu.com")
				expect(yield* normalizeApiUrl("https://api.checkfu.com/v1/")).toBe(
					"https://api.checkfu.com",
				)
				expect(yield* normalizeApiUrl("https://api.checkfu.com/prefix/v1")).toBe(
					"https://api.checkfu.com/prefix",
				)
				expect(yield* normalizeApiUrl("http://localhost:1337/v1")).toBe("http://localhost:1337")
				expect(yield* normalizeApiUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080")
				expect(yield* normalizeApiUrl("http://[::1]:1337/v1/")).toBe("http://[::1]:1337")
			}),
		)
	})

	it("rejects non-loopback http, credentials, query, fragment, and bad schemes", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const cases = [
					"",
					"not-a-url",
					"http://api.example.com",
					"https://user:pass@api.example.com",
					"https://api.example.com?foo=bar",
					"https://api.example.com#frag",
					"ftp://api.example.com",
				]
				for (const bad of cases) {
					const err = yield* Effect.flip(normalizeApiUrl(bad))
					expect(err._tag).toBe("CliFailure")
					expect(err.exitCode).toBe(1)
				}

				const malformedWithCreds = yield* Effect.flip(
					normalizeApiUrl("https://alice:supersecret@badhost:99999"),
				)
				expect(malformedWithCreds.exitCode).toBe(1)
				expect(malformedWithCreds.message).not.toContain("alice")
				expect(malformedWithCreds.message).not.toContain("supersecret")
				expect(malformedWithCreds.message).not.toContain("badhost")
			}),
		)
	})

	it("streams typed SSE via HttpApiSchema.StreamSse with reconnect, backoff, and validation", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const encoder = new TextEncoder()
				const sseSessionFrame = (
					seq: number,
					type: "user.message" | "session.archived",
					eol = "\n",
				): string => {
					const payload =
						type === "user.message"
							? {
									id: `evt_${seq}`,
									seq,
									type,
									created_at: "2026-11-22T00:00:00.000Z",
									content: [{ type: "text", text: `msg ${seq}` }],
								}
							: {
									id: `evt_${seq}`,
									seq,
									type,
									created_at: "2026-11-22T00:00:00.000Z",
								}
					return `id: ${seq}${eol}event: ${type}${eol}data: ${JSON.stringify(payload)}${eol}${eol}`
				}

				const makeLayer = (fetchFn: typeof globalThis.fetch) =>
					Layer.mergeAll(
						FetchHttpClient.layer.pipe(
							Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
						),
						SecureRandom.layerWebCrypto,
						ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_API_KEY: "ck_test" })),
					)

				const makeVirtualClock = (initialNanos = 1_000_000_000n) => {
					let nowNanos = initialNanos
					const sleepsMs: Array<number> = []
					const clock: Clock.Clock = {
						currentTimeMillisUnsafe: () => Number(nowNanos / 1_000_000n),
						currentTimeMillis: Effect.sync(() => Number(nowNanos / 1_000_000n)),
						currentTimeNanosUnsafe: () => nowNanos,
						currentTimeNanos: Effect.sync(() => nowNanos),
						monotonicTimeNanosUnsafe: () => nowNanos,
						monotonicTimeNanos: Effect.sync(() => nowNanos),
						sleep: (duration) =>
							Effect.sync(() => {
								const ms = Duration.toMillis(duration)
								sleepsMs.push(ms)
								nowNanos += BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n
							}),
					}
					return {
						clock,
						sleepsMs,
						advanceMs: (ms: number) => {
							nowNanos += BigInt(ms) * 1_000_000n
						},
					}
				}

				let retryRequests = 0
				const retryFetch = (async () => {
					retryRequests++
					return new Response(
						`retry: 25\n\n${sseSessionFrame(1, "user.message")}${sseSessionFrame(2, "session.archived")}`,
						{
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						},
					)
				}) as unknown as typeof globalThis.fetch
				const retryEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamSessionEvents("sess_retry", {
							maxReconnectAttempts: 2,
							baseReconnectDelayMs: 5,
						}),
					)
				}).pipe(Effect.provide(makeLayer(retryFetch)))
				expect(retryRequests).toBe(1)
				expect(Array.from(retryEvents).map((e) => e.seq)).toEqual([1, 2])

				const retryDropClock = makeVirtualClock()
				let retryDropRequests = 0
				const retryDropLastIds: Array<string | null> = []
				const retryDropFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					retryDropRequests++
					const headers = getRequestHeaders(input, init)
					retryDropLastIds.push(headers.get("last-event-id"))
					if (retryDropRequests === 1) {
						let pullCount = 0
						const body = new ReadableStream<Uint8Array>({
							pull(controller) {
								if (pullCount === 0) {
									pullCount = 1
									controller.enqueue(
										encoder.encode(`retry: 10\n\n${sseSessionFrame(1, "user.message")}`),
									)
								} else {
									controller.error(new Error("simulated disconnect"))
								}
							},
						})
						return new Response(body, {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(sseSessionFrame(2, "session.archived"), {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}
				const retryDropEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamSessionEvents("sess_retry_drop", {
							maxReconnectAttempts: 2,
							baseReconnectDelayMs: 5000,
						}),
					)
				}).pipe(
					Effect.provide(makeLayer(retryDropFetch)),
					Effect.provideService(Clock.Clock, retryDropClock.clock),
				)
				expect(retryDropRequests).toBe(2)
				expect(retryDropLastIds).toEqual([null, "1"])
				expect(retryDropClock.sleepsMs).toEqual([10])
				expect(Array.from(retryDropEvents).map((e) => e.seq)).toEqual([1, 2])

				let splitRequests = 0
				const splitFetch = (async () => {
					splitRequests++
					if (splitRequests <= 3) {
						const body = new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode(": keepalive\r\n\r"))
								controller.enqueue(encoder.encode("\n"))
								controller.close()
							},
						})
						return new Response(body, {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(sseSessionFrame(1, "session.archived", "\r\n").slice(0, -1)),
							)
							controller.enqueue(encoder.encode("\n"))
							controller.close()
						},
					})
					return new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				const splitEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamSessionEvents("sess_split", {
							maxReconnectAttempts: 2,
							baseReconnectDelayMs: 1,
						}),
					)
				}).pipe(Effect.provide(makeLayer(splitFetch)))
				expect(splitRequests).toBe(4)
				expect(Array.from(splitEvents).map((e) => e.seq)).toEqual([1])

				let rotSeq = 0
				const rotFetch = (async () => {
					rotSeq++
					const type = rotSeq === 50 ? "session.archived" : "user.message"
					return new Response(sseSessionFrame(rotSeq, type), {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				const rotEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamSessionEvents("sess_rot", {
							maxReconnectAttempts: 2,
							baseReconnectDelayMs: 1,
						}),
					)
				}).pipe(Effect.provide(makeLayer(rotFetch)))
				expect(rotSeq).toBe(50)
				expect(Array.from(rotEvents).map((e) => e.seq)).toEqual(
					Array.from({ length: 50 }, (_, idx) => idx + 1),
				)

				const sseErrorCases: ReadonlyArray<{
					readonly status: number
					readonly body: string
					readonly expectContains: string
				}> = [
					{
						status: 403,
						body: JSON.stringify({
							type: "error",
							error: { type: "custom_gateway_error", message: "blocked" },
						}),
						expectContains: "HTTP 403",
					},
					{
						status: 400,
						body: JSON.stringify({
							type: "error",
							error: { type: "invalid_request_error", message: "bad" },
							accepted: null,
						}),
						expectContains: "HTTP 400",
					},
					{
						status: 400,
						body: JSON.stringify({
							type: "error",
							error: { type: "toString", message: "proto" },
						}),
						expectContains: "HTTP 400",
					},
					{
						status: 400,
						body: JSON.stringify({
							type: "error",
							error: { type: "invalid_request_error", message: "Cursor invalid" },
							request_id: "req_1",
						}),
						expectContains:
							"API error (400 invalid_request_error): Cursor invalid [request_id: req_1]",
					},
				]
				for (const testCase of sseErrorCases) {
					const errFetch = (async () =>
						new Response(testCase.body, {
							status: testCase.status,
							headers: { "content-type": "application/json" },
						})) as unknown as typeof globalThis.fetch
					const err = yield* Effect.gen(function* () {
						const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
						return yield* Effect.flip(
							Stream.runDrain(
								client.streamSessionEvents("sess_err", {
									maxReconnectAttempts: 0,
									baseReconnectDelayMs: 1,
								}),
							),
						)
					}).pipe(Effect.provide(makeLayer(errFetch)))
					expect(err.message).toContain(testCase.expectContains)
					expect(err.message).not.toContain("undefined")
				}

				let timeout408Requests = 0
				const timeout408LastIds: Array<string | null> = []
				const timeout408Fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					timeout408Requests++
					const headers = getRequestHeaders(input, init)
					timeout408LastIds.push(headers.get("last-event-id"))
					if (timeout408Requests === 1) {
						let step = 0
						const body = new ReadableStream<Uint8Array>({
							pull(controller) {
								if (step === 0) {
									step = 1
									controller.enqueue(encoder.encode(sseSessionFrame(1, "user.message")))
								} else {
									controller.error(new Error("drop after event 1"))
								}
							},
						})
						return new Response(body, {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					if (timeout408Requests === 2) {
						return new Response("Request Timeout", { status: 408 })
					}
					return new Response(sseSessionFrame(2, "session.archived"), {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}
				const timeout408Events = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamSessionEvents("sess_408", {
							maxReconnectAttempts: 2,
							baseReconnectDelayMs: 2,
						}),
					)
				}).pipe(Effect.provide(makeLayer(timeout408Fetch)))
				expect(timeout408Requests).toBe(3)
				expect(timeout408LastIds).toEqual([null, "1", "1"])
				expect(Array.from(timeout408Events).map((e) => e.seq)).toEqual([1, 2])

				let zeroRetryBodyCalls = 0
				const zeroRetryBodyFetch = (async () => {
					zeroRetryBodyCalls++
					let step = 0
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (step === 0) {
								step = 1
								controller.enqueue(encoder.encode(sseSessionFrame(1, "user.message")))
							} else {
								controller.error(new Error("mid-stream failure"))
							}
						},
					})
					return new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_zero_body", {
								maxReconnectAttempts: 0,
								baseReconnectDelayMs: 1,
							}),
						),
					)
				}).pipe(Effect.provide(makeLayer(zeroRetryBodyFetch)))
				expect(zeroRetryBodyCalls).toBe(1)

				let boundedAfterEventCalls = 0
				const boundedAfterEventFetch = (async () => {
					boundedAfterEventCalls++
					if (boundedAfterEventCalls === 1) {
						let step = 0
						const body = new ReadableStream<Uint8Array>({
							pull(controller) {
								if (step === 0) {
									step = 1
									controller.enqueue(encoder.encode(sseSessionFrame(1, "user.message")))
								} else {
									controller.error(new Error("drop after event"))
								}
							},
						})
						return new Response(body, {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response("Unavailable", { status: 503 })
				}) as unknown as typeof globalThis.fetch
				yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_bounded_after", {
								maxReconnectAttempts: 2,
								baseReconnectDelayMs: 1,
							}),
						),
					)
				}).pipe(Effect.provide(makeLayer(boundedAfterEventFetch)))
				expect(boundedAfterEventCalls).toBe(3)

				let openBodyCanceled = false
				const openAfterArchiveFetch = (async () => {
					let sent = false
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (!sent) {
								sent = true
								controller.enqueue(encoder.encode(sseSessionFrame(1, "session.archived")))
								return
							}
							return new Promise<void>(() => {})
						},
						cancel() {
							openBodyCanceled = true
						},
					})
					return new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				const archivedImmediate = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamSessionEvents("sess_open_archive", {
							maxReconnectAttempts: 0,
							baseReconnectDelayMs: 1,
						}),
					)
				}).pipe(Effect.provide(makeLayer(openAfterArchiveFetch)))
				expect(Array.from(archivedImmediate).map((e) => e.seq)).toEqual([1])
				expect(openBodyCanceled).toBe(true)

				const idleClock = makeVirtualClock()
				let idleBackoffCalls = 0
				const idleBackoffFetch = (async () => {
					idleBackoffCalls += 1
					if (idleBackoffCalls === 1) {
						return new Response("retry: 0\n\n: keepalive\n\n", {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					if (idleBackoffCalls <= 7) {
						return new Response(": keepalive\n\n", {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					if (idleBackoffCalls <= 11) {
						let step = 0
						const longIdleBody = new ReadableStream<Uint8Array>({
							pull(controller) {
								if (step === 0) {
									step = 1
									controller.enqueue(encoder.encode(": keepalive\n\n"))
								} else {
									idleClock.advanceMs(10_000)
									controller.close()
								}
							},
						})
						return new Response(longIdleBody, {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					if (idleBackoffCalls <= 14) {
						return new Response("", {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(sseSessionFrame(1, "session.archived"), {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				const idleBackoffEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(client.streamSessionEvents("sess_idle_backoff"))
				}).pipe(
					Effect.provide(makeLayer(idleBackoffFetch)),
					Effect.provideService(Clock.Clock, idleClock.clock),
				)
				expect(idleBackoffCalls).toBe(15)
				expect(Array.from(idleBackoffEvents).map((e) => e.seq)).toEqual([1])
				expect(idleClock.sleepsMs).toEqual([
					250, 500, 1000, 2000, 4000, 5000, 5000, 50, 50, 50, 50, 250, 500, 1000,
				])

				const replayClock = makeVirtualClock()
				const replayCursorLastIds: Array<string | null> = []
				let replayCursorCalls = 0
				const replayCursorFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					replayCursorLastIds.push(req.headers.get("last-event-id"))
					replayCursorCalls += 1
					if (replayCursorCalls === 1) {
						return new Response(sseSessionFrame(5, "user.message"), {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					if (replayCursorCalls === 2) {
						return new Response(sseSessionFrame(2, "user.message"), {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(sseSessionFrame(6, "session.archived"), {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}
				const replayCursorEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(client.streamSessionEvents("sess_monotonic_cursor"))
				}).pipe(
					Effect.provide(makeLayer(replayCursorFetch)),
					Effect.provideService(Clock.Clock, replayClock.clock),
				)
				expect(replayCursorCalls).toBe(3)
				expect(replayCursorLastIds).toEqual([null, "5", "5"])
				expect(replayClock.sleepsMs).toEqual([250])
				expect(Array.from(replayCursorEvents).map((e) => e.seq)).toEqual([5, 6])

				for (const malformedBody of [
					'id: 2\nevent: session.status_idle\ndata: {"seq":2}\n\n',
					'id: 2\nevent: session.status_idle\ndata: {"id":"e2","seq":2,"type":"session.status_idle","created_at":"2026-11-22T00:00:00.000Z"}\n\n',
					'id: 2\nevent: custom.unknown\ndata: {"id":"e2","seq":2,"type":"custom.unknown","created_at":"2026-11-22T00:00:00.000Z"}\n\n',
				]) {
					let malformedCalls = 0
					const malformedFetch = (async () => {
						malformedCalls += 1
						return new Response(`${sseSessionFrame(1, "user.message")}${malformedBody}`, {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}) as unknown as typeof globalThis.fetch
					const malformedErr = yield* Effect.gen(function* () {
						const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
						return yield* Effect.flip(
							Stream.runDrain(
								client.streamSessionEvents("sess_malformed_event", {
									maxReconnectAttempts: 2,
									baseReconnectDelayMs: 1,
								}),
							),
						)
					}).pipe(Effect.provide(makeLayer(malformedFetch)))
					expect(malformedCalls).toBe(1)
					expect(malformedErr.message).toContain("Invalid SSE event payload")
				}

				const idOnlySessionLastIds: Array<string | null> = []
				const idOnlySessionFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					idOnlySessionLastIds.push(req.headers.get("last-event-id"))
					if (idOnlySessionLastIds.length === 1) {
						return new Response(`${sseSessionFrame(1, "user.message")}id: 9\n\n`, {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(sseSessionFrame(2, "session.archived"), {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}
				const idOnlySessionEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamSessionEvents("sess_id_only_ignored", {
							maxReconnectAttempts: 1,
							baseReconnectDelayMs: 1,
						}),
					)
				}).pipe(Effect.provide(makeLayer(idOnlySessionFetch)))
				expect(idOnlySessionLastIds).toEqual([null, "1"])
				expect(Array.from(idOnlySessionEvents).map((e) => e.seq)).toEqual([1, 2])

				const longResetClock = makeVirtualClock()
				let longResetCalls = 0
				const longResetLastIds: Array<string | null> = []
				const longResetFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					longResetLastIds.push(req.headers.get("last-event-id"))
					longResetCalls += 1
					if (longResetCalls === 1) {
						return new Response(sseSessionFrame(1, "user.message"), {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					if (longResetCalls <= 8) {
						let step = 0
						const body = new ReadableStream<Uint8Array>({
							pull(controller) {
								if (step === 0) {
									step = 1
									controller.enqueue(encoder.encode(": keepalive\n\n"))
								} else {
									longResetClock.advanceMs(60_000)
									controller.error(new TypeError("proxy idle reset"))
								}
							},
						})
						return new Response(body, {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(sseSessionFrame(2, "session.archived"), {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}
				const longResetEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(client.streamSessionEvents("sess_long_idle_resets"))
				}).pipe(
					Effect.provide(makeLayer(longResetFetch)),
					Effect.provideService(Clock.Clock, longResetClock.clock),
				)
				expect(longResetCalls).toBe(9)
				expect(longResetLastIds).toEqual([null, "1", "1", "1", "1", "1", "1", "1", "1"])
				expect(longResetClock.sleepsMs).toEqual([250, 250, 250, 250, 250, 250, 250])
				expect(Array.from(longResetEvents).map((e) => e.seq)).toEqual([1, 2])

				const immediateClock = makeVirtualClock()
				let immediateResetCalls = 0
				const immediateResetLastIds: Array<string | null> = []
				const immediateResetFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					immediateResetLastIds.push(req.headers.get("last-event-id"))
					immediateResetCalls += 1
					let step = 0
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (step === 0) {
								step = 1
								controller.enqueue(encoder.encode(": keepalive\n\n"))
							} else {
								controller.error(new TypeError("immediate proxy reset"))
							}
						},
					})
					return new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}
				const immediateResetErr = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(client.streamSessionEvents("sess_immediate_resets", { after: 4 })),
					)
				}).pipe(
					Effect.provide(makeLayer(immediateResetFetch)),
					Effect.provideService(Clock.Clock, immediateClock.clock),
				)
				expect(immediateResetCalls).toBe(6)
				expect(immediateResetLastIds).toEqual([null, "4", "4", "4", "4", "4"])
				expect(immediateClock.sleepsMs).toEqual([250, 500, 1000, 2000, 4000])
				expect(immediateResetErr._tag).toBe("CliFailure")

				let truncatedCalls = 0
				const truncatedFetch = (async () => {
					truncatedCalls += 1
					return new Response('id: 1\nevent: user.message\ndata: {"partial', {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				const truncatedErr = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_truncated", {
								maxReconnectAttempts: 2,
								baseReconnectDelayMs: 1,
							}),
						),
					)
				}).pipe(Effect.provide(makeLayer(truncatedFetch)))
				expect(truncatedCalls).toBe(3)
				expect(truncatedErr.message).toContain("incomplete SSE frame")

				let zeroTruncatedCalls = 0
				const zeroTruncatedFetch = (async () => {
					zeroTruncatedCalls += 1
					return new Response(`${sseSessionFrame(1, "user.message")}id: 2\ndata: {"partial`, {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				const zeroTruncatedErr = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_zero_truncated", {
								maxReconnectAttempts: 0,
								baseReconnectDelayMs: 1,
							}),
						),
					)
				}).pipe(Effect.provide(makeLayer(zeroTruncatedFetch)))
				expect(zeroTruncatedCalls).toBe(1)
				expect(zeroTruncatedErr.message).toContain("incomplete SSE frame")

				const stalledResetClock = makeVirtualClock()
				let stalledResetCalls = 0
				const stalledResetLastIds: Array<string | null> = []
				const stalledResetFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					stalledResetLastIds.push(req.headers.get("last-event-id"))
					stalledResetCalls += 1
					const callNumber = stalledResetCalls
					let step = 0
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (step === 0) {
								step = 1
								controller.enqueue(
									callNumber % 2 === 1 ? new Uint8Array(0) : encoder.encode(": partial"),
								)
							} else {
								stalledResetClock.advanceMs(60_000)
								controller.error(new TypeError("stalled proxy reset"))
							}
						},
					})
					return new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}
				const stalledResetErr = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(client.streamSessionEvents("sess_stalled_resets", { after: 7 })),
					)
				}).pipe(
					Effect.provide(makeLayer(stalledResetFetch)),
					Effect.provideService(Clock.Clock, stalledResetClock.clock),
				)
				expect(stalledResetCalls).toBe(6)
				expect(stalledResetLastIds).toEqual([null, "7", "7", "7", "7", "7"])
				expect(stalledResetClock.sleepsMs).toEqual([250, 500, 1000, 2000, 4000])
				expect(stalledResetErr._tag).toBe("CliFailure")

				let stalled503Canceled = false
				let stalled503Calls = 0
				const stalled503Fetch = (async () => {
					stalled503Calls += 1
					if (stalled503Calls === 1) {
						const stalledBody = new ReadableStream<Uint8Array>({
							pull() {
								return new Promise<void>(() => {})
							},
							cancel() {
								stalled503Canceled = true
							},
						})
						return new Response(stalledBody, {
							status: 503,
							headers: { "content-type": "application/json" },
						})
					}
					return new Response(sseSessionFrame(1, "session.archived"), {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				const stalled503Events = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamSessionEvents("sess_stalled_503", {
							maxReconnectAttempts: 1,
							baseReconnectDelayMs: 2,
						}),
					)
				}).pipe(Effect.provide(makeLayer(stalled503Fetch)))
				expect(stalled503Calls).toBe(2)
				expect(stalled503Canceled).toBe(true)
				expect(Array.from(stalled503Events).map((e) => e.seq)).toEqual([1])

				let hugeErrChunks = 0
				let hugeErrCanceled = false
				const hugeErrFetch = (async () => {
					const chunk64k = encoder.encode("E".repeat(64 * 1024))
					const hugeBody = new ReadableStream<Uint8Array>({
						pull(controller) {
							hugeErrChunks += 1
							controller.enqueue(chunk64k)
						},
						cancel() {
							hugeErrCanceled = true
						},
					})
					return new Response(hugeBody, { status: 400 })
				}) as unknown as typeof globalThis.fetch
				const hugeErr = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_huge_err", {
								maxReconnectAttempts: 0,
								baseReconnectDelayMs: 1,
							}),
						),
					)
				}).pipe(Effect.provide(makeLayer(hugeErrFetch)))
				expect(hugeErr.message).toContain("HTTP 400")
				expect(hugeErrChunks).toBeLessThanOrEqual(2)
				expect(hugeErrCanceled).toBe(true)

				let stalled400Canceled = false
				const stalled400Fetch = (async () => {
					let pulled = false
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (!pulled) {
								pulled = true
								controller.enqueue(encoder.encode("partial diagnostic"))
								return
							}
							return new Promise<void>(() => {})
						},
						cancel() {
							stalled400Canceled = true
						},
					})
					return new Response(body, { status: 400 })
				}) as unknown as typeof globalThis.fetch
				const [stalled400Duration, stalled400Err] = yield* Effect.timed(
					Effect.gen(function* () {
						const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
						return yield* Effect.flip(
							Stream.runDrain(
								client.streamSessionEvents("sess_stalled_400", {
									maxReconnectAttempts: 0,
									baseReconnectDelayMs: 1,
									errorBodyTimeoutMs: 40,
								}),
							),
						)
					}).pipe(Effect.provide(makeLayer(stalled400Fetch))),
				)
				expect(Duration.toMillis(stalled400Duration)).toBeLessThan(1000)
				expect(stalled400Err.message).toContain("HTTP 400")
				expect(stalled400Err.message).toContain("partial diagnostic")
				expect(stalled400Canceled).toBe(true)

				const gateway403Fetch = (async () =>
					new Response(
						JSON.stringify({
							type: "error",
							error: { type: "authentication_error", message: "gateway denied" },
							request_id: "req_gw_403",
						}),
						{ status: 403, headers: { "content-type": "application/json" } },
					)) as unknown as typeof globalThis.fetch
				const gateway403Err = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_gw_403", {
								maxReconnectAttempts: 0,
								baseReconnectDelayMs: 1,
							}),
						),
					)
				}).pipe(Effect.provide(makeLayer(gateway403Fetch)))
				expect(gateway403Err.message).toContain(
					"API error (403 authentication_error): gateway denied [request_id: req_gw_403]",
				)
			}),
		)
	})

	it("resolves default URL without network access and rejects explicitly blank --base-url", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const emptyEnvLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}))
				expect(yield* resolveBaseUrl(Option.none()).pipe(Effect.provide(emptyEnvLayer))).toBe(
					DEFAULT_API_URL,
				)

				const fallbackUrlLayer = ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						CHECKFU_URL: "https://staging.checkfu.com/v1/",
					}),
				)
				expect(yield* resolveBaseUrl(Option.none()).pipe(Effect.provide(fallbackUrlLayer))).toBe(
					"https://staging.checkfu.com",
				)

				const envLayer = ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						CHECKFU_API_URL: "https://api.checkfu.com",
						CHECKFU_URL: "https://staging.checkfu.com",
					}),
				)
				expect(yield* resolveBaseUrl(Option.none()).pipe(Effect.provide(envLayer))).toBe(
					"https://api.checkfu.com",
				)
				for (const blank of ["", "   "]) {
					const err = yield* Effect.flip(
						resolveBaseUrl(Option.some(blank)).pipe(Effect.provide(envLayer)),
					)
					expect(err._tag).toBe("CliFailure")
					expect(err.message).toContain("must not be empty")
				}
			}),
		)
	})
})

describe("TerminalOutput", () => {
	it("escapes ANSI sequences, control chars, C1, line separators, and bidi overrides", () => {
		const dangerous = "hello\u001b]52;c;evil\u0007\r\nworld\u007f\u009b31m\u202e\u2028ok\t!"
		const safe = escapeTerminalControlCharacters(dangerous)
		expect(safe).not.toContain("\u001b")
		expect(safe).not.toContain("\u0007")
		expect(safe).not.toContain("\r")
		expect(safe).not.toContain("\u007f")
		expect(safe).not.toContain("\u009b")
		expect(safe).not.toContain("\u202e")
		expect(safe).not.toContain("\u2028")
		expect(safe).toContain("\\x1b]52;c;evil\\x07\nworld")
		expect(safe).toContain("ok\t!")
	})

	it("keeps JSON round-trip identical while escaping unsafe terminal code points", () => {
		const payload = { text: "hi\u001b[31m\u009b\u202e\u2028there" }
		const json = stringifyTerminalSafeJson(payload)
		expect(json).not.toContain("\u001b")
		expect(json).not.toContain("\u009b")
		expect(json).not.toContain("\u202e")
		expect(json).not.toContain("\u2028")
		expect(JSON.parse(json)).toEqual(payload)
	})
})

describe("Transform and formatOutput", () => {
	const sample = {
		id: "agt_123",
		name: "Helper",
		model: { id: "gpt-6.2-sol" },
		created_at: DateTime.makeUnsafe("2026-11-22T10:00:00.000Z"),
		data: [
			{ type: "user.message", content: [{ type: "text", text: "hi" }] },
			{ type: "agent.message", content: [{ type: "text", text: "hello" }] },
		],
	}

	it("evaluates paths, indices, counts, projections, and object picks", () => {
		expect(evaluateTransform(sample, "id")).toBe("agt_123")
		expect(evaluateTransform(sample, "model.id")).toBe("gpt-6.2-sol")
		expect(evaluateTransform(sample, "data.0.content.0.text")).toBe("hi")
		expect(evaluateTransform(sample, "data.-1.type")).toBe("agent.message")
		expect(evaluateTransform(sample, "data.#")).toBe(2)
		expect(evaluateTransform(sample, "data.#.type")).toEqual(["user.message", "agent.message"])
		expect(evaluateTransform(sample, "{id,model:model.id}")).toEqual({
			id: "agt_123",
			model: "gpt-6.2-sol",
		})
		expect(evaluateTransform(sample, "{id, model.id}")).toEqual({ id: "gpt-6.2-sol" })
		expect(evaluateTransform(sample, "{id,name,missing}")).toStrictEqual({
			id: "agt_123",
			name: "Helper",
			missing: undefined,
		})
		expect(evaluateTransform(sample, ".id")).toBe("agt_123")
		expect(evaluateTransform(sample, " model . id ")).toBe("gpt-6.2-sol")
		expect(evaluateTransform(sample, "data.#.missing")).toEqual([])
		expect(evaluateTransform(sample, "data.5.type")).toBeUndefined()
		expect(evaluateTransform(sample, "id.length")).toBeUndefined()
		for (const unsupported of [
			"{id,name}.{model,id}",
			"{id,name}.id",
			"{id}.{id}",
			'{"label":id}',
			"{'label':id}",
			"{a:{id}}",
			"[id,name]",
			"[id,name].1",
			'"id"',
			String.raw`model\.id`,
			"{id",
			"id}",
		]) {
			expect(evaluateTransform(sample, unsupported)).toBeUndefined()
		}
		expect(evaluateTransform({ "#": 7 }, "#")).toBeUndefined()
		expect(evaluateTransform({ a: { "#": 3 } }, "a.#")).toBeUndefined()
		expect(evaluateTransform({ "#": 7 }, "{n:#}")).toStrictEqual({ n: undefined })
		expect(evaluateTransform(null, "{id}")).toBeUndefined()
		expect(evaluateTransform(undefined, "{id,name}")).toBeUndefined()
		for (const [format, expected] of [
			["json", "null"],
			["raw", ""],
		] as const) {
			expect(
				formatOutput(null, {
					format,
					transform: Option.some("{id}"),
					rawOutput: false,
					isTerminal: false,
				}),
			).toBe(expected)
		}
		expect(evaluateTransform(sample, "missing.path")).toBeUndefined()
		expect(evaluateTransform(sample, "constructor")).toBeUndefined()
		expect(evaluateTransform(sample, "toString")).toBeUndefined()
		expect(evaluateTransform(sample, "hasOwnProperty")).toBeUndefined()
		expect(
			formatOutput(sample, {
				format: "yaml",
				transform: Option.some("constructor"),
				rawOutput: false,
				isTerminal: false,
			}),
		).toBe("null")

		expect(
			formatOutput(sample, {
				format: "json",
				transform: Option.some("{__proto__:id}"),
				rawOutput: false,
				isTerminal: false,
			}),
		).toBe('{"__proto__":"agt_123"}')
		expect(
			formatOutput(sample, {
				format: "yaml",
				transform: Option.some("{__proto__:id}"),
				rawOutput: false,
				isTerminal: false,
			}),
		).toBe("__proto__: agt_123")
		expect(
			formatOutput(JSON.parse('{"__proto__":"kept","a":1}'), {
				format: "json",
				transform: Option.none(),
				rawOutput: false,
				isTerminal: false,
			}),
		).toBe('{"__proto__":"kept","a":1}')
	})

	it("keeps the old evaluator's results for paths and picks, including empty segments", () => {
		const cases: ReadonlyArray<readonly [unknown, string, unknown]> = [
			[{ data: ["a", "b"] }, "data.#", 2],
			[{ data: ["a", "b"] }, "data.#.", ["a", "b"]],
			[{ data: ["a", null, "b"] }, "data.#.", ["a", "b"]],
			[{ data: [{ id: 1 }, {}, { id: 3 }] }, "data.#.id", [1, 3]],
			[{ data: [] }, "data.#", 0],
			[{ data: [] }, "data.#.id", []],
			[{ "#": 7 }, "#", undefined],
			[{ a: { "#": 3 } }, "a.#", undefined],
			[[1, 2, 3], "#", 3],
			[[[1], [2, 3]], "#.#", [1, 2]],
			[[1, 2, 3], "-1", 3],
			[[1, 2, 3], "3", undefined],
			[[1, 2, 3], "x", undefined],
			[{ "0": "zero" }, "0", "zero"],
			[{ id: 1 }, ".id", 1],
			[{ a: { b: 2 } }, "a..b", 2],
			[{ a: { b: 2 } }, " a . b ", 2],
			[{ a: { b: 2 } }, "a.b.", 2],
			[{ id: null }, "id", null],
			[{ id: null }, "id.x", undefined],
			["abc", "length", undefined],
			[{ id: 1 }, "constructor", undefined],
			[{ id: 1 }, "__proto__", undefined],
			[null, "", null],
			[null, "id", undefined],
			[42, "", 42],
			[{ id: 1 }, "", { id: 1 }],
			[{ id: 1, name: "n", v: 2 }, "{id,name}", { id: 1, name: "n" }],
			[{ id: 1 }, "{ id , missing }", { id: 1, missing: undefined }],
			[{ a: { b: 2 } }, "{a.b}", { b: 2 }],
			[{ a: { b: 2 } }, "{x:a.b,y:a}", { x: 2, y: { b: 2 } }],
			[{ id: 1 }, "{id.}", { "": 1 }],
			[{ id: 1 }, "{:id}", { "": 1 }],
			[{ id: 1 }, "{k:}", { k: { id: 1 } }],
			[{ id: 1 }, "{}", {}],
			[{ id: 1 }, "{,id,}", { id: 1 }],
			[{ id: 1 }, "{a:b:c}", { a: undefined }],
			[{ id: 1 }, "{@this:id}", { "@this": 1 }],
			[[1, 2], "{n:#,first:0}", { n: 2, first: 1 }],
			[{ "#": 7 }, "{n:#}", { n: undefined }],
			[[{ id: 1 }, {}], "{ids:#.id,missing:#.x.y}", { ids: [1], missing: [] }],
			[null, "{id}", undefined],
			[undefined, "{id}", undefined],
			["abc", "{id}", { id: undefined }],
		]
		for (const [value, expression, expected] of cases) {
			expect([expression, evaluateTransform(value, expression)]).toStrictEqual([
				expression,
				expected,
			])
		}
	})

	it("walks a path of any length without growing the stack", () => {
		expect(evaluateTransform({ id: 1 }, `${".".repeat(20_000)}id`)).toBe(1)
		expect(evaluateTransform({ a: [{ b: 1 }, { b: 2 }] }, `a.#${".".repeat(20_000)}b`)).toEqual([
			1, 2,
		])
	})

	it("evaluates @this to nothing wherever it appears as a path segment", () => {
		for (const expression of [
			"@this",
			"@this.id",
			"data.#.@this",
			"data.@this.0",
			"{id,x:@this}",
			"{@this}",
		]) {
			expect(
				evaluateTransform({ "@this": 7, id: 1, data: [{ "@this": 1 }] }, expression),
			).toBeUndefined()
		}
	})

	it("formats auto, json, pretty, yaml, raw, and DateTime.Utc cleanly", () => {
		expect(
			formatOutput(sample, {
				format: "auto",
				transform: Option.some("id"),
				rawOutput: true,
				isTerminal: false,
			}),
		).toBe("agt_123")

		expect(
			formatOutput(sample, {
				format: "json",
				transform: Option.some("created_at"),
				rawOutput: false,
				isTerminal: false,
			}),
		).toBe('"2026-11-22T10:00:00.000Z"')

		const yamlOut = formatOutput(sample, {
			format: "yaml",
			transform: Option.some("{id,model:model.id}"),
			rawOutput: false,
			isTerminal: false,
		})
		expect(yamlOut).toContain("id: agt_123")
		expect(yamlOut).toContain("model: gpt-6.2-sol")

		const prettyOut = formatOutput(
			{ a: 1 },
			{
				format: "auto",
				transform: Option.none(),
				rawOutput: false,
				isTerminal: true,
			},
		)
		expect(prettyOut).toBe('{\n  "a": 1\n}')

		const streamOut = formatOutput(
			{ a: 1 },
			{
				format: "auto",
				transform: Option.none(),
				rawOutput: false,
				isTerminal: true,
				streaming: true,
			},
		)
		expect(streamOut).toBe('{"a":1}')
	})

	it("preserves trailing newlines and leading BOMs in YAML scalars and separates streamed YAML documents", () => {
		for (const scalar of [
			"hello\n\n",
			"\n\n",
			"trailing   ",
			{ text: "body\n\n" },
			"\uFEFFbar",
			"\uFEFF",
			{ "\uFEFFkey": "\uFEFFval" },
		]) {
			const rendered = formatOutput(scalar, {
				format: "yaml",
				transform: Option.none(),
				rawOutput: false,
				isTerminal: false,
			})
			expect(YAML.parse(`${rendered}\n`)).toEqual(scalar)
		}
		expect(
			formatOutput("\uFEFFbar", {
				format: "yaml",
				transform: Option.none(),
				rawOutput: false,
				isTerminal: false,
			}).startsWith('"'),
		).toBe(true)

		const events = [
			{ id: "evt_1", seq: 1, type: "user.message", text: "first\n\n" },
			{ id: "evt_2", seq: 2, type: "agent.message", text: "second\n\n" },
		]
		const combined = events
			.map(
				(event) =>
					`${formatOutput(event, {
						format: "yaml",
						transform: Option.none(),
						rawOutput: false,
						isTerminal: false,
						streaming: true,
					})}\n`,
			)
			.join("")
		const docs = YAML.parseAllDocuments(combined)
		expect(docs).toHaveLength(2)
		for (const doc of docs) {
			expect(doc.errors).toEqual([])
		}
		expect(docs.map((doc) => doc.toJS() as (typeof events)[number])).toEqual(events)
	})

	it("honors the selected output format for non-string values with --raw-output and round-trips terminal-safe YAML", () => {
		const streamedEvents = [
			{ id: "evt_1", type: "user.message" },
			{ id: "evt_2", type: "agent.message" },
		]
		const yamlRawStream = streamedEvents
			.map(
				(event) =>
					`${formatOutput(event, {
						format: "yaml",
						transform: Option.none(),
						rawOutput: true,
						isTerminal: false,
						streaming: true,
					})}\n`,
			)
			.join("")
		expect(yamlRawStream).toContain("---\n")
		const parsedStreamDocs = YAML.parseAllDocuments(yamlRawStream)
		expect(parsedStreamDocs).toHaveLength(2)
		expect(parsedStreamDocs.map((doc) => doc.toJS() as (typeof streamedEvents)[number])).toEqual(
			streamedEvents,
		)

		expect(
			formatOutput(sample, {
				format: "yaml",
				transform: Option.some("id"),
				rawOutput: true,
				isTerminal: false,
			}),
		).toBe("agt_123")

		expect(
			formatOutput(
				{ a: 1 },
				{
					format: "pretty",
					transform: Option.none(),
					rawOutput: true,
					isTerminal: false,
				},
			),
		).toBe('{\n  "a": 1\n}')

		const tricky = {
			name: "evil\u202ename",
			controls: "hi\u001b[31m\u0007\u009b\u2028\u2029\u2066there",
			backslashAdjacent: "foo\\\u202ebar",
			crlf: "a\r\nb",
			["key\u202ename"]: "val\u200f",
		}
		const ttyYaml = formatOutput(tricky, {
			format: "yaml",
			transform: Option.none(),
			rawOutput: false,
			isTerminal: true,
		})
		expect(hasUnsafeTerminalCodePoint(ttyYaml)).toBe(false)
		for (const forbidden of [
			"\u202e",
			"\u001b",
			"\u0007",
			"\u009b",
			"\u2028",
			"\u2029",
			"\u2066",
			"\u200f",
			"\r",
		]) {
			expect(ttyYaml).not.toContain(forbidden)
		}
		expect(YAML.parse(`${ttyYaml}\n`)).toEqual(tricky)
	})

	it("normalizes output once before evaluating transform paths without recopying payloads per selected field", () => {
		const listResponse = {
			has_more: true,
			next_cursor: 42,
			data: [
				{ id: "evt_1", type: "user.message", content: [{ type: "text", text: "one" }] },
				{ id: "evt_2", type: "agent.message", content: [{ type: "text", text: "two" }] },
				{ id: "evt_3", type: "session.status_idle", stop_reason: { type: "end_turn" } },
			],
		}
		const expectedObjectCount = 7
		const countEntriesCalls = <A>(fn: () => A): readonly [A, number] => {
			let calls = 0
			const originalEntries = Object.entries
			Object.entries = ((...args: Parameters<typeof Object.entries>) => {
				calls += 1
				return originalEntries(...args)
			}) as typeof Object.entries
			try {
				return [fn(), calls] as const
			} finally {
				Object.entries = originalEntries
			}
		}

		const [formatted, formatCalls] = countEntriesCalls(() =>
			formatOutput(listResponse, {
				format: "json",
				transform: Option.some("{has_more,next_cursor}"),
				rawOutput: false,
				isTerminal: false,
			}),
		)
		expect(formatted).toBe('{"has_more":true,"next_cursor":42}')
		expect(formatCalls).toBe(expectedObjectCount)

		const [evaluatedObj, evalObjCalls] = countEntriesCalls(() =>
			evaluateTransform(listResponse, "{has_more,next_cursor}"),
		)
		expect(evaluatedObj).toEqual({ has_more: true, next_cursor: 42 })
		expect(evalObjCalls).toBe(expectedObjectCount)

		const [projected, projCalls] = countEntriesCalls(() =>
			evaluateTransform(listResponse, "data.#.id"),
		)
		expect(projected).toEqual(["evt_1", "evt_2", "evt_3"])
		expect(projCalls).toBe(expectedObjectCount)

		const duplicated = evaluateTransform(listResponse, "{a:data,b:data}") as {
			readonly a: unknown
			readonly b: unknown
		}
		expect(duplicated.a).toBe(duplicated.b)
	})
})
