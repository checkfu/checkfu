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

const getRequestUrl = (input: RequestInfo | URL): string =>
	typeof input === "string" ? input : "href" in input ? input.href : input.url

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

	it("backs off and fails after bounded retries when an SSE stream repeatedly closes mid-frame", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				let requests = 0
				const fakeFetch = (async () => {
					requests++
					return new Response('id: 1\nevent: user.message\ndata: {"partial', {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch

				const layer = Layer.mergeAll(
					FetchHttpClient.layer.pipe(
						Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
					),
					SecureRandom.layerWebCrypto,
					ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_API_KEY: "ck_test" })),
				)

				const err = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_test", {
								maxReconnectAttempts: 2,
								baseReconnectDelayMs: 5,
							}),
						),
					)
				}).pipe(Effect.provide(layer))

				expect(requests).toBe(3)
				expect(err.message).toContain("incomplete SSE frame")
			}),
		)
	})

	it("handles SSE retry directives without disconnecting, preserves split CRLF keepalives, and rotates iteratively", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
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

				// 1) Server advertises retry: at start of connection and delivers events on the same response
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

				const makeLayer = (fetchFn: typeof globalThis.fetch) =>
					Layer.mergeAll(
						FetchHttpClient.layer.pipe(
							Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
						),
						SecureRandom.layerWebCrypto,
						ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_API_KEY: "ck_test" })),
					)

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

				// 1b) Advertised retry: delay overrides baseReconnectDelayMs when a connection drops
				let retryDropRequests = 0
				const retryDropLastIds: Array<string | null> = []
				const encoder = new TextEncoder()
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

				const [retryDropDuration, retryDropEvents] = yield* Effect.timed(
					Effect.gen(function* () {
						const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
						return yield* Stream.runCollect(
							client.streamSessionEvents("sess_retry_drop", {
								maxReconnectAttempts: 2,
								baseReconnectDelayMs: 5000,
							}),
						)
					}).pipe(Effect.provide(makeLayer(retryDropFetch))),
				)
				const retryDropElapsedMs = Duration.toMillis(retryDropDuration)

				expect(retryDropRequests).toBe(2)
				expect(retryDropLastIds).toEqual([null, "1"])
				expect(Array.from(retryDropEvents).map((e) => e.seq)).toEqual([1, 2])
				expect(retryDropElapsedMs).toBeLessThan(1500)

				// 2) Keepalive and event frames with \r\n\r + \n split across chunk boundaries are treated as complete
				let splitRequests = 0
				const splitFetch = (async () => {
					splitRequests++
					if (splitRequests <= 8) {
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
							baseReconnectDelayMs: 2,
						}),
					)
				}).pipe(Effect.provide(makeLayer(splitFetch)))

				expect(splitRequests).toBe(9)
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

				// 4) SSE non-200 error envelopes validate known types & fields and fall back to HTTP status
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
						expectContains: "API error (400 invalid_request_error): Cursor invalid",
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

				// 5) HTTP 408 on SSE open/reconnect is retried and resumes from cursor
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

				// 6) First reconnect after sawEvent counts toward maxReconnectAttempts (body error & incomplete frame)
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

				let zeroRetryFrameCalls = 0
				const zeroRetryFrameFetch = (async () => {
					zeroRetryFrameCalls++
					return new Response(`${sseSessionFrame(1, "user.message")}id: 2\ndata: {"partial`, {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				const zeroFrameErr = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_zero_frame", {
								maxReconnectAttempts: 0,
								baseReconnectDelayMs: 1,
							}),
						),
					)
				}).pipe(Effect.provide(makeLayer(zeroRetryFrameFetch)))
				expect(zeroRetryFrameCalls).toBe(1)
				expect(zeroFrameErr.message).toContain("incomplete SSE frame")

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

				// 7) streamEndpointEvents dispatches to arbitrary declared GET SSE paths with query & headers
				const seenCustomRequests: Array<{
					readonly url: string
					readonly trace: string | null
					readonly lastEventId: string | null
				}> = []
				const customSseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = getRequestUrl(input)
					const headers = getRequestHeaders(input, init)
					seenCustomRequests.push({
						url,
						trace: headers.get("x-trace"),
						lastEventId: headers.get("last-event-id"),
					})
					if (seenCustomRequests.length === 1) {
						return new Response('id: cur_7\nevent: custom.ping\ndata: {"seq":7,"ok":true}\n\n', {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					if (seenCustomRequests.length === 2) {
						return new Response('id: 007\nevent: custom.ping\ndata: {"seq":7,"ok":true}\n\n', {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(null, { status: 204 })
				}
				const customEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamEndpointEvents(
							{
								method: "GET",
								path: "/v1/custom/abc/stream",
								query: { filter: "live", after: "0" },
								headers: { "x-trace": "t1" },
								initialCursor: "0",
								cursorQueryParam: "after",
							},
							{ maxReconnectAttempts: 1, baseReconnectDelayMs: 1 },
						),
					)
				}).pipe(Effect.provide(makeLayer(customSseFetch)))
				expect(seenCustomRequests).toEqual([
					{
						url: "http://localhost:1337/v1/custom/abc/stream?filter=live&after=0",
						trace: "t1",
						lastEventId: null,
					},
					{
						url: "http://localhost:1337/v1/custom/abc/stream?filter=live",
						trace: "t1",
						lastEventId: "cur_7",
					},
					{
						url: "http://localhost:1337/v1/custom/abc/stream?filter=live",
						trace: "t1",
						lastEventId: "007",
					},
				])
				expect(Array.from(customEvents).map((e) => ({ id: e.id, seq: e.seq }))).toEqual([
					{ id: "cur_7", seq: 7 },
					{ id: "007", seq: 7 },
				])

				// 8) Terminal event (session.archived) finishes the stream immediately even if the HTTP
				//    body remains open or contains trailing frames in the same chunk
				let openBodyCanceled = false
				const openAfterArchiveFetch = (async () => {
					let sent = false
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (!sent) {
								sent = true
								controller.enqueue(
									encoder.encode(
										`${sseSessionFrame(1, "session.archived")}id: 2\nevent: bogus\ndata: NOT_JSON\n\n`,
									),
								)
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

				// 9) Explicitly empty SSE id: clears the reconnect cursor instead of keeping prior id or JSON seq
				const resetLastIds: Array<string | null> = []
				const resetIdFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const headers = getRequestHeaders(input, init)
					resetLastIds.push(headers.get("last-event-id"))
					if (resetLastIds.length === 1) {
						return new Response(
							'id: cur_1\nevent: custom.ping\ndata: {"seq":1}\n\nid:\nevent: custom.ping\ndata: {"seq":2}\n\n',
							{
								status: 200,
								headers: { "content-type": "text/event-stream; charset=utf-8" },
							},
						)
					}
					return new Response(null, { status: 204 })
				}
				const resetEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamEndpointEvents(
							{
								method: "GET",
								path: "/v1/custom/reset/stream",
								query: { after: "0" },
								initialCursor: "0",
								cursorQueryParam: "after",
							},
							{ maxReconnectAttempts: 1, baseReconnectDelayMs: 1 },
						),
					)
				}).pipe(Effect.provide(makeLayer(resetIdFetch)))
				expect(Array.from(resetEvents).map((e) => e.seq)).toEqual([1, 2])
				expect(resetLastIds).toEqual([null, null])

				// 10) ID-only SSE frames advance and clear the reconnect cursor without emitting data events
				const idOnlyLastIds: Array<string | null> = []
				const idOnlyFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const headers = getRequestHeaders(input, init)
					idOnlyLastIds.push(headers.get("last-event-id"))
					if (idOnlyLastIds.length === 1) {
						return new Response('id: cur_1\nevent: custom.ping\ndata: {"seq":1}\n\nid: cur_2\n\n', {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					if (idOnlyLastIds.length === 2) {
						return new Response("id:\n\n", {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(null, { status: 204 })
				}
				const idOnlyEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamEndpointEvents(
							{
								method: "GET",
								path: "/v1/custom/id-only/stream",
								query: { after: "0" },
								initialCursor: "0",
								cursorQueryParam: "after",
							},
							{ maxReconnectAttempts: 1, baseReconnectDelayMs: 1 },
						),
					)
				}).pipe(Effect.provide(makeLayer(idOnlyFetch)))
				expect(Array.from(idOnlyEvents).map((e) => e.seq)).toEqual([1])
				expect(idOnlyLastIds).toEqual([null, "cur_2", null])

				// 11) Transient 503 with a stalled body cancels the body and retries immediately;
				//     final non-retried error reads only a bounded diagnostic
				let stalled503Canceled = false
				let stalled503Calls = 0
				const stalled503Fetch = (async () => {
					stalled503Calls++
					if (stalled503Calls === 1) {
						const stalledBody = new ReadableStream<Uint8Array>({
							pull() {
								return new Promise<void>(() => {
									// intentionally stalls forever — retry must not await EOF
								})
							},
							cancel() {
								stalled503Canceled = true
							},
						})
						return new Response(stalledBody, { status: 503 })
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
							hugeErrChunks++
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

				// 12) Repeated same-ID or unnumbered SSE closes back off instead of tight-looping,
				//     and unnumbered mid-stream errors do not reset the retry budget
				let repeatIdCalls = 0
				const repeatIdFetch = (async () => {
					repeatIdCalls++
					if (repeatIdCalls <= 3) {
						return new Response('id: same_1\nevent: custom.ping\ndata: {"ok":true}\n\n', {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(null, { status: 204 })
				}) as unknown as typeof globalThis.fetch
				const [repeatDuration] = yield* Effect.timed(
					Effect.gen(function* () {
						const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
						return yield* Stream.runCollect(
							client.streamEndpointEvents(
								{ method: "GET", path: "/v1/custom/repeat/stream" },
								{ maxReconnectAttempts: 1, baseReconnectDelayMs: 30 },
							),
						)
					}).pipe(Effect.provide(makeLayer(repeatIdFetch))),
				)
				expect(repeatIdCalls).toBe(4)
				// Connection 1 advances undefined->same_1 (0ms), connection 2 repeats (30ms), connection 3 repeats (60ms)
				expect(Duration.toMillis(repeatDuration)).toBeGreaterThanOrEqual(75)

				let unnumberedErrCalls = 0
				const unnumberedErrFetch = (async () => {
					unnumberedErrCalls++
					let step = 0
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (step === 0) {
								step = 1
								controller.enqueue(encoder.encode('event: custom.ping\ndata: {"ok":true}\n\n'))
							} else {
								controller.error(new Error("unnumbered drop"))
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
							client.streamEndpointEvents(
								{ method: "GET", path: "/v1/custom/unnumbered/stream" },
								{ maxReconnectAttempts: 1, baseReconnectDelayMs: 2 },
							),
						),
					)
				}).pipe(Effect.provide(makeLayer(unnumberedErrFetch)))
				expect(unnumberedErrCalls).toBe(2)

				// 13) Replayed ID batch ending at the starting cursor (1, 2 starting from cursor 2)
				//     counts as no progress at disconnect: clean closes back off and body errors keep
				//     consuming the retry budget
				let replayBatchCloseCalls = 0
				const replayBatchCloseFetch = (async () => {
					replayBatchCloseCalls++
					if (replayBatchCloseCalls <= 2) {
						return new Response(
							'id: 1\nevent: custom.ping\ndata: {"seq":1}\n\nid: 2\nevent: custom.ping\ndata: {"seq":2}\n\n',
							{
								status: 200,
								headers: { "content-type": "text/event-stream; charset=utf-8" },
							},
						)
					}
					return new Response(null, { status: 204 })
				}) as unknown as typeof globalThis.fetch
				const [replayBatchDuration] = yield* Effect.timed(
					Effect.gen(function* () {
						const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
						return yield* Stream.runCollect(
							client.streamEndpointEvents(
								{
									method: "GET",
									path: "/v1/custom/replay-batch/stream",
									initialCursor: "2",
								},
								{ maxReconnectAttempts: 1, baseReconnectDelayMs: 30 },
							),
						)
					}).pipe(Effect.provide(makeLayer(replayBatchCloseFetch))),
				)
				expect(replayBatchCloseCalls).toBe(3)
				// Connection 1 ends at cursor 2 (30ms backoff), connection 2 ends at cursor 2 (60ms backoff)
				expect(Duration.toMillis(replayBatchDuration)).toBeGreaterThanOrEqual(75)

				let replayBatchErrCalls = 0
				const replayBatchErrFetch = (async () => {
					replayBatchErrCalls++
					let step = 0
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (step === 0) {
								step = 1
								controller.enqueue(
									encoder.encode(
										'id: 1\nevent: custom.ping\ndata: {"seq":1}\n\nid: 2\nevent: custom.ping\ndata: {"seq":2}\n\n',
									),
								)
							} else {
								controller.error(new Error("replay batch drop"))
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
							client.streamEndpointEvents(
								{
									method: "GET",
									path: "/v1/custom/replay-batch-err/stream",
									initialCursor: "2",
								},
								{ maxReconnectAttempts: 1, baseReconnectDelayMs: 2 },
							),
						),
					)
				}).pipe(Effect.provide(makeLayer(replayBatchErrFetch)))
				expect(replayBatchErrCalls).toBe(2)

				// 14) Rejected body.cancel() during retryable 503 or truncated 400 cleanup does not
				//     die or bypass SSE retries / error status reporting
				let cancelReject503Calls = 0
				const cancelReject503Fetch = (async () => {
					cancelReject503Calls++
					if (cancelReject503Calls === 1) {
						const body = new ReadableStream<Uint8Array>({
							pull() {
								return new Promise(() => {})
							},
							cancel() {
								return Promise.reject(new Error("stream already errored"))
							},
						})
						return new Response(body, { status: 503 })
					}
					return new Response(sseSessionFrame(1, "session.archived"), {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch
				const cancelReject503Events = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamSessionEvents("sess_cancel_reject_503", {
							maxReconnectAttempts: 1,
							baseReconnectDelayMs: 2,
						}),
					)
				}).pipe(Effect.provide(makeLayer(cancelReject503Fetch)))
				expect(cancelReject503Calls).toBe(2)
				expect(Array.from(cancelReject503Events).map((e) => e.seq)).toEqual([1])

				const cancelReject400Fetch = (async () => {
					const chunk64k = encoder.encode("X".repeat(64 * 1024))
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.enqueue(chunk64k)
						},
						cancel() {
							return Promise.reject(new Error("cancel hook rejected"))
						},
					})
					return new Response(body, { status: 400 })
				}) as unknown as typeof globalThis.fetch
				const cancelReject400Err = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_cancel_reject_400", {
								maxReconnectAttempts: 0,
								baseReconnectDelayMs: 1,
							}),
						),
					)
				}).pipe(Effect.provide(makeLayer(cancelReject400Fetch)))
				expect(cancelReject400Err.message).toContain("HTTP 400")

				// 15) Stalled non-retried SSE error body hits the diagnostic deadline, cancels the
				//     response body, and reports the HTTP status with any received prefix
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
							return new Promise(() => {})
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

				// 16) Server `retry: 0` cannot bypass no-progress backoff or empty-close minimum delay
				let retryZeroRepeatCalls = 0
				const retryZeroRepeatFetch = (async () => {
					retryZeroRepeatCalls++
					if (retryZeroRepeatCalls <= 3) {
						return new Response(
							'retry: 0\n\nid: same_0\nevent: custom.ping\ndata: {"ok":true}\n\n',
							{
								status: 200,
								headers: { "content-type": "text/event-stream; charset=utf-8" },
							},
						)
					}
					return new Response(null, { status: 204 })
				}) as unknown as typeof globalThis.fetch
				const [retryZeroRepeatDuration] = yield* Effect.timed(
					Effect.gen(function* () {
						const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
						return yield* Stream.runCollect(
							client.streamEndpointEvents(
								{ method: "GET", path: "/v1/custom/retry-zero-repeat/stream" },
								{ maxReconnectAttempts: 1, baseReconnectDelayMs: 30 },
							),
						)
					}).pipe(Effect.provide(makeLayer(retryZeroRepeatFetch))),
				)
				expect(retryZeroRepeatCalls).toBe(4)
				// Conn 1 advances undefined->same_0 (0ms), conn 2 repeats (30ms), conn 3 repeats (60ms)
				expect(Duration.toMillis(retryZeroRepeatDuration)).toBeGreaterThanOrEqual(75)

				let retryZeroEmptyCalls = 0
				const retryZeroEmptyFetch = (async () => {
					retryZeroEmptyCalls++
					if (retryZeroEmptyCalls === 1) {
						return new Response("retry: 0\n\n", {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					if (retryZeroEmptyCalls === 2) {
						return new Response("", {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(null, { status: 204 })
				}) as unknown as typeof globalThis.fetch
				const [retryZeroEmptyDuration] = yield* Effect.timed(
					Effect.gen(function* () {
						const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
						return yield* Stream.runCollect(
							client.streamEndpointEvents(
								{ method: "GET", path: "/v1/custom/retry-zero-empty/stream" },
								{ maxReconnectAttempts: 1, baseReconnectDelayMs: 30 },
							),
						)
					}).pipe(Effect.provide(makeLayer(retryZeroEmptyFetch))),
				)
				expect(retryZeroEmptyCalls).toBe(3)
				// Conn 1 & 2 both close without advancing cursor -> at least 2 * 30ms floor
				expect(Duration.toMillis(retryZeroEmptyDuration)).toBeGreaterThanOrEqual(45)

				// 17) SSE API error envelopes preserve the observed HTTP status (e.g. 403 gateway
				//     response with an authentication_error body reports 403, not inferred 401)
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
					"API error (403 authentication_error): gateway denied",
				)

				// 18) Consecutive short heartbeat-only and empty SSE closes apply capped exponential
				//     backoff (even under `retry: 0`), while normal long-lived idle connections reset
				//     the streak and preserve prompt 50ms reconnection.
				let virtualNowNanos = 1_000_000_000n
				const recordedSleepsMs: Array<number> = []
				const recordingClock: Clock.Clock = {
					currentTimeMillisUnsafe: () => Number(virtualNowNanos / 1_000_000n),
					currentTimeMillis: Effect.sync(() => Number(virtualNowNanos / 1_000_000n)),
					currentTimeNanosUnsafe: () => virtualNowNanos,
					currentTimeNanos: Effect.sync(() => virtualNowNanos),
					monotonicTimeNanosUnsafe: () => virtualNowNanos,
					monotonicTimeNanos: Effect.sync(() => virtualNowNanos),
					sleep: (duration) =>
						Effect.sync(() => {
							const ms = Duration.toMillis(duration)
							recordedSleepsMs.push(ms)
							virtualNowNanos += BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n
						}),
				}
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
						// Normal long-lived idle keepalive connection (10s open before clean close)
						let step = 0
						const longIdleBody = new ReadableStream<Uint8Array>({
							pull(controller) {
								if (step === 0) {
									step = 1
									controller.enqueue(encoder.encode(": keepalive\n\n"))
								} else {
									virtualNowNanos += 10_000_000_000n
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
						// Short empty HTTP 200 closes back off again from base delay
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
					Effect.provideService(Clock.Clock, recordingClock),
				)
				expect(idleBackoffCalls).toBe(15)
				expect(Array.from(idleBackoffEvents).map((e) => e.seq)).toEqual([1])
				expect(recordedSleepsMs).toEqual([
					// 7 short keepalive closes (even after retry: 0): exponential backoff capped at 5000ms
					250, 500, 1000, 2000, 4000, 5000, 5000,
					// 4 long-lived (10s) idle keepalive closes: streak resets, prompt 50ms reconnects
					50, 50, 50, 50,
					// 3 short empty closes: exponential backoff starts fresh from 250ms
					250, 500, 1000,
				])

				// Real-clock sanity check: short keepalive closes back off using live monotonic time
				let shortLiveKeepaliveCalls = 0
				const shortLiveKeepaliveFetch = (async () => {
					shortLiveKeepaliveCalls += 1
					if (shortLiveKeepaliveCalls <= 3) {
						return new Response("retry: 0\n\n: keepalive\n\n", {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(null, { status: 204 })
				}) as unknown as typeof globalThis.fetch
				const [shortLiveDuration] = yield* Effect.timed(
					Effect.gen(function* () {
						const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
						return yield* Stream.runCollect(
							client.streamEndpointEvents(
								{ method: "GET", path: "/v1/custom/short-keepalive/stream" },
								{
									maxReconnectAttempts: 1,
									baseReconnectDelayMs: 25,
									healthyIdleDurationMs: 500,
								},
							),
						)
					}).pipe(Effect.provide(makeLayer(shortLiveKeepaliveFetch))),
				)
				expect(shortLiveKeepaliveCalls).toBe(4)
				// 3 short keepalives: 25 + 50 + 100 = 175ms
				expect(Duration.toMillis(shortLiveDuration)).toBeGreaterThanOrEqual(140)

				// 19) Generic SSE streams with opaque non-numeric IDs emit every frame across reconnects
				let opaqueCalls = 0
				const opaqueFetch = (async () => {
					opaqueCalls += 1
					if (opaqueCalls === 1) {
						return new Response(
							'id: tok_alpha\nevent: custom.msg\ndata: {"seq":5,"msg":"first"}\n\n',
							{
								status: 200,
								headers: { "content-type": "text/event-stream; charset=utf-8" },
							},
						)
					}
					if (opaqueCalls === 2) {
						return new Response(
							'id: tok_beta\nevent: custom.msg\ndata: {"seq":5,"msg":"second-same-seq-opaque-id"}\n\n',
							{
								status: 200,
								headers: { "content-type": "text/event-stream; charset=utf-8" },
							},
						)
					}
					return new Response(null, { status: 204 })
				}) as unknown as typeof globalThis.fetch
				const opaqueEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamEndpointEvents(
							{ method: "GET", path: "/v1/custom/opaque/stream" },
							{ maxReconnectAttempts: 1, baseReconnectDelayMs: 1 },
						),
					)
				}).pipe(Effect.provide(makeLayer(opaqueFetch)))
				expect(opaqueCalls).toBe(3)
				expect(Array.from(opaqueEvents).map((e) => ({ id: e.id, msg: e.data["msg"] }))).toEqual([
					{ id: "tok_alpha", msg: "first" },
					{ id: "tok_beta", msg: "second-same-seq-opaque-id" },
				])

				// 20) Monotonic numeric session streams never regress Last-Event-ID on partial older replay
				//     and treat older-only replays as no-progress (applying backoff)
				let replayCursorNanos = 1_000_000_000n
				const replayCursorSleeps: Array<number> = []
				const replayCursorClock: Clock.Clock = {
					currentTimeMillisUnsafe: () => Number(replayCursorNanos / 1_000_000n),
					currentTimeMillis: Effect.sync(() => Number(replayCursorNanos / 1_000_000n)),
					currentTimeNanosUnsafe: () => replayCursorNanos,
					currentTimeNanos: Effect.sync(() => replayCursorNanos),
					monotonicTimeNanosUnsafe: () => replayCursorNanos,
					monotonicTimeNanos: Effect.sync(() => replayCursorNanos),
					sleep: (duration) =>
						Effect.sync(() => {
							const ms = Duration.toMillis(duration)
							replayCursorSleeps.push(ms)
							replayCursorNanos += BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n
						}),
				}
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
						// Proxy partially replays an older frame (seq 2) and disconnects
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
					Effect.provideService(Clock.Clock, replayCursorClock),
				)
				expect(replayCursorCalls).toBe(3)
				// Cursor stays at "5" after replaying older seq 2 (never regresses to "2")
				expect(replayCursorLastIds).toEqual([null, "5", "5"])
				// Conn 1 advanced (0ms); conn 2 replayed older seq 2 (no progress -> 250ms backoff)
				expect(replayCursorSleeps).toEqual([250])
				expect(Array.from(replayCursorEvents).map((e) => e.seq)).toEqual([5, 2, 6])

				// 21) Session streams validate frames against SessionEvent before advancing the cursor
				//     and ignore data-less id-only cursor updates, while generic SSE endpoints stay schema-free
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
					expect(malformedErr.message).toContain("Invalid SSE session event payload")
				}

				// Data-less `id: 9\n\n` frames on a session stream must not advance Last-Event-ID past seq 1
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

				// Generic SSE endpoint remains independent of SessionEvent (accepts arbitrary JSON `{ seq: 2 }`)
				let genericSchemaFreeCalls = 0
				const genericSchemaFreeFetch = (async () => {
					genericSchemaFreeCalls += 1
					if (genericSchemaFreeCalls === 1) {
						return new Response('id: 2\nevent: custom.ping\ndata: {"seq":2}\n\n', {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					return new Response(null, { status: 204 })
				}) as unknown as typeof globalThis.fetch
				const genericSchemaFreeEvents = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Stream.runCollect(
						client.streamEndpointEvents(
							{ method: "GET", path: "/v1/custom/arbitrary-json/stream" },
							{ maxReconnectAttempts: 1, baseReconnectDelayMs: 1 },
						),
					)
				}).pipe(Effect.provide(makeLayer(genericSchemaFreeFetch)))
				expect(Array.from(genericSchemaFreeEvents).map((e) => e.data)).toEqual([{ seq: 2 }])

				// 22) Healthy long-lived idle connections that end with a body-read reset or incomplete
				//     frame reset the retry budget (surviving >=6 periodic proxy resets while preserving
				//     the Last-Event-ID resume cursor), while immediate failures stay strictly bounded
				let resetNowNanos = 1_000_000_000n
				const resetSleepsMs: Array<number> = []
				const resetClock: Clock.Clock = {
					currentTimeMillisUnsafe: () => Number(resetNowNanos / 1_000_000n),
					currentTimeMillis: Effect.sync(() => Number(resetNowNanos / 1_000_000n)),
					currentTimeNanosUnsafe: () => resetNowNanos,
					currentTimeNanos: Effect.sync(() => resetNowNanos),
					monotonicTimeNanosUnsafe: () => resetNowNanos,
					monotonicTimeNanos: Effect.sync(() => resetNowNanos),
					sleep: (duration) =>
						Effect.sync(() => {
							const ms = Duration.toMillis(duration)
							resetSleepsMs.push(ms)
							resetNowNanos += BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n
						}),
				}
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
									// Connection stayed healthy for 60s before proxy reset or truncated frame
									resetNowNanos += 60_000_000_000n
									if (longResetCalls % 2 === 0) {
										controller.error(new TypeError("proxy idle reset"))
									} else {
										controller.enqueue(encoder.encode('data: {"partial'))
										controller.close()
									}
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
					Effect.provideService(Clock.Clock, resetClock),
				)
				expect(longResetCalls).toBe(9)
				expect(longResetLastIds).toEqual([null, "1", "1", "1", "1", "1", "1", "1", "1"])
				// Conn 1 advanced cursor (0ms); conns 2..8 each stayed open 60s before reset (250ms each)
				expect(resetSleepsMs).toEqual([250, 250, 250, 250, 250, 250, 250])
				expect(Array.from(longResetEvents).map((e) => e.seq)).toEqual([1, 2])

				// Immediate body-read resets still fail after maxReconnectAttempts (default 5 -> 6 calls)
				let immediateResetCalls = 0
				const immediateResetLastIds: Array<string | null> = []
				const immediateResetSleepsMs: Array<number> = []
				const immediateResetClock: Clock.Clock = {
					currentTimeMillisUnsafe: () => Number(resetNowNanos / 1_000_000n),
					currentTimeMillis: Effect.sync(() => Number(resetNowNanos / 1_000_000n)),
					currentTimeNanosUnsafe: () => resetNowNanos,
					currentTimeNanos: Effect.sync(() => resetNowNanos),
					monotonicTimeNanosUnsafe: () => resetNowNanos,
					monotonicTimeNanos: Effect.sync(() => resetNowNanos),
					sleep: (duration) =>
						Effect.sync(() => {
							const ms = Duration.toMillis(duration)
							immediateResetSleepsMs.push(ms)
							resetNowNanos += BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n
						}),
				}
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
					Effect.provideService(Clock.Clock, immediateResetClock),
				)
				expect(immediateResetCalls).toBe(6)
				expect(immediateResetLastIds).toEqual([null, "4", "4", "4", "4", "4"])
				expect(immediateResetSleepsMs).toEqual([250, 500, 1000, 2000, 4000])
				expect(immediateResetErr._tag).toBe("CliFailure")

				// Stalled 60s connections that deliver neither events nor completed keepalives (empty
				// chunks or unterminated `: partial` comments) must NOT reset the retry budget:
				// elapsed time alone is not evidence of a healthy stream
				let stalledResetCalls = 0
				const stalledResetLastIds: Array<string | null> = []
				const stalledResetSleepsMs: Array<number> = []
				const stalledResetClock: Clock.Clock = {
					currentTimeMillisUnsafe: () => Number(resetNowNanos / 1_000_000n),
					currentTimeMillis: Effect.sync(() => Number(resetNowNanos / 1_000_000n)),
					currentTimeNanosUnsafe: () => resetNowNanos,
					currentTimeNanos: Effect.sync(() => resetNowNanos),
					monotonicTimeNanosUnsafe: () => resetNowNanos,
					monotonicTimeNanos: Effect.sync(() => resetNowNanos),
					sleep: (duration) =>
						Effect.sync(() => {
							const ms = Duration.toMillis(duration)
							stalledResetSleepsMs.push(ms)
							resetNowNanos += BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n
						}),
				}
				const stalledResetFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const req = toWebRequest(input, init)
					stalledResetLastIds.push(req.headers.get("last-event-id"))
					stalledResetCalls += 1
					if (stalledResetCalls > 10) {
						return new Response(sseSessionFrame(8, "session.archived"), {
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						})
					}
					const callNumber = stalledResetCalls
					let step = 0
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (step === 0) {
								step = 1
								// Alternate silent stalls and unterminated comments (neither is a completed keepalive)
								controller.enqueue(
									callNumber % 2 === 1 ? new Uint8Array(0) : encoder.encode(": partial"),
								)
							} else {
								resetNowNanos += 60_000_000_000n
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
					Effect.provideService(Clock.Clock, stalledResetClock),
				)
				expect(stalledResetCalls).toBe(6)
				expect(stalledResetLastIds).toEqual([null, "7", "7", "7", "7", "7"])
				expect(stalledResetSleepsMs).toEqual([250, 500, 1000, 2000, 4000])
				expect(stalledResetErr._tag).toBe("CliFailure")
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

	it("evaluates GJSON-style paths, indices, counts, projections, and object/array literals", () => {
		expect(evaluateTransform(sample, "id")).toBe("agt_123")
		expect(evaluateTransform(sample, "model.id")).toBe("gpt-6.2-sol")
		expect(evaluateTransform(sample, "data.0.content.0.text")).toBe("hi")
		expect(evaluateTransform(sample, "data.-1.type")).toBe("agent.message")
		expect(evaluateTransform(sample, "data.#")).toBe(2)
		expect(evaluateTransform(sample, "data.#.type")).toEqual(["user.message", "agent.message"])
		expect(evaluateTransform(sample, '{"#":id}."#"')).toBe("agt_123")
		expect(evaluateTransform(sample, "{\"#\":id}.'#'")).toBe("agt_123")
		expect(evaluateTransform(sample, String.raw`{"#":id}.\#`)).toBe("agt_123")
		expect(evaluateTransform(sample, '{"#":data}."#".#')).toBe(2)
		expect(evaluateTransform(sample, '{"@this":id}."@this"')).toBe("agt_123")
		expect(
			formatOutput(sample, {
				format: "json",
				transform: Option.some('{"#":id}."#"'),
				rawOutput: false,
				isTerminal: false,
			}),
		).toBe('"agt_123"')
		expect(evaluateTransform(sample, "{id,model:model.id}")).toEqual({
			id: "agt_123",
			model: "gpt-6.2-sol",
		})
		expect(evaluateTransform(sample, "{id}.{id}")).toEqual({ id: "agt_123" })
		expect(evaluateTransform(sample, "{id,name}.id")).toBe("agt_123")
		expect(evaluateTransform(sample, "[id,name]")).toEqual(["agt_123", "Helper"])
		expect(evaluateTransform(sample, "[id,name].[0]")).toEqual(["agt_123"])
		expect(evaluateTransform(sample, "[id,name].1")).toBe("Helper")
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
})

describe("resolveBunExecutable", () => {
	it("resolves trusted absolute Bun paths on Windows while excluding cwd, project-local trees, relative, and drive-relative entries", () => {
		const winExecutables = new Set([
			String.raw`c:\untrusted\repo\bun.exe`,
			String.raw`c:\untrusted\repo\sub\bun.exe`,
			String.raw`c:\untrusted\repo\node_modules\.bin\bun.exe`,
			String.raw`c:\bin\bun.exe`,
			String.raw`c:\program files\bun\bin\bun.exe`,
		])
		const isWinExec = (candidate: string) => winExecutables.has(candidate.toLowerCase())

		// Excludes bare cwd, relative, empty, drive-relative (\bin, C:bin), explicit cwd entries,
		// AND absolute project-local directories like <cwd>\node_modules\.bin before selecting
		// the quoted absolute PATH entry
		const resolved = resolveBunExecutable({
			platform: "win32",
			cwd: String.raw`C:\untrusted\repo`,
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
					String.raw`c:\UNTRUSTED\REPO\sub`,
					String.raw`"C:\Program Files\Bun\bin"`,
				].join(";"),
			},
			isExecutableFile: isWinExec,
			realpath: (target) => target,
		})
		expect(resolved).toBe(String.raw`C:\Program Files\Bun\bin\bun.exe`)

		// Running from %USERPROFILE% excludes %USERPROFILE%\bun.exe and %USERPROFILE%\node_modules\.bin\bun.exe
		// while still resolving the explicitly trusted %USERPROFILE%\.bun\bin\bun.exe
		const homeExecutables = new Set([
			String.raw`c:\users\alice\bun.exe`,
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
						String.raw`C:\Users\alice\node_modules\.bin`,
						".",
					].join(";"),
				},
				isExecutableFile: (candidate) => homeExecutables.has(candidate.toLowerCase()),
				realpath: (target) => target,
			}),
		).toBe(String.raw`C:\Users\alice\.bun\bin\bun.exe`)

		// Falls back to trusted absolute BUN_INSTALL\bin, while ignoring relative or project-local BUN_INSTALL
		const installExecutables = new Set([
			String.raw`c:\untrusted\repo\bun.exe`,
			String.raw`c:\untrusted\repo\bin\bun.exe`,
			String.raw`c:\untrusted\repo\.bun\bin\bun.exe`,
			String.raw`c:\tools\bun\bin\bun.exe`,
		])
		for (const untrustedBunInstall of [
			String.raw`C:\untrusted\repo`,
			String.raw`C:\untrusted\repo\.bun`,
		]) {
			expect(
				resolveBunExecutable({
					platform: "win32",
					cwd: String.raw`C:\untrusted\repo`,
					homedir: String.raw`C:\Users\alice`,
					env: {
						PATH: String.raw`.;C:\untrusted\repo;C:\untrusted\repo\node_modules\.bin`,
						BUN_INSTALL: untrustedBunInstall,
					},
					isExecutableFile: (candidate) => installExecutables.has(candidate.toLowerCase()),
					realpath: (target) => target,
				}),
			).toBeNull()
		}
		expect(
			resolveBunExecutable({
				platform: "win32",
				cwd: String.raw`C:\untrusted\repo`,
				homedir: String.raw`C:\Users\alice`,
				env: {
					PATH: String.raw`.;C:\untrusted\repo`,
					BUN_INSTALL: String.raw`C:\tools\bun`,
				},
				isExecutableFile: (candidate) => installExecutables.has(candidate.toLowerCase()),
				realpath: (target) => target,
			}),
		).toBe(String.raw`C:\tools\bun\bin\bun.exe`)
	})

	it("resolves trusted absolute Bun paths on POSIX while excluding project-local PATH entries and symlinks into the project tree", () => {
		const posixExecutables = new Set([
			"/private/var/folders/untrusted/bun",
			"/var/folders/untrusted/bun",
			"/var/folders/untrusted/node_modules/.bin/bun",
			"/private/var/folders/untrusted/node_modules/.bin/bun",
			"/tmp/symlink-bin/bun",
			"/tmp/symlink-nested-bin/bun",
			"/opt/bun/bin/bun",
		])
		const posixRealpaths = new Map<string, string>([
			["/var/folders/untrusted", "/private/var/folders/untrusted"],
			["/private/var/folders/untrusted", "/private/var/folders/untrusted"],
			[
				"/var/folders/untrusted/node_modules/.bin",
				"/private/var/folders/untrusted/node_modules/.bin",
			],
			["/tmp/symlink-bin", "/tmp/symlink-bin"],
			["/tmp/symlink-bin/bun", "/private/var/folders/untrusted/bun"],
			["/tmp/symlink-nested-bin", "/tmp/symlink-nested-bin"],
			["/tmp/symlink-nested-bin/bun", "/private/var/folders/untrusted/node_modules/evil/bun"],
			["/opt/bun/bin", "/opt/bun/bin"],
			["/opt/bun/bin/bun", "/opt/bun/bin/bun"],
		])
		const resolved = resolveBunExecutable({
			platform: "darwin",
			cwd: "/var/folders/untrusted",
			homedir: "/Users/alice",
			env: {
				PATH: [
					"",
					"/private/var/folders/untrusted",
					"/var/folders/untrusted/node_modules/.bin",
					"/private/var/folders/untrusted/node_modules/.bin",
					".",
					"./bin",
					"/tmp/symlink-bin",
					"/tmp/symlink-nested-bin",
					"/opt/bun/bin",
					"",
				].join(":"),
			},
			isExecutableFile: (candidate) => posixExecutables.has(candidate),
			realpath: (target) => posixRealpaths.get(target) ?? target,
		})
		expect(resolved).toBe("/opt/bun/bin/bun")

		// Running from $HOME excludes $HOME/node_modules/.bin and symlinks escaping ~/.bun into $HOME,
		// while resolving legitimate ~/.bun/bin/bun
		const homeExecutables = new Set([
			"/Users/alice/node_modules/.bin/bun",
			"/Users/alice/.bun/bin/bun",
		])
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/Users/alice",
				homedir: "/Users/alice",
				env: { PATH: "/Users/alice/node_modules/.bin:/Users/alice/.bun/bin" },
				isExecutableFile: (candidate) => homeExecutables.has(candidate),
				realpath: (target) =>
					target === "/Users/alice/.bun/bin/bun" ? "/Users/alice/evil/bun" : target,
			}),
		).toBeNull()
		expect(
			resolveBunExecutable({
				platform: "darwin",
				cwd: "/Users/alice",
				homedir: "/Users/alice",
				env: { PATH: "/Users/alice/node_modules/.bin:/Users/alice/.bun/bin" },
				isExecutableFile: (candidate) => homeExecutables.has(candidate),
				realpath: (target) => target,
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
			}),
		).toBe("/opt/homebrew/bin/bun")

		// Fails closed with null when only project-local/relative candidates exist
		expect(
			resolveBunExecutable({
				platform: "linux",
				cwd: "/tmp/untrusted",
				homedir: "/home/alice",
				env: {
					PATH: ".:./bin:/tmp/untrusted:/tmp/untrusted/node_modules/.bin",
					BUN_INSTALL: "/tmp/untrusted/.bun",
				},
				isExecutableFile: (candidate) =>
					candidate === "/tmp/untrusted/bun" ||
					candidate === "/tmp/untrusted/node_modules/.bin/bun" ||
					candidate === "/tmp/untrusted/.bun/bin/bun",
				realpath: (target) => target,
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
