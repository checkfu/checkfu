import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { resolveBunExecutable } from "../bin/resolve-bun.mjs"
import { createLauncherSigintBridge } from "../bin/sigint-bridge.mjs"
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

				// 1) Server retry: directive updates reconnect delay without disconnecting the live stream
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

				// 1b) Advertised retry: delay overrides baseReconnectDelayMs only when a disconnect occurs
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

				// 2) Keepalive and event frames with \r\n\r + \n split across chunk boundaries decode cleanly
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

				// 3) Iterative reconnection over 50 consecutive rotations delivers all events cleanly in order
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

				// 4) Non-200 SSE responses decode ApiErrorEnvelopes and fall back to HTTP status
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

				// 5) HTTP 408 / 503 on SSE open/reconnect are retried and resume with Last-Event-ID
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

				// 6) First reconnect after an event still honors maxReconnectAttempts
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

				// 7) Terminal event (session.archived) finishes immediately and cancels an open body
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
							return new Promise<void>(() => {
								// intentionally never resolves — simulates server keeping connection open
							})
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

				// 8) Short no-progress closes apply capped exponential backoff (even under `retry: 0`),
				//    while long-lived idle connections reset the streak to prompt 50ms reconnects
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

				// 9) Monotonic numeric session cursor never regresses Last-Event-ID on partial older replay,
				//    deduplicates replayed frames, and backs off when no cursor progress occurs
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

				// 10) Malformed SessionEvent frames fail immediately without retrying, and data-less
				//     id-only frames do not advance Last-Event-ID
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

				// 11) Long-lived idle connections reset retry budget across proxy resets, while
				//     immediate body-read resets remain strictly bounded by maxReconnectAttempts
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

				// 12) Truncated SSE frames at EOF count against maxReconnectAttempts (including 0)
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

				// 13) Stalled 60s connections without events or completed keepalives do NOT reset retries
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

				// 14) Bounded error-body handling: transient 503 cancels stalled body immediately,
				//     huge/stalled non-retried 400 bounds diagnostic read, and gateway 403 preserves status
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
		expect(evaluateTransform(sample, "{id,name,missing}")).toEqual({
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
		expect(evaluateTransform({ "#": 7 }, "{n:#}")).toEqual({ n: undefined })
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

		// Reserved property names like __proto__ are preserved as own properties in transforms & normalization
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
		// --format yaml -r on streaming objects preserves YAML document separators instead of emitting JSONL
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

		// --format yaml -r on a string still outputs the raw unquoted string
		expect(
			formatOutput(sample, {
				format: "yaml",
				transform: Option.some("id"),
				rawOutput: true,
				isTerminal: false,
			}),
		).toBe("agt_123")

		// --format pretty -r on an object preserves pretty JSON formatting
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

		// Terminal-safe YAML uses YAML double-quoted escapes so values & keys remain both safe and lossless
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
		// 7 objects total: root + 3 events + 2 text content blocks + 1 stop_reason
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

		// Multiple references to the same branch reuse the single normalized value without recopying
		const duplicated = evaluateTransform(listResponse, "{a:data,b:data}") as {
			readonly a: unknown
			readonly b: unknown
		}
		expect(duplicated.a).toBe(duplicated.b)
	})
})

describe("resolveBunExecutable", () => {
	it("resolves only explicitly trusted Bun paths on Windows while excluding nested checkouts, ..-prefixed dirs, node_modules, and arbitrary PATH entries", () => {
		const winCheckouts = new Set([
			String.raw`c:\untrusted\repo\.git`,
			String.raw`c:\untrusted\repo\package.json`,
			String.raw`c:\untrusted\repo\packages\app\package.json`,
		])
		const winExecutables = new Set([
			String.raw`c:\untrusted\repo\bun.exe`,
			String.raw`c:\untrusted\repo\sub\bun.exe`,
			String.raw`c:\untrusted\repo\node_modules\.bin\bun.exe`,
			String.raw`c:\untrusted\repo\..sneaky\bun.exe`,
			String.raw`c:\untrusted\repo\packages\app\bun.exe`,
			String.raw`c:\untrusted\repo\packages\app\..evil\bun.exe`,
			String.raw`c:\random\attacker\bun.exe`,
			String.raw`c:\bin\bun.exe`,
			String.raw`c:\program files\bun\bin\bun.exe`,
		])
		const isWinExec = (candidate: string) => winExecutables.has(candidate.toLowerCase())
		const winExists = (target: string) => winCheckouts.has(target.toLowerCase())

		// Invoked from a nested workspace subdirectory (`C:\untrusted\repo\packages\app`):
		// excludes bare cwd, relative, empty, drive-relative (\bin, C:bin), enclosing checkout root,
		// top-level <checkout>\node_modules\.bin, `..`-prefixed descendant dirs (`..evil`, `..sneaky`),
		// and arbitrary untrusted absolute PATH dirs (`C:\random\attacker`) before selecting the
		// explicitly trusted quoted `"C:\Program Files\Bun\bin"` entry.
		const resolved = resolveBunExecutable({
			platform: "win32",
			cwd: String.raw`C:\untrusted\repo\packages\app`,
			homedir: String.raw`C:\Users\alice`,
			env: {
				Path: [
					"",
					".",
					".\\",
					"./sub",
					String.raw`node_modules\.bin`,
					String.raw`\bin`,
					"C:sub",
					String.raw`C:\untrusted\repo`,
					"c:\\UNTRUSTED\\REPO\\",
					String.raw`C:\untrusted\repo\..\repo`,
					String.raw`C:\untrusted\repo\node_modules\.bin`,
					String.raw`C:\untrusted\repo\..sneaky`,
					String.raw`C:\untrusted\repo\packages\app\..evil`,
					String.raw`c:\UNTRUSTED\REPO\sub`,
					String.raw`C:\random\attacker`,
					String.raw`"C:\Program Files\Bun\bin"`,
				].join(";"),
			},
			isExecutableFile: isWinExec,
			realpath: (target) => target,
			pathExists: winExists,
		})
		expect(resolved).toBe(String.raw`C:\Program Files\Bun\bin\bun.exe`)

		// Running from %USERPROFILE% excludes %USERPROFILE%\bun.exe, %USERPROFILE%\..evil\bun.exe,
		// and %USERPROFILE%\node_modules\.bin\bun.exe while resolving %USERPROFILE%\.bun\bin\bun.exe
		const homeExecutables = new Set([
			String.raw`c:\users\alice\bun.exe`,
			String.raw`c:\users\alice\..evil\bun.exe`,
			String.raw`c:\users\alice\node_modules\.bin\bun.exe`,
			String.raw`c:\users\alice\.bun\bin\bun.exe`,
		])
		expect(
			resolveBunExecutable({
				platform: "win32",
				cwd: String.raw`C:\Users\alice`,
				homedir: String.raw`C:\Users\alice`,
				env: {
					Path: [
						String.raw`C:\Users\alice`,
						String.raw`C:\Users\alice\..evil`,
						String.raw`C:\Users\alice\node_modules\.bin`,
						".",
					].join(";"),
				},
				isExecutableFile: (candidate) => homeExecutables.has(candidate.toLowerCase()),
				realpath: (target) => target,
				pathExists: () => false,
			}),
		).toBe(String.raw`C:\Users\alice\.bun\bin\bun.exe`)

		// BUN_INSTALL / CHECKFU_BUN_PATH reject checkout-local, ..-prefixed, and node_modules paths,
		// while accepting a sibling directory outside the checkout (C:\untrusted\repo-other) and cross-drive paths
		const installExecutables = new Set([
			String.raw`c:\untrusted\repo\bun.exe`,
			String.raw`c:\untrusted\repo\bin\bun.exe`,
			String.raw`c:\untrusted\repo\.bun\bin\bun.exe`,
			String.raw`c:\untrusted\repo\..sneaky\bin\bun.exe`,
			String.raw`c:\untrusted\repo\packages\app\..evil\bun.exe`,
			String.raw`c:\untrusted\repo-other\bin\bun.exe`,
			String.raw`d:\trusted-bun\bun.exe`,
		])
		for (const untrustedBunInstall of [
			String.raw`C:\untrusted\repo`,
			String.raw`C:\untrusted\repo\.bun`,
			String.raw`C:\untrusted\repo\..sneaky`,
		]) {
			expect(
				resolveBunExecutable({
					platform: "win32",
					cwd: String.raw`C:\untrusted\repo\packages\app`,
					homedir: String.raw`C:\Users\alice`,
					env: {
						PATH: String.raw`.;C:\untrusted\repo;C:\untrusted\repo\node_modules\.bin`,
						BUN_INSTALL: untrustedBunInstall,
					},
					isExecutableFile: (candidate) => installExecutables.has(candidate.toLowerCase()),
					realpath: (target) => target,
					pathExists: winExists,
				}),
			).toBeNull()
		}
		expect(
			resolveBunExecutable({
				platform: "win32",
				cwd: String.raw`C:\untrusted\repo\packages\app`,
				homedir: String.raw`C:\Users\alice`,
				env: {
					PATH: String.raw`.;C:\untrusted\repo`,
					BUN_INSTALL: String.raw`C:\untrusted\repo-other`,
				},
				isExecutableFile: (candidate) => installExecutables.has(candidate.toLowerCase()),
				realpath: (target) => target,
				pathExists: winExists,
			}),
		).toBe(String.raw`C:\untrusted\repo-other\bin\bun.exe`)

		// Explicit CHECKFU_BUN_PATH fails closed for checkout-local ..evil paths and succeeds for cross-drive paths
		expect(
			resolveBunExecutable({
				platform: "win32",
				cwd: String.raw`C:\untrusted\repo\packages\app`,
				homedir: String.raw`C:\Users\alice`,
				env: {
					PATH: String.raw`"C:\Program Files\Bun\bin"`,
					CHECKFU_BUN_PATH: String.raw`C:\untrusted\repo\packages\app\..evil\bun.exe`,
				},
				isExecutableFile: (candidate) =>
					installExecutables.has(candidate.toLowerCase()) || isWinExec(candidate),
				realpath: (target) => target,
				pathExists: winExists,
			}),
		).toBeNull()
		expect(
			resolveBunExecutable({
				platform: "win32",
				cwd: String.raw`C:\untrusted\repo\packages\app`,
				homedir: String.raw`C:\Users\alice`,
				env: {
					PATH: "",
					CHECKFU_BUN_PATH: String.raw`D:\trusted-bun\bun.exe`,
				},
				isExecutableFile: (candidate) => installExecutables.has(candidate.toLowerCase()),
				realpath: (target) => target,
				pathExists: winExists,
			}),
		).toBe(String.raw`D:\trusted-bun\bun.exe`)
	})

	it("resolves only explicitly trusted Bun paths on POSIX while excluding enclosing checkouts, ..-prefixed dirs, arbitrary PATH entries, and escaping symlinks", () => {
		const posixCheckouts = new Set([
			"/var/folders/untrusted/.git",
			"/private/var/folders/untrusted/.git",
			"/var/folders/untrusted/package.json",
			"/private/var/folders/untrusted/package.json",
			"/var/folders/untrusted/packages/app/package.json",
			"/private/var/folders/untrusted/packages/app/package.json",
		])
		const posixExecutables = new Set([
			"/private/var/folders/untrusted/bun",
			"/var/folders/untrusted/bun",
			"/var/folders/untrusted/node_modules/.bin/bun",
			"/private/var/folders/untrusted/node_modules/.bin/bun",
			"/var/folders/untrusted/..sneaky/bun",
			"/var/folders/untrusted/packages/app/..evil/bun",
			"/tmp/random-untrusted/bin/bun",
			"/usr/local/bin/bun",
			"/opt/homebrew/bin/bun",
		])
		const posixRealpaths = new Map<string, string>([
			["/var/folders/untrusted", "/private/var/folders/untrusted"],
			["/private/var/folders/untrusted", "/private/var/folders/untrusted"],
			["/var/folders/untrusted/packages/app", "/private/var/folders/untrusted/packages/app"],
			[
				"/var/folders/untrusted/node_modules/.bin",
				"/private/var/folders/untrusted/node_modules/.bin",
			],
			["/var/folders/untrusted/..sneaky", "/private/var/folders/untrusted/..sneaky"],
			[
				"/var/folders/untrusted/packages/app/..evil",
				"/private/var/folders/untrusted/packages/app/..evil",
			],
			["/usr/local/bin", "/usr/local/bin"],
			// Symlink inside a trusted bin dir that escapes into a `..`-prefixed checkout directory
			["/usr/local/bin/bun", "/private/var/folders/untrusted/..sneaky/bun"],
			["/opt/homebrew/bin", "/opt/homebrew/bin"],
			["/opt/homebrew/bin/bun", "/opt/homebrew/Cellar/bun/1.4.2/bin/bun"],
		])
		const resolved = resolveBunExecutable({
			platform: "darwin",
			cwd: "/var/folders/untrusted/packages/app",
			homedir: "/Users/alice",
			env: {
				PATH: [
					"",
					"/private/var/folders/untrusted",
					"/var/folders/untrusted/node_modules/.bin",
					"/private/var/folders/untrusted/node_modules/.bin",
					"/var/folders/untrusted/..sneaky",
					"/var/folders/untrusted/packages/app/..evil",
					"/tmp/random-untrusted/bin",
					".",
					"./bin",
					"/usr/local/bin",
					"/opt/homebrew/bin",
					"",
				].join(":"),
			},
			isExecutableFile: (candidate) => posixExecutables.has(candidate),
			realpath: (target) => posixRealpaths.get(target) ?? target,
			pathExists: (target) => posixCheckouts.has(target),
		})
		expect(resolved).toBe("/opt/homebrew/bin/bun")

		// An arbitrary absolute PATH directory (/opt/custom/bin) is NOT trusted on its own;
		// it requires an explicit BUN_INSTALL or CHECKFU_BUN_PATH outside the checkout
		expect(
			resolveBunExecutable({
				platform: "linux",
				cwd: "/tmp/untrusted/packages/app",
				homedir: "/home/alice",
				env: { PATH: "/opt/custom/bin" },
				isExecutableFile: (candidate) => candidate === "/opt/custom/bin/bun",
				realpath: (target) => target,
				pathExists: (target) => target === "/tmp/untrusted/.git",
			}),
		).toBeNull()
		expect(
			resolveBunExecutable({
				platform: "linux",
				cwd: "/tmp/untrusted/packages/app",
				homedir: "/home/alice",
				env: { PATH: "/opt/custom/bin", BUN_INSTALL: "/opt/custom" },
				isExecutableFile: (candidate) => candidate === "/opt/custom/bin/bun",
				realpath: (target) => target,
				pathExists: (target) => target === "/tmp/untrusted/.git",
			}),
		).toBe("/opt/custom/bin/bun")

		// Running from $HOME excludes $HOME/..evil, $HOME/node_modules/.bin, and symlinks escaping
		// ~/.bun into $HOME, while resolving legitimate ~/.bun/bin/bun
		const homeExecutables = new Set([
			"/Users/alice/..evil/bun",
			"/Users/alice/node_modules/.bin/bun",
			"/Users/alice/.bun/bin/bun",
		])
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/Users/alice",
				homedir: "/Users/alice",
				env: { PATH: "/Users/alice/..evil:/Users/alice/node_modules/.bin:/Users/alice/.bun/bin" },
				isExecutableFile: (candidate) => homeExecutables.has(candidate),
				realpath: (target) =>
					target === "/Users/alice/.bun/bin/bun" ? "/Users/alice/evil/bun" : target,
				pathExists: () => false,
			}),
		).toBeNull()
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/Users/alice",
				homedir: "/Users/alice",
				env: { PATH: "/Users/alice/..evil:/Users/alice/node_modules/.bin:/Users/alice/.bun/bin" },
				isExecutableFile: (candidate) => homeExecutables.has(candidate),
				realpath: (target) => target,
				pathExists: () => false,
			}),
		).toBe("/Users/alice/.bun/bin/bun")

		// Running from / allows explicitly trusted Homebrew installation symlinked into /opt/homebrew/Cellar
		// while still rejecting arbitrary directories like /tmp/random
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/",
				homedir: "/Users/alice",
				env: { PATH: "/tmp/random:/opt/homebrew/bin" },
				isExecutableFile: (candidate) =>
					candidate === "/tmp/random/bun" || candidate === "/opt/homebrew/bin/bun",
				realpath: (target) =>
					target === "/opt/homebrew/bin/bun" ? "/opt/homebrew/Cellar/bun/1.4.2/bin/bun" : target,
				pathExists: () => false,
			}),
		).toBe("/opt/homebrew/bin/bun")

		// Fails closed with null when only checkout-local/relative candidates exist or CHECKFU_BUN_PATH is checkout-local
		expect(
			resolveBunExecutable({
				platform: "linux",
				cwd: "/tmp/untrusted/packages/app",
				homedir: "/home/alice",
				env: {
					PATH: ".:./bin:/tmp/untrusted:/tmp/untrusted/node_modules/.bin:/tmp/untrusted/..sneaky",
					BUN_INSTALL: "/tmp/untrusted/.bun",
				},
				isExecutableFile: (candidate) =>
					candidate === "/tmp/untrusted/bun" ||
					candidate === "/tmp/untrusted/node_modules/.bin/bun" ||
					candidate === "/tmp/untrusted/..sneaky/bun" ||
					candidate === "/tmp/untrusted/.bun/bin/bun",
				realpath: (target) => target,
				pathExists: (target) => target === "/tmp/untrusted/.git",
			}),
		).toBeNull()
		expect(
			resolveBunExecutable({
				platform: "linux",
				cwd: "/tmp/untrusted/packages/app",
				homedir: "/home/alice",
				env: {
					PATH: "/opt/homebrew/bin",
					CHECKFU_BUN_PATH: "/tmp/untrusted/..sneaky/bun",
				},
				isExecutableFile: (candidate) =>
					candidate === "/tmp/untrusted/..sneaky/bun" || candidate === "/opt/homebrew/bin/bun",
				realpath: (target) => target,
				pathExists: (target) => target === "/tmp/untrusted/.git",
			}),
		).toBeNull()
	})

	it("excludes project-sensitive version-manager shims and non-binary scripts while allowing concrete installations and home/root overrides", () => {
		// 1) Project-sensitive shim directories (~/.asdf/shims, ~/.local/share/mise/shims,
		//    ~/.proto/shims, ~/.volta/bin) are skipped even when first on PATH, in favor of
		//    concrete Bun installations
		const shimAndConcrete = new Set([
			"/Users/alice/.asdf/shims/bun",
			"/Users/alice/.local/share/mise/shims/bun",
			"/Users/alice/.proto/shims/bun",
			"/Users/alice/.volta/bin/bun",
			"/Users/alice/.bun/bin/bun",
		])
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/tmp/untrusted-repo",
				homedir: "/Users/alice",
				env: {
					PATH: [
						"/Users/alice/.asdf/shims",
						"/Users/alice/.local/share/mise/shims",
						"/Users/alice/.proto/shims",
						"/Users/alice/.volta/bin",
						"/Users/alice/.bun/bin",
					].join(":"),
				},
				isExecutableFile: (candidate) => shimAndConcrete.has(candidate),
				realpath: (target) => target,
				pathExists: (target) => target === "/tmp/untrusted-repo/.git",
			}),
		).toBe("/Users/alice/.bun/bin/bun")

		// Concrete version-manager install bin directories directly on PATH ARE accepted
		expect(
			resolveBunExecutable({
				platform: "linux",
				cwd: "/tmp/untrusted-repo",
				homedir: "/home/alice",
				env: {
					PATH: "/home/alice/.asdf/shims:/home/alice/.asdf/installs/bun/1.4.2/bin",
				},
				isExecutableFile: (candidate) =>
					candidate === "/home/alice/.asdf/shims/bun" ||
					candidate === "/home/alice/.asdf/installs/bun/1.4.2/bin/bun",
				realpath: (target) => target,
				pathExists: (target) => target === "/tmp/untrusted-repo/.git",
			}),
		).toBe("/home/alice/.asdf/installs/bun/1.4.2/bin/bun")

		// CHECKFU_BUN_PATH pointing to an asdf/mise/proto/volta shim fails closed
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/tmp/untrusted-repo",
				homedir: "/Users/alice",
				env: {
					PATH: "/Users/alice/.bun/bin",
					CHECKFU_BUN_PATH: "/Users/alice/.asdf/shims/bun",
				},
				isExecutableFile: (candidate) => shimAndConcrete.has(candidate),
				realpath: (target) => target,
				pathExists: (target) => target === "/tmp/untrusted-repo/.git",
			}),
		).toBeNull()

		// 2) Real-filesystem binary header check rejects executable `#!/bin/sh` wrapper scripts
		//    even inside an explicit BUN_INSTALL or CHECKFU_BUN_PATH outside the checkout
		const tempRoot = mkdtempSync(join(tmpdir(), "checkfu-shim-header-"))
		try {
			const fakeInstallBin = join(tempRoot, "install", "bin")
			const workDir = join(tempRoot, "work")
			mkdirSync(fakeInstallBin, { recursive: true })
			mkdirSync(workDir, { recursive: true })
			const scriptBun = join(fakeInstallBin, process.platform === "win32" ? "bun.exe" : "bun")
			writeFileSync(scriptBun, "#!/bin/sh\necho SHIM_EXECUTED >&2\nexit 91\n")
			if (process.platform !== "win32") {
				chmodSync(scriptBun, 0o755)
			}
			expect(
				resolveBunExecutable({
					cwd: workDir,
					homedir: join(tempRoot, "empty-home"),
					env: {
						PATH: fakeInstallBin,
						CHECKFU_BUN_PATH: scriptBun,
					},
				}),
			).toBeNull()
		} finally {
			rmSync(tempRoot, { recursive: true, force: true })
		}

		// 3) Broad-ancestor exception ($HOME and / / C:\) applies to CHECKFU_BUN_PATH and BUN_INSTALL
		//    while still enforcing exact-cwd, node_modules, and checkout exclusions
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/Users/alice",
				homedir: "/Users/alice",
				env: { CHECKFU_BUN_PATH: "/Users/alice/.bun/bin/bun" },
				isExecutableFile: (candidate) => candidate === "/Users/alice/.bun/bin/bun",
				realpath: (target) => target,
				pathExists: () => false,
			}),
		).toBe("/Users/alice/.bun/bin/bun")
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/",
				homedir: "/Users/alice",
				env: { CHECKFU_BUN_PATH: "/opt/homebrew/bin/bun" },
				isExecutableFile: (candidate) => candidate === "/opt/homebrew/bin/bun",
				realpath: (target) => target,
				pathExists: () => false,
			}),
		).toBe("/opt/homebrew/bin/bun")
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/",
				homedir: "/Users/alice",
				env: { PATH: "", BUN_INSTALL: "/opt/custom" },
				isExecutableFile: (candidate) => candidate === "/opt/custom/bin/bun",
				realpath: (target) => target,
				pathExists: () => false,
			}),
		).toBe("/opt/custom/bin/bun")
		expect(
			resolveBunExecutable({
				platform: "win32",
				cwd: "C:\\",
				homedir: String.raw`C:\Users\alice`,
				env: { CHECKFU_BUN_PATH: String.raw`C:\Program Files\Bun\bin\bun.exe` },
				isExecutableFile: (candidate) =>
					candidate.toLowerCase() === String.raw`c:\program files\bun\bin\bun.exe`,
				realpath: (target) => target,
				pathExists: () => false,
			}),
		).toBe(String.raw`C:\Program Files\Bun\bin\bun.exe`)

		// Exact cwd and node_modules remain rejected even from $HOME or /
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/Users/alice",
				homedir: "/Users/alice",
				env: { CHECKFU_BUN_PATH: "/Users/alice/bun" },
				isExecutableFile: (candidate) => candidate === "/Users/alice/bun",
				realpath: (target) => target,
				pathExists: () => false,
			}),
		).toBeNull()
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/",
				homedir: "/Users/alice",
				env: { CHECKFU_BUN_PATH: "/tmp/proj/node_modules/.bin/bun" },
				isExecutableFile: (candidate) => candidate === "/tmp/proj/node_modules/.bin/bun",
				realpath: (target) => target,
				pathExists: () => false,
			}),
		).toBeNull()
	})
})

describe("createLauncherSigintBridge", () => {
	it("retains non-TTY startup SIGINT for IPC delivery on readiness when the child survives the OS signal", () => {
		let ipcSigints = 0
		let osSigints = 0
		const connected = true
		const bridge = createLauncherSigintBridge({
			hasTerminal: false,
			isChildAlive: () => true,
			isConnected: () => connected,
			sendIpcSigint: () => {
				ipcSigints += 1
				return true
			},
			forwardOsSigint: () => {
				osSigints += 1
			},
		})

		// Non-TTY SIGINT arrives after main.ts installed onOsSigint (ignoring OS SIGINT)
		// but before the launcher processes checkfu:sigint-ready:
		// OS SIGINT is forwarded (in case Bun hasn't installed onOsSigint yet) AND the
		// interrupt is queued so it delivers via IPC once readiness arrives.
		bridge.onSigint()
		expect(osSigints).toBe(1)
		expect(ipcSigints).toBe(0)

		bridge.onReady()
		expect(ipcSigints).toBe(1)
		expect(osSigints).toBe(1)

		// Subsequent non-TTY SIGINTs in steady state go solely over IPC (no duplicate OS SIGINT)
		bridge.onSigint()
		expect(ipcSigints).toBe(2)
		expect(osSigints).toBe(1)
	})

	it("queues TTY startup SIGINT without double-forwarding and falls back to OS SIGINT after disconnect", () => {
		let ipcSigints = 0
		let osSigints = 0
		let connected = true
		const ttyBridge = createLauncherSigintBridge({
			hasTerminal: true,
			isChildAlive: () => true,
			isConnected: () => connected,
			sendIpcSigint: () => {
				ipcSigints += 1
				return true
			},
			forwardOsSigint: () => {
				osSigints += 1
			},
		})

		// 1st TTY SIGINT before ready queues for IPC without forwarding OS SIGINT
		ttyBridge.onSigint()
		expect(osSigints).toBe(0)
		expect(ipcSigints).toBe(0)
		ttyBridge.onReady()
		expect(ipcSigints).toBe(1)
		expect(osSigints).toBe(0)

		// After disconnect, SIGINT falls back to forwarding OS SIGINT
		connected = false
		ttyBridge.onDisconnect()
		ttyBridge.onSigint()
		expect(osSigints).toBe(1)
		expect(ipcSigints).toBe(1)

		// 2nd TTY SIGINT while still stuck pre-ready forwards OS SIGINT
		let stuckOsSigints = 0
		const stuckTtyBridge = createLauncherSigintBridge({
			hasTerminal: true,
			isChildAlive: () => true,
			isConnected: () => true,
			sendIpcSigint: () => true,
			forwardOsSigint: () => {
				stuckOsSigints += 1
			},
		})
		stuckTtyBridge.onSigint()
		expect(stuckOsSigints).toBe(0)
		stuckTtyBridge.onSigint()
		expect(stuckOsSigints).toBe(1)
	})
})
