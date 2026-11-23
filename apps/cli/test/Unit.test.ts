import { describe, expect, it } from "@effect/vitest"
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
import { makeCheckfuClient, normalizeApiUrl, resolveBaseUrl } from "../src/Client.ts"
import {
	escapeTerminalControlCharacters,
	hasUnsafeTerminalCodePoint,
	stringifyTerminalSafeJson,
} from "../src/TerminalOutput.ts"
import { evaluateTransform, formatOutput } from "../src/Transform.ts"

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
				// 1) Server advertises retry: at start of connection and delivers events on the same response
				let retryRequests = 0
				const retryFetch = (async () => {
					retryRequests++
					return new Response(
						'retry: 25\n\nid: 1\nevent: user.message\ndata: {"seq":1,"type":"user.message"}\n\nid: 2\nevent: session.archived\ndata: {"seq":2,"type":"session.archived"}\n\n',
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
				const retryDropFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					retryDropRequests++
					const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
					retryDropLastIds.push(headers.get("last-event-id"))
					if (retryDropRequests === 1) {
						let pullCount = 0
						const body = new ReadableStream<Uint8Array>({
							pull(controller) {
								if (pullCount === 0) {
									pullCount = 1
									controller.enqueue(
										encoder.encode(
											'retry: 10\n\nid: 1\nevent: user.message\ndata: {"seq":1,"type":"user.message"}\n\n',
										),
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
					return new Response(
						'id: 2\nevent: session.archived\ndata: {"seq":2,"type":"session.archived"}\n\n',
						{
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						},
					)
				}) as unknown as typeof globalThis.fetch

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
								encoder.encode(
									'id: 1\r\nevent: session.archived\r\ndata: {"seq":1,"type":"session.archived"}\r\n\r',
								),
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
					return new Response(
						`id: ${rotSeq}\nevent: ${type}\ndata: {"seq":${rotSeq},"type":"${type}"}\n\n`,
						{
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						},
					)
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
				const timeout408Fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					timeout408Requests++
					const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
					timeout408LastIds.push(headers.get("last-event-id"))
					if (timeout408Requests === 1) {
						let step = 0
						const body = new ReadableStream<Uint8Array>({
							pull(controller) {
								if (step === 0) {
									step = 1
									controller.enqueue(
										encoder.encode(
											'id: 1\nevent: user.message\ndata: {"seq":1,"type":"user.message"}\n\n',
										),
									)
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
					return new Response(
						'id: 2\nevent: session.archived\ndata: {"seq":2,"type":"session.archived"}\n\n',
						{
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						},
					)
				}) as unknown as typeof globalThis.fetch

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
								controller.enqueue(
									encoder.encode(
										'id: 1\nevent: user.message\ndata: {"seq":1,"type":"user.message"}\n\n',
									),
								)
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
					return new Response(
						'id: 1\nevent: user.message\ndata: {"seq":1,"type":"user.message"}\n\nid: 2\ndata: {"partial',
						{
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						},
					)
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
									controller.enqueue(
										encoder.encode(
											'id: 1\nevent: user.message\ndata: {"seq":1,"type":"user.message"}\n\n',
										),
									)
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
				const customSseFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = input instanceof Request ? input.url : String(input)
					const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
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
				}) as unknown as typeof globalThis.fetch
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
										'id: 1\nevent: session.archived\ndata: {"seq":1,"type":"session.archived"}\n\nid: 2\nevent: bogus\ndata: NOT_JSON\n\n',
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
				const resetIdFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
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
				}) as unknown as typeof globalThis.fetch
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
				const idOnlyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
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
				}) as unknown as typeof globalThis.fetch
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
					return new Response(
						'id: 1\nevent: session.archived\ndata: {"seq":1,"type":"session.archived"}\n\n',
						{
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						},
					)
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
					return new Response(
						'id: 1\nevent: session.archived\ndata: {"seq":1,"type":"session.archived"}\n\n',
						{
							status: 200,
							headers: { "content-type": "text/event-stream; charset=utf-8" },
						},
					)
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
				expect(Duration.toMillis(stalled400Duration)).toBeLessThan(1_000)
				expect(stalled400Err.message).toContain("HTTP 400")
				expect(stalled400Err.message).toContain("partial diagnostic")
				expect(stalled400Canceled).toBe(true)
			}),
		)
	})

	it("rejects explicitly blank --base-url instead of falling back to env vars or localhost", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
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
		const dangerous = "hello\x1b]52;c;evil\x07\r\nworld\x7f\u009b31m\u202e\u2028ok\t!"
		const safe = escapeTerminalControlCharacters(dangerous)
		expect(safe).not.toContain("\x1b")
		expect(safe).not.toContain("\x07")
		expect(safe).not.toContain("\r")
		expect(safe).not.toContain("\x7f")
		expect(safe).not.toContain("\u009b")
		expect(safe).not.toContain("\u202e")
		expect(safe).not.toContain("\u2028")
		expect(safe).toContain("\\x1b]52;c;evil\\x07\nworld")
		expect(safe).toContain("ok\t!")
	})

	it("keeps JSON round-trip identical while escaping unsafe terminal code points", () => {
		const payload = { text: "hi\x1b[31m\u009b\u202e\u2028there" }
		const json = stringifyTerminalSafeJson(payload)
		expect(json).not.toContain("\x1b")
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

	it("preserves trailing newlines in YAML scalars and separates streamed YAML documents", () => {
		for (const scalar of ["hello\n\n", "\n\n", "trailing   ", { text: "body\n\n" }]) {
			const rendered = formatOutput(scalar, {
				format: "yaml",
				transform: Option.none(),
				rawOutput: false,
				isTerminal: false,
			})
			expect(YAML.parse(`${rendered}\n`)).toEqual(scalar)
		}

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
		expect(docs.map((doc) => doc.toJS())).toEqual(events)
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
		expect(parsedStreamDocs.map((doc) => doc.toJS())).toEqual(streamedEvents)

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
			controls: "hi\x1b[31m\x07\u009b\u2028\u2029\u2066there",
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
			"\x1b",
			"\x07",
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
