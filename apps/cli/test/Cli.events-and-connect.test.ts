import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import * as YAML from "yaml"
import { makeSigintController } from "../src/Signals.ts"
import { makeTestServer } from "./helpers/CliHarness.ts"

type TestCli = Effect.Success<ReturnType<typeof makeTestServer>>

const createReadySession = (cli: TestCli) =>
	Effect.gen(function* () {
		const agentId = (yield* cli.run([
			"agents",
			"create",
			"--name",
			"Worker",
			"--model",
			"gpt-6.2-sol",
			"--transform",
			"id",
			"-r",
		])).stdout.trim()
		const envId = (yield* cli.run([
			"environments",
			"create",
			"--name",
			"default",
			"--transform",
			"id",
			"-r",
		])).stdout.trim()
		const sessionId = (yield* cli.run([
			"sessions",
			"create",
			"--agent",
			agentId,
			"--environment-id",
			envId,
			"--transform",
			"id",
			"-r",
		])).stdout.trim()
		return sessionId
	})

describe("CLI sessions:events and sessions connect", () => {
	it("sends events with auto and explicit idempotency keys, lists, and streams events", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const sessionId = yield* createReadySession(cli)

					// Send via --event with auto-generated Idempotency-Key printed to stderr
					const sent = yield* cli.run([
						"sessions:events",
						"send",
						"--session-id",
						sessionId,
						"--event",
						'{"type":"user.message","content":[{"type":"text","text":"Hello world"}]}',
					])
					expect(sent.exitCode).toBe(0)
					expect(sent.stderr).toMatch(/Idempotency-Key: cli_[0-9a-f]{24}/)
					const sentBody = JSON.parse(sent.stdout) as {
						data: Array<{ type: string; turn: number }>
					}
					expect(sentBody.data[0]?.type).toBe("user.message")
					expect(sentBody.data[0]?.turn).toBe(1)

					// Wait for turn 1 to settle
					for (let i = 0; i < 200; i++) {
						const s = yield* cli.run(["sessions", "retrieve", "--session-id", sessionId])
						const parsed = JSON.parse(s.stdout) as { status: string; turn: number }
						if (parsed.status === "idle" && parsed.turn === 1) break
						yield* Effect.sleep("5 millis")
					}

					// Explicit idempotency key via YAML stdin + safe retry
					const yamlEvent =
						'type: user.message\ncontent:\n  - type: text\n    text: "Second turn"\n'
					const sent2a = yield* cli.run(
						[
							"sessions:events",
							"send",
							"--session-id",
							sessionId,
							"--idempotency-key",
							"retry-key-1",
						],
						{ stdin: yamlEvent },
					)
					expect(sent2a.exitCode).toBe(0)
					expect(sent2a.stderr).toBe("")

					const sent2b = yield* cli.run(
						[
							"sessions:events",
							"send",
							"--session-id",
							sessionId,
							"--idempotency-key",
							"retry-key-1",
						],
						{ stdin: yamlEvent },
					)
					expect(sent2b.exitCode).toBe(0)

					// Wait for turn 2 to settle
					for (let i = 0; i < 200; i++) {
						const s = yield* cli.run(["sessions", "retrieve", "--session-id", sessionId])
						const parsed = JSON.parse(s.stdout) as { status: string; turn: number }
						if (parsed.status === "idle" && parsed.turn === 2) break
						yield* Effect.sleep("5 millis")
					}

					// List with limit & order
					const listed = yield* cli.run([
						"sessions:events",
						"list",
						"--session-id",
						sessionId,
						"--limit",
						"5",
						"--order",
						"asc",
					])
					expect(listed.exitCode).toBe(0)
					const page = JSON.parse(listed.stdout) as {
						data: Array<{ type: string; seq: number }>
						has_more: boolean
						next_cursor: number | null
					}
					expect(page.data.length).toBe(5)
					expect(page.has_more).toBe(true)
					expect(page.next_cursor).toBe(page.data.at(-1)?.seq)

					// Archive so SSE stream terminates naturally after replaying all events
					yield* cli.run(["sessions", "archive", "--session-id", sessionId])

					// Stream with --transform type -r and --after
					const streamed = yield* cli.run([
						"sessions:events",
						"stream",
						"--session-id",
						sessionId,
						"--transform",
						"type",
						"-r",
					])
					expect(streamed.exitCode).toBe(0)
					const eventTypes = streamed.stdout.trim().split("\n")
					expect(eventTypes).toContain("user.message")
					expect(eventTypes).toContain("agent.thinking")
					expect(eventTypes).toContain("agent.message")
					expect(eventTypes).toContain("session.status_idle")
					expect(eventTypes.at(-1)).toBe("session.archived")

					// Re-streaming past the last event returns 204 and exits cleanly with empty output
					const caughtUp = yield* cli.run([
						"sessions:events",
						"stream",
						"--session-id",
						sessionId,
						"--after",
						"999",
					])
					expect(caughtUp.exitCode).toBe(0)
					expect(caughtUp.stdout).toBe("")
				}),
			),
		)
	})

	it("reconnects SSE streams losslessly with Last-Event-ID on transient disconnect", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const sessionId = yield* createReadySession(cli)

					yield* cli.run([
						"sessions:events",
						"send",
						"--session-id",
						sessionId,
						"--event",
						'{"type":"user.message","content":[{"type":"text","text":"ping"}]}',
					])
					for (let i = 0; i < 200; i++) {
						const s = yield* cli.run(["sessions", "retrieve", "--session-id", sessionId])
						const parsed = JSON.parse(s.stdout) as { status: string; turn: number }
						if (parsed.status === "idle" && parsed.turn === 1) break
						yield* Effect.sleep("5 millis")
					}
					yield* cli.run(["sessions", "archive", "--session-id", sessionId])

					const expectedSeqs = JSON.parse(
						(yield* cli.run([
							"sessions:events",
							"list",
							"--session-id",
							sessionId,
							"--limit",
							"100",
							"--transform",
							"data.#.seq",
						])).stdout,
					) as Array<number>

					let streamRequests = 0
					const seenLastEventIds: Array<string | null> = []

					const streamed = yield* cli.run(
						["sessions:events", "stream", "--session-id", sessionId, "--transform", "seq", "-r"],
						{
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								streamRequests++
								seenLastEventIds.push(request.headers.get("last-event-id"))
								const real = await next(request)
								if (streamRequests === 1 && real.body !== null) {
									// Emit only the first 2 SSE frames, then close connection cleanly (simulating rotation)
									const reader = real.body.getReader()
									const decoder = new TextDecoder()
									const encoder = new TextEncoder()
									let buffer = ""
									let framesSent = 0
									const truncated = new ReadableStream<Uint8Array>({
										async pull(controller) {
											while (framesSent < 2) {
												const chunk = await reader.read()
												if (chunk.done) {
													controller.close()
													return
												}
												buffer += decoder.decode(chunk.value, { stream: true })
												let idx = buffer.indexOf("\n\n")
												while (idx !== -1 && framesSent < 2) {
													const frame = buffer.slice(0, idx + 2)
													buffer = buffer.slice(idx + 2)
													controller.enqueue(encoder.encode(frame))
													framesSent++
													idx = buffer.indexOf("\n\n")
												}
											}
											await reader.cancel()
											controller.close()
										},
									})
									return new Response(truncated, { status: 200, headers: real.headers })
								}
								return real
							},
						},
					)

					expect(streamed.exitCode).toBe(0)
					expect(streamRequests).toBe(2)
					expect(seenLastEventIds[0]).toBeNull()
					expect(seenLastEventIds[1]).toBeTruthy()

					const seqs = streamed.stdout
						.trim()
						.split("\n")
						.map((line) => Number(line))
					// Verify exact 1:1 match with zero duplicates and zero gaps across reconnect
					expect(seqs.length).toBeGreaterThanOrEqual(5)
					expect(seqs).toEqual(expectedSeqs)
				}),
			),
		)
	})

	it("connects non-interactively, sanitizes terminal output, and settles turns cleanly", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: "pondering",
								text: `Reply(${args.turn}): ${args.input.join("+")}\x1b]52;c;evil\x07\u202e`,
								input_tokens: 8,
								output_tokens: 4,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const sessionId = yield* createReadySession(cli)

					const result = yield* cli.run(["sessions", "connect", sessionId], {
						stdin: "first prompt\nsecond prompt\n",
					})
					expect(result.exitCode).toBe(0)
					expect(result.stderr).toContain(`Connected to ${sessionId}`)
					expect(result.stderr).toContain("[thinking] pondering")
					expect(result.stdout).toContain("Reply(1): first prompt")
					expect(result.stdout).toContain("second prompt")
					// ANSI OSC52 and bidi control characters must be escaped on stdout
					expect(result.stdout).not.toContain("\x1b")
					expect(result.stdout).not.toContain("\x07")
					expect(result.stdout).not.toContain("\u202e")
					expect(result.stdout).toContain("\\x1b]52;c;evil\\x07\\u202e")
				}),
			),
		)
	})

	it("handles Ctrl-C (SIGINT) during an active TTY turn by sending user.interrupt", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const started = yield* Deferred.make<void>()
					const interrupted = yield* Deferred.make<void>()
					const sigintController = makeSigintController()

					const cli = yield* makeTestServer({
						generate: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(started, undefined)
								yield* Deferred.await(interrupted)
								return yield* Effect.fail({
									_tag: "ModelRequestInterrupted" as const,
									model_usage: { input_tokens: 2, output_tokens: 0 },
								})
							}),
						interrupt: () => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
					})
					const sessionId = yield* createReadySession(cli)

					let firstSigintConsumed = false
					let secondSigintConsumed = true

					const result = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdinIsTerminal: true,
						sigintController,
						terminalReads: [
							Effect.succeed("long running task"),
							// Wait until model generation is actively running, then fire SIGINT once (consumed -> user.interrupt)
							// and confirm a second SIGINT would fall through (not consumed -> disconnect).
							Deferred.await(started).pipe(
								Effect.andThen(Effect.sleep("25 millis")),
								Effect.andThen(
									Effect.sync(() => {
										firstSigintConsumed = sigintController.handleSigint()
										secondSigintConsumed = sigintController.handleSigint()
									}),
								),
								Effect.andThen(Deferred.await(interrupted)),
								Effect.andThen(Effect.sleep("40 millis")),
								Effect.andThen(Effect.succeed("/exit")),
							),
						],
					})

					expect(result.exitCode).toBe(0)
					expect(firstSigintConsumed).toBe(true)
					expect(secondSigintConsumed).toBe(false)
					expect(result.stderr).toContain("Interrupt requested.")
					expect(result.stderr).toContain("Press Ctrl-C again to disconnect.")

					const eventsRes = yield* cli.run([
						"sessions:events",
						"list",
						"--session-id",
						sessionId,
						"--transform",
						"data.#.type",
					])
					expect(eventsRes.exitCode).toBe(0)
					const types = JSON.parse(eventsRes.stdout) as Array<string>
					expect(types).toContain("user.interrupt")
				}),
			),
		)
	})

	it("reconnects with Last-Event-ID on SSE response body read errors, fails on bad JSON, and survives >6 idle rotations", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const sessionId = yield* createReadySession(cli)

					yield* cli.run([
						"sessions:events",
						"send",
						"--session-id",
						sessionId,
						"--event",
						'{"type":"user.message","content":[{"type":"text","text":"resilience test"}]}',
					])
					for (let i = 0; i < 200; i++) {
						const s = yield* cli.run(["sessions", "retrieve", "--session-id", sessionId])
						const parsed = JSON.parse(s.stdout) as { status: string; turn: number }
						if (parsed.status === "idle" && parsed.turn === 1) break
						yield* Effect.sleep("5 millis")
					}
					yield* cli.run(["sessions", "archive", "--session-id", sessionId])

					const expectedSeqs = JSON.parse(
						(yield* cli.run([
							"sessions:events",
							"list",
							"--session-id",
							sessionId,
							"--limit",
							"100",
							"--transform",
							"data.#.seq",
						])).stdout,
					) as Array<number>

					// 1) Body read failure mid-stream (triggers WebHttpClientResponse DecodeError)
					let bodyErrorRequests = 0
					const bodyErrorLastIds: Array<string | null> = []
					const recovered = yield* cli.run(
						["sessions:events", "stream", "--session-id", sessionId, "--transform", "seq", "-r"],
						{
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) return next(request)
								bodyErrorRequests++
								bodyErrorLastIds.push(request.headers.get("last-event-id"))
								const real = await next(request)
								if (bodyErrorRequests === 1 && real.body !== null) {
									const reader = real.body.getReader()
									const decoder = new TextDecoder()
									const encoder = new TextEncoder()
									let buffer = ""
									let framesSent = 0
									const failingBody = new ReadableStream<Uint8Array>({
										async pull(controller) {
											while (framesSent < 2) {
												const chunk = await reader.read()
												if (chunk.done) {
													controller.close()
													return
												}
												buffer += decoder.decode(chunk.value, { stream: true })
												let idx = buffer.indexOf("\n\n")
												while (idx !== -1 && framesSent < 2) {
													const frame = buffer.slice(0, idx + 2)
													buffer = buffer.slice(idx + 2)
													controller.enqueue(encoder.encode(frame))
													framesSent++
													idx = buffer.indexOf("\n\n")
												}
											}
											await reader.cancel()
											controller.error(new TypeError("connection reset by peer"))
										},
									})
									return new Response(failingBody, { status: 200, headers: real.headers })
								}
								return real
							},
						},
					)
					expect(recovered.exitCode).toBe(0)
					expect(bodyErrorRequests).toBe(2)
					expect(bodyErrorLastIds[0]).toBeNull()
					expect(bodyErrorLastIds[1]).toBeTruthy()
					expect(
						recovered.stdout
							.trim()
							.split("\n")
							.map((line) => Number(line)),
					).toEqual(expectedSeqs)

					// 2) Malformed SSE JSON payload fails immediately without retrying
					let badJsonRequests = 0
					const badJson = yield* cli.run(["sessions:events", "stream", "--session-id", sessionId], {
						interceptFetch: async (next, request) => {
							if (!request.url.includes("/events/stream")) return next(request)
							badJsonRequests++
							return new Response("id: 1\nevent: user.message\ndata: {not-json\n\n", {
								status: 200,
								headers: { "content-type": "text/event-stream; charset=utf-8" },
							})
						},
					})
					expect(badJson.exitCode).toBe(1)
					expect(badJsonRequests).toBe(1)
					expect(badJson.stderr).toContain("Invalid SSE event JSON payload")

					// 3) >6 consecutive healthy idle keepalive rotations stay connected and deliver all events
					let rotationRequests = 0
					const rotated = yield* cli.run(
						["sessions:events", "stream", "--session-id", sessionId, "--format", "yaml"],
						{
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) return next(request)
								rotationRequests++
								if (rotationRequests <= 8) {
									return new Response(": keepalive\n\n", {
										status: 200,
										headers: { "content-type": "text/event-stream; charset=utf-8" },
									})
								}
								return next(request)
							},
						},
					)
					expect(rotated.exitCode).toBe(0)
					expect(rotationRequests).toBe(9)
					const yamlDocs = YAML.parseAllDocuments(rotated.stdout)
					expect(yamlDocs.length).toBe(expectedSeqs.length)
					for (const doc of yamlDocs) {
						expect(doc.errors).toEqual([])
					}
					expect(yamlDocs.map((doc) => (doc.toJS() as { seq: number }).seq)).toEqual(expectedSeqs)
				}),
			),
		)
	})

	it("tracks replayed turns accurately for --after 0 and mid-turn cursors, exits on piped /exit without EOF, and fails promptly on unexpected 204", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `Turn ${args.turn}: ${args.input.join("+")}`,
								input_tokens: 4,
								output_tokens: 4,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const sessionId = yield* createReadySession(cli)

					// Complete turn 1 first
					const firstTurn = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdin: "first message\n",
					})
					expect(firstTurn.exitCode).toBe(0)
					expect(firstTurn.stdout).toContain("Turn 1: first message")

					// 1) sessions connect --after 0 must count replayed turn 1 as turn 1 and wait for turn 2
					const afterZero = yield* cli.run(
						["sessions", "connect", "--session-id", sessionId, "--after", "0"],
						{ stdin: "second message\n" },
					)
					expect(afterZero.exitCode).toBe(0)
					expect(afterZero.stdout).toContain("Turn 1: first message")
					expect(afterZero.stdout).toContain("Turn 2: second message")

					// 2) sessions connect --after <mid-turn-seq> (after turn 1 status_running, before turn 1 status_idle)
					const history = JSON.parse(
						(yield* cli.run([
							"sessions:events",
							"list",
							"--session-id",
							sessionId,
							"--limit",
							"100",
						])).stdout,
					) as { data: Array<{ seq: number; type: string }> }
					const firstRunningSeq = history.data.find(
						(event) => event.type === "session.status_running",
					)?.seq
					expect(firstRunningSeq).toBeDefined()

					const afterMidTurn = yield* cli.run(
						["sessions", "connect", "--session-id", sessionId, "--after", String(firstRunningSeq)],
						{ stdin: "third message\n" },
					)
					expect(afterMidTurn.exitCode).toBe(0)
					expect(afterMidTurn.stdout).toContain("Turn 3: third message")

					// 3) Piped /exit terminates immediately even when stdin remains open without EOF
					const openPipeExit = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdin: Stream.concat(Stream.make(new TextEncoder().encode("/exit\n")), Stream.never),
					})
					expect(openPipeExit.exitCode).toBe(0)

					// 4) Piped connect reports an error instead of hanging if the event stream ends (HTTP 204) before turn settles
					let releaseStream204: (() => void) | undefined
					const sentPrompt = new Promise<void>((resolve) => {
						releaseStream204 = resolve
					})
					const unexpectedEnd = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdin: "unsettled prompt\n",
						interceptFetch: async (next, request) => {
							if (request.url.includes("/events/stream")) {
								await sentPrompt
								return new Response(null, { status: 204 })
							}
							const res = await next(request)
							if (request.method === "POST" && request.url.endsWith("/events")) {
								setTimeout(() => releaseStream204?.(), 25)
							}
							return res
						},
					})
					expect(unexpectedEnd.exitCode).toBe(1)
					expect(unexpectedEnd.stderr).toContain("Event stream ended before turn 4 completed.")
				}),
			),
		)
	})

	it("rejects non-SSE HTTP 200 responses without retrying, rejects future --after cursors, handles non-archived termination in TTY and reconnect, and fails piped retries_exhausted without blaming replayed errors", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					// 1) Non-SSE HTTP 200 HTML response fails immediately on first request (no reconnect loop)
					const baseCli = yield* makeTestServer()
					const baseSessionId = yield* createReadySession(baseCli)
					let htmlRequests = 0
					const htmlRes = yield* baseCli.run(
						["sessions:events", "stream", "--session-id", baseSessionId],
						{
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) return next(request)
								htmlRequests++
								return new Response("<html><body>proxy error</body></html>", {
									status: 200,
									headers: { "content-type": "text/html; charset=utf-8" },
								})
							},
						},
					)
					expect(htmlRes.exitCode).toBe(1)
					expect(htmlRequests).toBe(1)
					expect(htmlRes.stderr).toContain("Expected text/event-stream")

					// 2) Future --after cursor beyond session history is rejected before sending input
					const futureCursor = yield* baseCli.run(
						["sessions", "connect", "--session-id", baseSessionId, "--after", "99"],
						{ stdin: "should not send\n" },
					)
					expect(futureCursor.exitCode).toBe(1)
					expect(futureCursor.stderr).toContain("beyond the latest session event sequence")

					// 3) Terminal model failure (session.status_terminated without session.archived):
					//    a) wakes a blocked TTY readLine cleanly without hanging
					//    b) connecting again to the already-terminated non-archived session exits cleanly (both --after 0 and --after <lastSeq>)
					const terminalCli = yield* makeTestServer({
						generate: () =>
							Effect.fail({
								_tag: "ModelProviderError" as const,
								error_type: "authentication_error",
								message: "Invalid provider key",
								terminal: true,
							}),
					})
					const termSessionId = yield* createReadySession(terminalCli)

					const ttyTerminated = yield* terminalCli.run(
						["sessions", "connect", "--session-id", termSessionId],
						{
							stdinIsTerminal: true,
							terminalReads: [
								Effect.succeed("trigger terminal failure"),
								// Second readLine stays blocked forever until session.status_terminated wakes the race
								Effect.never,
							],
						},
					)
					expect(ttyTerminated.exitCode).toBe(0)
					expect(ttyTerminated.stderr).toContain(
						"[error] authentication_error: Invalid provider key",
					)
					expect(ttyTerminated.stderr).toContain("[session terminated]")

					// Reconnect to already-terminated (non-archived) session from start: replays and exits without hanging
					const replayTerminated = yield* terminalCli.run([
						"sessions",
						"connect",
						"--session-id",
						termSessionId,
					])
					expect(replayTerminated.exitCode).toBe(0)
					expect(replayTerminated.stderr).toContain("[session terminated]")

					// Reconnect to already-terminated (non-archived) session at last seq: exits immediately
					const termHistory = JSON.parse(
						(yield* terminalCli.run([
							"sessions:events",
							"list",
							"--session-id",
							termSessionId,
							"--limit",
							"100",
						])).stdout,
					) as { data: Array<{ seq: number }> }
					const lastTermSeq = termHistory.data.at(-1)?.seq ?? 0
					const atEndTerminated = yield* terminalCli.run([
						"sessions",
						"connect",
						"--session-id",
						termSessionId,
						"--after",
						String(lastTermSeq),
					])
					expect(atEndTerminated.exitCode).toBe(0)

					// 4) Non-terminal retries_exhausted fails piped connect with exit code 1,
					//    while a subsequent piped turn replaying that historical error with --after 0 succeeds with exit code 0
					const retryCli = yield* makeTestServer({
						generate: (args) => {
							if (args.turn === 1) {
								return Effect.fail({
									_tag: "ModelProviderError" as const,
									error_type: "rate_limit_error",
									message: "Rate limited",
									terminal: false,
								})
							}
							return Effect.succeed({
								thinking: null,
								text: `Recovered on turn ${args.turn}`,
								input_tokens: 4,
								output_tokens: 4,
								stop_reason: { type: "end_turn" as const },
							})
						},
					})
					const retrySessionId = yield* createReadySession(retryCli)

					const exhaustedPiped = yield* retryCli.run(
						["sessions", "connect", "--session-id", retrySessionId],
						{ stdin: "will exhaust retries\n" },
					)
					expect(exhaustedPiped.exitCode).toBe(1)
					expect(exhaustedPiped.stderr).toContain("[status: idle (retries_exhausted)]")
					expect(exhaustedPiped.stderr).toContain("Turn 1 failed")

					const recoveredAfterZero = yield* retryCli.run(
						["sessions", "connect", "--session-id", retrySessionId, "--after", "0"],
						{ stdin: "succeed on turn 2\n" },
					)
					expect(recoveredAfterZero.exitCode).toBe(0)
					expect(recoveredAfterZero.stdout).toContain("Recovered on turn 2")
				}),
			),
		)
	})

	it("handles queued turns halted by refusal/budget_reached, mid-turn archival, and rejected piped interrupts", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					// 1) Two piped messages where turn 1 finishes with refusal (does not drain queue):
					//    must not hang waiting for turn 2, and must exit non-zero reporting queued turn 2 did not start.
					//    A subsequent piped message starting turn 2 cleanly on --after 0 must still succeed.
					const turn1Started = yield* Deferred.make<void>()
					const releaseTurn1 = yield* Deferred.make<void>()
					const refusalCli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									yield* Deferred.succeed(turn1Started, undefined)
									yield* Deferred.await(releaseTurn1)
									return {
										thinking: null,
										text: "I cannot comply.",
										input_tokens: 4,
										output_tokens: 4,
										stop_reason: { type: "refusal" as const },
									}
								}
								return {
									thinking: null,
									text: `Turn ${args.turn} ok`,
									input_tokens: 4,
									output_tokens: 4,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const refusalSessionId = yield* createReadySession(refusalCli)

					const queuedRefusal = yield* refusalCli.run(
						["sessions", "connect", "--session-id", refusalSessionId],
						{
							stdin: "first prompt\nqueued second prompt\n",
							interceptFetch: async (next, request) => {
								const res = await next(request)
								if (request.method === "POST" && request.url.endsWith("/events")) {
									// Release turn 1 once the second message has been queued
									const cloned = res.clone()
									const body = (await cloned.json().catch(() => null)) as {
										data?: Array<{ turn?: number }>
									} | null
									if (body?.data?.[0]?.turn === 2) {
										await Effect.runPromise(Deferred.succeed(releaseTurn1, undefined))
									}
								}
								return res
							},
						},
					)
					expect(queuedRefusal.exitCode).toBe(1)
					expect(queuedRefusal.stderr).toContain("[status: idle (refusal)]")
					expect(queuedRefusal.stderr).toContain(
						"Queued turn 2 did not start because turn 1 stopped with refusal.",
					)

					// Replaying historical refusal with --after 0 while a fresh message starts turn 2 must succeed
					const afterHistoricalRefusal = yield* refusalCli.run(
						["sessions", "connect", "--session-id", refusalSessionId, "--after", "0"],
						{ stdin: "fresh prompt after refusal\n" },
					)
					expect(afterHistoricalRefusal.exitCode).toBe(0)
					expect(afterHistoricalRefusal.stdout).toContain("Turn 2 ok")

					// 2) Archiving a session externally after a piped message was accepted but before it completes
					//    must fail with exit code 1, while reconnecting only to replay the archived session succeeds.
					const midTurnStarted = yield* Deferred.make<void>()
					const archiveCli = yield* makeTestServer({
						generate: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(midTurnStarted, undefined)
								return yield* Effect.never
							}),
					})
					const archiveSessionId = yield* createReadySession(archiveCli)

					const archiverFiber = yield* Deferred.await(midTurnStarted).pipe(
						Effect.andThen(Effect.sleep("20 millis")),
						Effect.andThen(
							archiveCli.run(["sessions", "archive", "--session-id", archiveSessionId]),
						),
						Effect.forkChild,
					)
					const archivedMidTurn = yield* archiveCli.run(
						["sessions", "connect", "--session-id", archiveSessionId],
						{ stdin: "in-flight message\n" },
					)
					yield* Fiber.await(archiverFiber)
					expect(archivedMidTurn.exitCode).toBe(1)
					expect(archivedMidTurn.stderr).toContain("Session terminated before turn 1 completed.")

					const replayArchived = yield* archiveCli.run([
						"sessions",
						"connect",
						"--session-id",
						archiveSessionId,
					])
					expect(replayArchived.exitCode).toBe(0)
					expect(replayArchived.stderr).toContain("[session archived]")

					// Piping a message into an already-archived session must fail rather than returning success
					const pipedToArchived = yield* archiveCli.run(
						["sessions", "connect", "--session-id", archiveSessionId],
						{ stdin: "message to dead session\n" },
					)
					expect(pipedToArchived.exitCode).toBe(1)
					expect(pipedToArchived.stdout).toBe("")
					expect(pipedToArchived.stderr).toContain("already archived")

					// Failure during queued-turn status verification must propagate rather than hanging
					const lookupFailRelease = yield* Deferred.make<void>()
					const lookupFailCli = yield* makeTestServer({
						generate: () =>
							Effect.gen(function* () {
								yield* Deferred.await(lookupFailRelease)
								return {
									thinking: null,
									text: "Refused",
									input_tokens: 4,
									output_tokens: 4,
									stop_reason: { type: "refusal" as const },
								}
							}),
					})
					const lookupFailSessionId = yield* createReadySession(lookupFailCli)
					let statusGetsAfterStart = 0
					let sawQueuedSecond = false
					const lookupFailed = yield* lookupFailCli.run(
						["sessions", "connect", "--session-id", lookupFailSessionId],
						{
							stdin: "first\nqueued\n",
							interceptFetch: async (next, request) => {
								if (
									sawQueuedSecond &&
									request.method === "GET" &&
									request.url.endsWith(`/v1/sessions/${lookupFailSessionId}`)
								) {
									statusGetsAfterStart++
									return new Response(
										JSON.stringify({
											type: "error",
											error: { type: "service_unavailable", message: "Backend unavailable" },
											request_id: "req_test",
										}),
										{ status: 503, headers: { "content-type": "application/json" } },
									)
								}
								const res = await next(request)
								if (request.method === "POST" && request.url.endsWith("/events")) {
									const body = (await res
										.clone()
										.json()
										.catch(() => null)) as {
										data?: Array<{ turn?: number }>
									} | null
									if (body?.data?.[0]?.turn === 2) {
										sawQueuedSecond = true
										await Effect.runPromise(Deferred.succeed(lookupFailRelease, undefined))
									}
								}
								return res
							},
						},
					)
					expect(lookupFailed.exitCode).toBe(1)
					expect(statusGetsAfterStart).toBe(3)
					expect(lookupFailed.stderr).toContain("503")

					// 3) Rejected /interrupt fails piped connect with exit code 1,
					//    but interactive TTY mode reports the error and allows continuing until /exit
					const idleCli = yield* makeTestServer()
					const idleSessionId = yield* createReadySession(idleCli)

					const pipedInterrupt = yield* idleCli.run(
						["sessions", "connect", "--session-id", idleSessionId],
						{ stdin: "/interrupt\n" },
					)
					expect(pipedInterrupt.exitCode).toBe(1)
					expect(pipedInterrupt.stderr).toContain("409 conflict_error")

					const ttyInterrupt = yield* idleCli.run(
						["sessions", "connect", "--session-id", idleSessionId],
						{
							stdinIsTerminal: true,
							terminalReads: [Effect.succeed("/interrupt"), Effect.succeed("/exit")],
						},
					)
					expect(ttyInterrupt.exitCode).toBe(0)
					expect(ttyInterrupt.stderr).toContain("Interrupt failed:")
				}),
			),
		)
	})
})
