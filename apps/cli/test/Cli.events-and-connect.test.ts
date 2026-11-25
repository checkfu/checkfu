import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as Http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import type * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import * as YAML from "yaml"
import { makeSigintController } from "../src/Signals.ts"
import { makeTestServer } from "./helpers/CliHarness.ts"
import { cliProcessEnv } from "./helpers/ProcessEnv.ts"

type TestCli = Effect.Success<ReturnType<typeof makeTestServer>>

const PINNED_BUN_FLAGS = [
	"--no-env-file",
	`--config=${fileURLToPath(new URL("../bunfig.toml", import.meta.url))}`,
] as const

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

					for (let i = 0; i < 200; i++) {
						const s = yield* cli.run(["sessions", "retrieve", "--session-id", sessionId])
						const parsed = JSON.parse(s.stdout) as { status: string; turn: number }
						if (parsed.status === "idle" && parsed.turn === 1) {
							break
						}
						yield* Effect.sleep("5 millis")
					}

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

					for (let i = 0; i < 200; i++) {
						const s = yield* cli.run(["sessions", "retrieve", "--session-id", sessionId])
						const parsed = JSON.parse(s.stdout) as { status: string; turn: number }
						if (parsed.status === "idle" && parsed.turn === 2) {
							break
						}
						yield* Effect.sleep("5 millis")
					}

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

					yield* cli.run(["sessions", "archive", "--session-id", sessionId])

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

	it("sends one event object or a whole body from stdin", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const message = { type: "user.message", content: [{ type: "text", text: "Hello" }] }

					const single = yield* cli.run(
						["sessions:events", "send", "--session-id", yield* createReadySession(cli)],
						{ stdin: JSON.stringify(message) },
					)
					expect(single.exitCode).toBe(0)
					expect(
						(JSON.parse(single.stdout) as { data: Array<{ type: string }> }).data[0]?.type,
					).toBe("user.message")

					const whole = yield* cli.run(
						["sessions:events", "send", "--session-id", yield* createReadySession(cli)],
						{ stdin: JSON.stringify({ events: [message] }) },
					)
					expect(whole.exitCode).toBe(0)
					expect((JSON.parse(whole.stdout) as { data: Array<{ type: string }> }).data).toHaveLength(
						1,
					)

					let requests = 0
					const scalar = yield* cli.run(["sessions:events", "send", "--session-id", "sess_1"], {
						stdin: "hello\n",
						interceptFetch: async (next, request) => {
							requests += 1
							return next(request)
						},
					})
					expect(scalar.exitCode).toBe(1)
					expect(scalar.stdout).toBe("")
					expect(scalar.stderr).toContain(
						"Expected stdin to be { events: [...] }, an array, or a single item object.",
					)
					expect(requests).toBe(0)
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
						if (parsed.status === "idle" && parsed.turn === 1) {
							break
						}
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

					const seqs = streamed.stdout.trim().split("\n").map(Number)
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
								text: `Reply(${args.turn}): ${args.input.join("+")}\u001b]52;c;evil\u0007\u202e`,
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
					expect(result.stdout).not.toContain("\u001b")
					expect(result.stdout).not.toContain("\u0007")
					expect(result.stdout).not.toContain("\u202e")
					expect(result.stdout).toContain(String.raw`\x1b]52;c;evil\x07\u202e`)
				}),
			),
		)
	})

	it("delivers an interrupt that Ctrl-C requested even when a disconnect follows at once", async () => {
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
									_tag: "TurnInterrupted" as const,
									model_usage: { input_tokens: 1, output_tokens: 0 },
								})
							}),
						interrupt: () => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
					})
					const sessionId = yield* createReadySession(cli)

					const connect = yield* cli
						.run(["sessions", "connect", "--session-id", sessionId], {
							stdinIsTerminal: true,
							sigintController,
							terminalReads: [Effect.succeed("long running task"), Effect.never],
						})
						.pipe(Effect.forkChild)
					yield* Deferred.await(started)

					expect(sigintController.handleSigint()).toBe(true)
					yield* Fiber.interrupt(connect)

					const events = yield* cli.run([
						"sessions:events",
						"list",
						"--session-id",
						sessionId,
						"--transform",
						"data.#.type",
					])
					expect(JSON.parse(events.stdout)).toContain("user.interrupt")
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
									_tag: "TurnInterrupted" as const,
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
						if (parsed.status === "idle" && parsed.turn === 1) {
							break
						}
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

					let bodyErrorRequests = 0
					const bodyErrorLastIds: Array<string | null> = []
					const recovered = yield* cli.run(
						["sessions:events", "stream", "--session-id", sessionId, "--transform", "seq", "-r"],
						{
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
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
					expect(recovered.stdout.trim().split("\n").map(Number)).toEqual(expectedSeqs)

					let badJsonRequests = 0
					const badJson = yield* cli.run(["sessions:events", "stream", "--session-id", sessionId], {
						interceptFetch: async (next, request) => {
							if (!request.url.includes("/events/stream")) {
								return next(request)
							}
							badJsonRequests++
							return new Response("id: 1\nevent: user.message\ndata: {not-json\n\n", {
								status: 200,
								headers: { "content-type": "text/event-stream; charset=utf-8" },
							})
						},
					})
					expect(badJson.exitCode).toBe(1)
					expect(badJsonRequests).toBe(1)
					expect(badJson.stderr).toContain("Invalid SSE event payload")

					let rotationRequests = 0
					let virtualRotationNanos = 1_000_000_000n
					const rotationSleepsMs: Array<number> = []
					const rotationClock: Clock.Clock = {
						currentTimeMillisUnsafe: () => Number(virtualRotationNanos / 1_000_000n),
						currentTimeMillis: Effect.sync(() => Number(virtualRotationNanos / 1_000_000n)),
						currentTimeNanosUnsafe: () => virtualRotationNanos,
						currentTimeNanos: Effect.sync(() => virtualRotationNanos),
						monotonicTimeNanosUnsafe: () => virtualRotationNanos,
						monotonicTimeNanos: Effect.sync(() => virtualRotationNanos),
						sleep: (duration) =>
							Effect.sync(() => {
								const ms = Duration.toMillis(duration)
								rotationSleepsMs.push(ms)
								virtualRotationNanos += BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n
							}),
					}
					const rotationEncoder = new TextEncoder()
					const rotated = yield* cli.run(
						["sessions:events", "stream", "--session-id", sessionId, "--format", "yaml"],
						{
							clock: rotationClock,
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								rotationRequests++
								if (rotationRequests <= 8) {
									let step = 0
									const idleBody = new ReadableStream<Uint8Array>({
										pull(controller) {
											if (step === 0) {
												step = 1
												controller.enqueue(rotationEncoder.encode(": keepalive\n\n"))
											} else {
												virtualRotationNanos += 10_000_000_000n
												controller.close()
											}
										},
									})
									return new Response(idleBody, {
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
					expect(rotationSleepsMs).toEqual([50, 50, 50, 50, 50, 50, 50, 50])
					const yamlDocs = YAML.parseAllDocuments(rotated.stdout)
					expect(yamlDocs.length).toBe(expectedSeqs.length)
					for (const doc of yamlDocs) {
						expect(doc.errors).toEqual([])
					}
					expect(yamlDocs.map((doc) => (doc.toJS() as { seq: number }).seq)).toEqual(expectedSeqs)

					let replayStreamRequests = 0
					let savedPrefixFrames = ""
					const deduped = yield* cli.run(
						["sessions:events", "stream", "--session-id", sessionId, "--transform", "seq", "-r"],
						{
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								replayStreamRequests += 1
								const conn = replayStreamRequests
								const real = await next(request)
								if (real.body === null) {
									return real
								}
								const reader = real.body.getReader()
								const decoder = new TextDecoder()
								const encoder = new TextEncoder()
								if (conn === 1) {
									let buffer = ""
									let framesSent = 0
									const dropAfterTwo = new ReadableStream<Uint8Array>({
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
													savedPrefixFrames += frame
													controller.enqueue(encoder.encode(frame))
													framesSent += 1
													idx = buffer.indexOf("\n\n")
												}
											}
											await reader.cancel()
											controller.error(new TypeError("simulated stream disconnect"))
										},
									})
									return new Response(dropAfterTwo, { status: 200, headers: real.headers })
								}
								let replayed = false
								const withDuplicatePrefix = new ReadableStream<Uint8Array>({
									async pull(controller) {
										if (!replayed) {
											replayed = true
											controller.enqueue(encoder.encode(savedPrefixFrames))
											return
										}
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										controller.enqueue(chunk.value)
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(withDuplicatePrefix, { status: 200, headers: real.headers })
							},
						},
					)
					expect(deduped.exitCode).toBe(0)
					expect(replayStreamRequests).toBe(2)
					expect(deduped.stdout.trim().split("\n").map(Number)).toEqual(expectedSeqs)

					const dedupedAfter = yield* cli.run(
						[
							"sessions:events",
							"stream",
							"--session-id",
							sessionId,
							"--after",
							"2",
							"--transform",
							"seq",
							"-r",
						],
						{
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								const real = await next(request)
								if (real.body === null) {
									return real
								}
								const reader = real.body.getReader()
								const encoder = new TextEncoder()
								let replayed = false
								const withStalePrefix = new ReadableStream<Uint8Array>({
									async pull(controller) {
										if (!replayed) {
											replayed = true
											controller.enqueue(encoder.encode(savedPrefixFrames))
											return
										}
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										controller.enqueue(chunk.value)
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(withStalePrefix, { status: 200, headers: real.headers })
							},
						},
					)
					expect(dedupedAfter.exitCode).toBe(0)
					expect(dedupedAfter.stdout.trim().split("\n").map(Number)).toEqual(
						expectedSeqs.filter((seq) => seq > 2),
					)
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

					const firstTurn = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdin: "first message\n",
					})
					expect(firstTurn.exitCode).toBe(0)
					expect(firstTurn.stdout).toContain("Turn 1: first message")

					const afterZero = yield* cli.run(
						["sessions", "connect", "--session-id", sessionId, "--after", "0"],
						{ stdin: "second message\n" },
					)
					expect(afterZero.exitCode).toBe(0)
					expect(afterZero.stdout).toContain("Turn 1: first message")
					expect(afterZero.stdout).toContain("Turn 2: second message")

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

					const openPipeExit = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdin: Stream.concat(Stream.make(new TextEncoder().encode("/exit\n")), Stream.never),
					})
					expect(openPipeExit.exitCode).toBe(0)

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
					const baseCli = yield* makeTestServer()
					const baseSessionId = yield* createReadySession(baseCli)
					let htmlRequests = 0
					const htmlRes = yield* baseCli.run(
						["sessions:events", "stream", "--session-id", baseSessionId],
						{
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
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

					const futureCursor = yield* baseCli.run(
						["sessions", "connect", "--session-id", baseSessionId, "--after", "99"],
						{ stdin: "should not send\n" },
					)
					expect(futureCursor.exitCode).toBe(1)
					expect(futureCursor.stderr).toContain("beyond the latest session event sequence")

					const terminalCli = yield* makeTestServer({
						generate: () =>
							Effect.fail({
								_tag: "TurnFailed" as const,
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
							terminalReads: [Effect.succeed("trigger terminal failure"), Effect.never],
						},
					)
					expect(ttyTerminated.exitCode).toBe(0)
					expect(ttyTerminated.stderr).toContain(
						"[error] authentication_error: Invalid provider key",
					)
					expect(ttyTerminated.stderr).toContain("[session terminated]")

					const replayTerminated = yield* terminalCli.run([
						"sessions",
						"connect",
						"--session-id",
						termSessionId,
					])
					expect(replayTerminated.exitCode).toBe(0)
					expect(replayTerminated.stderr).toContain("[session terminated]")

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

					const retryCli = yield* makeTestServer({
						generate: (args) => {
							if (args.turn === 1) {
								return Effect.fail({
									_tag: "TurnFailed" as const,
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
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
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
									const cloned = res.clone()
									const body = (await cloned.json().catch(() => null)) as {
										data?: Array<{ turn?: number }>
									} | null
									if (body?.data?.[0]?.turn === 2) {
										await runPromise(Deferred.succeed(releaseTurn1, undefined))
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

					const afterHistoricalRefusal = yield* refusalCli.run(
						["sessions", "connect", "--session-id", refusalSessionId, "--after", "0"],
						{ stdin: "fresh prompt after refusal\n" },
					)
					expect(afterHistoricalRefusal.exitCode).toBe(0)
					expect(afterHistoricalRefusal.stdout).toContain("Turn 2 ok")

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

					const pipedToArchived = yield* archiveCli.run(
						["sessions", "connect", "--session-id", archiveSessionId],
						{ stdin: "message to dead session\n" },
					)
					expect(pipedToArchived.exitCode).toBe(1)
					expect(pipedToArchived.stdout).toBe("")
					expect(pipedToArchived.stderr).toContain("already archived")

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
										await runPromise(Deferred.succeed(lookupFailRelease, undefined))
									}
								}
								return res
							},
						},
					)
					expect(lookupFailed.exitCode).toBe(1)
					expect(statusGetsAfterStart).toBe(3)
					expect(lookupFailed.stderr).toContain("503")

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

	it("preserves indented message whitespace and interrupts an already-running session on Ctrl-C during history replay", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const receivedInputs: Array<string> = []
					const wsCli = yield* makeTestServer({
						generate: (args) =>
							Effect.sync(() => {
								receivedInputs.push(...args.input)
								return {
									thinking: null,
									text: `Got:[${args.input.join("|")}]`,
									input_tokens: 4,
									output_tokens: 4,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const wsSessionId = yield* createReadySession(wsCli)
					const indented = "    const x = 1  "
					const wsResult = yield* wsCli.run(["sessions", "connect", "--session-id", wsSessionId], {
						stdin: `${indented}\n`,
					})
					expect(wsResult.exitCode).toBe(0)
					expect(receivedInputs).toEqual([indented])
					expect(wsResult.stdout).toContain(`Got:[${indented}]`)
					expect(wsResult.stdout).toContain(`[user] ${indented}`)

					const turn2Started = yield* Deferred.make<void>()
					const turn2Interrupted = yield* Deferred.make<void>()
					const sigintController = makeSigintController()

					const replayCtrlCCli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									return {
										thinking: null,
										text: "Turn 1 done",
										input_tokens: 2,
										output_tokens: 2,
										stop_reason: { type: "end_turn" as const },
									}
								}
								yield* Deferred.succeed(turn2Started, undefined)
								yield* Deferred.await(turn2Interrupted)
								return yield* Effect.fail({
									_tag: "TurnInterrupted" as const,
									model_usage: { input_tokens: 2, output_tokens: 0 },
								})
							}),
						interrupt: () => Deferred.succeed(turn2Interrupted, undefined).pipe(Effect.asVoid),
					})
					const runningSessionId = yield* createReadySession(replayCtrlCCli)

					const t1 = yield* replayCtrlCCli.run(
						["sessions", "connect", "--session-id", runningSessionId],
						{ stdin: "finish turn 1\n" },
					)
					expect(t1.exitCode).toBe(0)

					yield* replayCtrlCCli.run([
						"sessions:events",
						"send",
						"--session-id",
						runningSessionId,
						"--event",
						'{"type":"user.message","content":[{"type":"text","text":"long turn 2"}]}',
					])
					yield* Deferred.await(turn2Started)

					let releaseReplay: (() => void) | undefined
					const replayGate = new Promise<void>((resolve) => {
						releaseReplay = resolve
					})
					let firstSigintConsumed = false

					const ttyRes = yield* replayCtrlCCli.run(
						["sessions", "connect", "--session-id", runningSessionId],
						{
							stdinIsTerminal: true,
							sigintController,
							interceptFetch: async (next, request) => {
								if (request.url.includes("/events/stream")) {
									await replayGate
								}
								return next(request)
							},
							terminalReads: [
								Effect.sleep("25 millis").pipe(
									Effect.andThen(
										Effect.sync(() => {
											firstSigintConsumed = sigintController.handleSigint()
										}),
									),
									Effect.andThen(Deferred.await(turn2Interrupted)),
									Effect.andThen(Effect.sync(() => releaseReplay?.())),
									Effect.andThen(Effect.sleep("25 millis")),
									Effect.andThen(Effect.succeed("/exit")),
								),
							],
						},
					)

					expect(ttyRes.exitCode).toBe(0)
					expect(firstSigintConsumed).toBe(true)
					expect(ttyRes.stderr).toContain("Interrupt requested.")

					const queuedSigintController = makeSigintController()
					const turn1QueuedGate = yield* Deferred.make<void>()
					const releaseRefusalTurn1 = yield* Deferred.make<void>()
					const idleFrameDelivered = yield* Deferred.make<void>()
					const queuedCli = yield* makeTestServer({
						generate: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(turn1QueuedGate, undefined)
								yield* Deferred.await(releaseRefusalTurn1)
								return {
									thinking: null,
									text: "Refused turn 1",
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "refusal" as const },
								}
							}),
					})
					const queuedSessionId = yield* createReadySession(queuedCli)
					let sigintAfterRefusalConsumed = true
					let queuedTurnReceipt: number | undefined
					const queuedTtyRes = yield* queuedCli.run(
						["sessions", "connect", "--session-id", queuedSessionId],
						{
							stdinIsTerminal: true,
							sigintController: queuedSigintController,
							interceptFetch: async (next, request) => {
								const res = await next(request)
								if (request.method === "POST" && request.url.endsWith("/events")) {
									const clone = res.clone()
									const parsed = (await clone.json().catch(() => undefined)) as
										| { data?: Array<{ turn?: number }> }
										| undefined
									const turn = parsed?.data?.[0]?.turn
									if (turn !== undefined) {
										queuedTurnReceipt = turn
									}
									return res
								}
								if (
									!request.url.includes("/events/stream") ||
									res.status !== 200 ||
									res.body === null
								) {
									return res
								}
								const reader = res.body.getReader()
								const decoder = new TextDecoder()
								let idleSignaled = false
								const observed = new ReadableStream<Uint8Array>({
									async pull(controller) {
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										const text = decoder.decode(chunk.value, { stream: true })
										controller.enqueue(chunk.value)
										if (!idleSignaled && text.includes("session.status_idle")) {
											idleSignaled = true
											await runPromise(Deferred.succeed(idleFrameDelivered, undefined))
										}
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(observed, { status: 200, headers: res.headers })
							},
							terminalReads: [
								Effect.succeed("start turn 1"),
								Deferred.await(turn1QueuedGate).pipe(Effect.as("queue turn 2")),
								Deferred.succeed(releaseRefusalTurn1, undefined).pipe(
									Effect.andThen(Deferred.await(idleFrameDelivered)),
									Effect.andThen(Effect.sleep("30 millis")),
									Effect.andThen(
										Effect.sync(() => {
											sigintAfterRefusalConsumed = queuedSigintController.handleSigint()
										}),
									),
									Effect.as("/exit"),
								),
							],
						},
					)
					expect(queuedTtyRes.exitCode).toBe(0)
					expect(queuedTurnReceipt).toBe(2)
					expect(sigintAfterRefusalConsumed).toBe(false)
					expect(queuedTtyRes.stderr).toContain("[status: idle (refusal)]")
					expect(queuedTtyRes.stderr).not.toContain("Interrupt requested.")

					const liveArchiveCli = yield* makeTestServer()
					const liveArchiveSessionId = yield* createReadySession(liveArchiveCli)
					const streamConnected = yield* Deferred.make<void>()
					const archiver = yield* Deferred.await(streamConnected).pipe(
						Effect.andThen(Effect.sleep("20 millis")),
						Effect.andThen(
							liveArchiveCli.run(["sessions", "archive", "--session-id", liveArchiveSessionId]),
						),
						Effect.forkChild,
					)
					const liveArchiveRes = yield* liveArchiveCli.run(
						["--format", "jsonl", "sessions", "connect", "--session-id", liveArchiveSessionId],
						{
							stdin: Stream.never,
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								await runPromise(Deferred.succeed(streamConnected, undefined))
								const real = await next(request)
								if (real.status !== 200 || real.body === null) {
									return real
								}
								const reader = real.body.getReader()
								const decoder = new TextDecoder()
								const encoder = new TextEncoder()
								let buf = ""
								const spaced = new ReadableStream<Uint8Array>({
									async pull(controller) {
										while (true) {
											const boundary = buf.indexOf("\n\n")
											if (boundary !== -1) {
												const frame = buf.slice(0, boundary + 2)
												buf = buf.slice(boundary + 2)
												if (frame.includes("session.archived")) {
													await new Promise((resolve) => {
														setTimeout(resolve, 40)
													})
												}
												controller.enqueue(encoder.encode(frame))
												return
											}
											const chunk = await reader.read()
											if (chunk.done) {
												if (buf.length > 0) {
													controller.enqueue(encoder.encode(buf))
													buf = ""
												}
												controller.close()
												return
											}
											buf += decoder.decode(chunk.value, { stream: true })
										}
									},
								})
								return new Response(spaced, { status: 200, headers: real.headers })
							},
						},
					)
					yield* Fiber.await(archiver)
					expect(liveArchiveRes.exitCode).toBe(0)
					const emittedTypes = liveArchiveRes.stdout
						.trim()
						.split("\n")
						.map((line) => (JSON.parse(line) as { type: string }).type)
					expect(emittedTypes).toContain("session.status_terminated")
					expect(emittedTypes).toContain("session.archived")
				}),
			),
		)
	})

	it("interrupts accepted turns before SSE catches up, retries/reports idempotency keys on unconfirmed sends, and preserves matching historical messages", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const idleCtrlCSigint = makeSigintController()
					const idleTurnStarted = yield* Deferred.make<void>()
					const idleTurnInterrupted = yield* Deferred.make<void>()
					const idleCtrlCCli = yield* makeTestServer({
						generate: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(idleTurnStarted, undefined)
								yield* Deferred.await(idleTurnInterrupted)
								return yield* Effect.fail({
									_tag: "TurnInterrupted" as const,
									model_usage: { input_tokens: 2, output_tokens: 0 },
								})
							}),
						interrupt: () => Deferred.succeed(idleTurnInterrupted, undefined).pipe(Effect.asVoid),
					})
					const idleCtrlCSessionId = yield* createReadySession(idleCtrlCCli)
					let releaseIdleSse: (() => void) | undefined
					const idleSseGate = new Promise<void>((resolve) => {
						releaseIdleSse = resolve
					})
					let sigintBeforeRunningConsumed = false
					const idleCtrlCRes = yield* idleCtrlCCli.run(
						["sessions", "connect", "--session-id", idleCtrlCSessionId],
						{
							stdinIsTerminal: true,
							sigintController: idleCtrlCSigint,
							interceptFetch: async (next, request) => {
								if (request.url.includes("/events/stream")) {
									await idleSseGate
								}
								return next(request)
							},
							terminalReads: [
								Effect.succeed("start from idle"),
								Deferred.await(idleTurnStarted).pipe(
									Effect.andThen(
										Effect.sync(() => {
											sigintBeforeRunningConsumed = idleCtrlCSigint.handleSigint()
										}),
									),
									Effect.andThen(Deferred.await(idleTurnInterrupted)),
									Effect.andThen(Effect.sync(() => releaseIdleSse?.())),
									Effect.andThen(Effect.sleep("25 millis")),
									Effect.as("/exit"),
								),
							],
						},
					)
					expect(idleCtrlCRes.exitCode).toBe(0)
					expect(sigintBeforeRunningConsumed).toBe(true)
					expect(idleCtrlCRes.stderr).toContain("Interrupt requested.")

					let retryGenerateCalls = 0
					const retrySendCli = yield* makeTestServer({
						generate: (args) =>
							Effect.sync(() => {
								retryGenerateCalls++
								return {
									thinking: null,
									text: `Ack:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const retrySessionId = yield* createReadySession(retrySendCli)
					const retryKeys: Array<string | null> = []
					const retryRes = yield* retrySendCli.run(
						["sessions", "connect", "--session-id", retrySessionId],
						{
							stdin: "only once\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									retryKeys.push(request.headers.get("idempotency-key"))
									const res = await next(request)
									if (retryKeys.length === 1) {
										throw new TypeError("simulated dropped response after commit")
									}
									return res
								}
								return next(request)
							},
						},
					)
					expect(retryRes.exitCode).toBe(0)
					expect(retryKeys).toHaveLength(2)
					expect(retryKeys[0]).toMatch(/^cli_[0-9a-f]{24}$/)
					expect(retryKeys[1]).toBe(retryKeys[0])
					expect(retryGenerateCalls).toBe(1)
					expect(retryRes.stdout).toContain("Ack:only once")

					const unconfirmedKeys: Array<string | null> = []
					const unconfirmedRes = yield* retrySendCli.run(
						["sessions", "connect", "--session-id", retrySessionId],
						{
							stdin: "unconfirmed line\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									unconfirmedKeys.push(request.headers.get("idempotency-key"))
									throw new TypeError("simulated persistent network drop")
								}
								return next(request)
							},
						},
					)
					expect(unconfirmedRes.exitCode).toBe(1)
					expect(unconfirmedKeys.length).toBe(3)
					expect(new Set(unconfirmedKeys).size).toBe(1)
					const usedKey = unconfirmedKeys[0] ?? ""
					expect(usedKey).toMatch(/^cli_[0-9a-f]{24}$/)
					expect(unconfirmedRes.stderr).toContain(`Idempotency-Key: ${usedKey}`)

					const echoCli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `Reply-${args.turn}:${args.input.join("|")}`,
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const echoSessionId = yield* createReadySession(echoCli)
					const firstSend = yield* echoCli.run(
						["sessions", "connect", "--session-id", echoSessionId],
						{ stdin: "same text\n" },
					)
					expect(firstSend.exitCode).toBe(0)

					let releaseHistoryReplay: (() => void) | undefined
					const historyReplayGate = new Promise<void>((resolve) => {
						releaseHistoryReplay = resolve
					})
					const secondSend = yield* echoCli.run(
						["sessions", "connect", "--session-id", echoSessionId],
						{
							stdin: "same text\n",
							interceptFetch: async (next, request) => {
								if (request.url.includes("/events/stream")) {
									await historyReplayGate
									return next(request)
								}
								if (request.method === "POST" && request.url.endsWith("/events")) {
									const res = await next(request)
									releaseHistoryReplay?.()
									return res
								}
								return next(request)
							},
						},
					)
					expect(secondSend.exitCode).toBe(0)
					expect(secondSend.stdout.trim().split("\n")).toEqual([
						"[user] same text",
						"Reply-1:same text",
						"[user] same text",
						"Reply-2:same text",
					])

					let decodeRetryGenerates = 0
					const decodeRetryCli = yield* makeTestServer({
						generate: (args) =>
							Effect.sync(() => {
								decodeRetryGenerates++
								return {
									thinking: null,
									text: `Decoded:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const decodeRetrySessionId = yield* createReadySession(decodeRetryCli)
					const decodeRetryKeys: Array<string | null> = []
					const decodeRetryRes = yield* decodeRetryCli.run(
						["sessions", "connect", "--session-id", decodeRetrySessionId],
						{
							stdin: "truncated body retry\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									decodeRetryKeys.push(request.headers.get("idempotency-key"))
									const real = await next(request)
									if (decodeRetryKeys.length === 1) {
										return new Response('{"data":[{"type":"user.', {
											status: 200,
											headers: { "content-type": "application/json" },
										})
									}
									return real
								}
								return next(request)
							},
						},
					)
					expect(decodeRetryRes.exitCode).toBe(0)
					expect(decodeRetryKeys).toHaveLength(2)
					expect(decodeRetryKeys[1]).toBe(decodeRetryKeys[0])
					expect(decodeRetryGenerates).toBe(1)
					expect(decodeRetryRes.stdout).toContain("Decoded:truncated body retry")

					const bodyDropKeys: Array<string | null> = []
					const bodyDropRes = yield* decodeRetryCli.run(
						["sessions", "connect", "--session-id", decodeRetrySessionId],
						{
							stdin: "dropped body stream\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									bodyDropKeys.push(request.headers.get("idempotency-key"))
									const real = await next(request)
									if (bodyDropKeys.length === 1) {
										const failingBody = new ReadableStream<Uint8Array>({
											pull(controller) {
												controller.error(new TypeError("connection reset mid-body"))
											},
										})
										return new Response(failingBody, {
											status: 200,
											headers: { "content-type": "application/json" },
										})
									}
									return real
								}
								return next(request)
							},
						},
					)
					expect(bodyDropRes.exitCode).toBe(0)
					expect(bodyDropKeys).toHaveLength(2)
					expect(bodyDropKeys[1]).toBe(bodyDropKeys[0])
					expect(decodeRetryGenerates).toBe(2)
					expect(bodyDropRes.stdout).toContain("Decoded:dropped body stream")

					const gateway502Keys: Array<string | null> = []
					const gateway502Res = yield* decodeRetryCli.run(
						["sessions", "connect", "--session-id", decodeRetrySessionId],
						{
							stdin: "gateway 502 line\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									gateway502Keys.push(request.headers.get("idempotency-key"))
									return new Response("Bad Gateway", {
										status: 502,
										headers: { "content-type": "text/plain" },
									})
								}
								return next(request)
							},
						},
					)
					expect(gateway502Res.exitCode).toBe(1)
					expect(gateway502Keys).toHaveLength(3)
					expect(new Set(gateway502Keys).size).toBe(1)
					const key502 = gateway502Keys[0] ?? ""
					expect(key502).toMatch(/^cli_[0-9a-f]{24}$/)
					expect(gateway502Res.stderr).toContain(`Idempotency-Key: ${key502}`)

					const archiveLookupCli = yield* makeTestServer()
					const archiveLookupSessionId = yield* createReadySession(archiveLookupCli)
					const archiveLookupConnected = yield* Deferred.make<void>()
					const liveArchiver = yield* Deferred.await(archiveLookupConnected).pipe(
						Effect.andThen(Effect.sleep("20 millis")),
						Effect.andThen(
							archiveLookupCli.run(["sessions", "archive", "--session-id", archiveLookupSessionId]),
						),
						Effect.forkChild,
					)
					let sessionGetCount = 0
					const archiveLookupRes = yield* archiveLookupCli.run(
						["--format", "jsonl", "sessions", "connect", "--session-id", archiveLookupSessionId],
						{
							stdin: Stream.never,
							interceptFetch: async (next, request) => {
								if (request.url.includes("/events/stream")) {
									await runPromise(Deferred.succeed(archiveLookupConnected, undefined))
									return next(request)
								}
								if (
									request.method === "GET" &&
									request.url.endsWith(`/sessions/${archiveLookupSessionId}`)
								) {
									sessionGetCount++
									if (sessionGetCount > 1) {
										return new Response("Bad Gateway", {
											status: 502,
											headers: { "content-type": "text/plain" },
										})
									}
								}
								return next(request)
							},
						},
					)
					yield* Fiber.await(liveArchiver)
					expect(archiveLookupRes.exitCode).toBe(1)
					expect(sessionGetCount).toBe(4)
					expect(archiveLookupRes.stderr.length).toBeGreaterThan(0)

					const endedEncoder = new TextEncoder()
					const replayFinishedForInput = yield* Deferred.make<void>()
					const lateInputRes = yield* archiveLookupCli.run(
						["--format", "jsonl", "sessions", "connect", "--session-id", archiveLookupSessionId],
						{
							onStdoutChunk: (chunk) =>
								chunk.includes("session.archived")
									? Deferred.succeed(replayFinishedForInput, undefined).pipe(Effect.asVoid)
									: Effect.void,
							stdin: Stream.fromEffect(
								Deferred.await(replayFinishedForInput).pipe(
									Effect.andThen(Effect.sleep("40 millis")),
									Effect.as(endedEncoder.encode("message arriving after replay\n")),
								),
							),
						},
					)
					expect(lateInputRes.exitCode).toBe(1)
					expect(lateInputRes.stderr).toContain(
						`Cannot send input: session ${archiveLookupSessionId} is already archived.`,
					)

					const replayFinishedForPartial = yield* Deferred.make<void>()
					const latePartialRes = yield* archiveLookupCli.run(
						["--format", "jsonl", "sessions", "connect", "--session-id", archiveLookupSessionId],
						{
							onStdoutChunk: (chunk) =>
								chunk.includes("session.archived")
									? Deferred.succeed(replayFinishedForPartial, undefined).pipe(Effect.asVoid)
									: Effect.void,
							stdin: Stream.concat(
								Stream.fromEffect(
									Deferred.await(replayFinishedForPartial).pipe(
										Effect.andThen(Effect.sleep("40 millis")),
										Effect.as(endedEncoder.encode("partial after replay without newline")),
									),
								),
								Stream.never,
							),
						},
					)
					expect(latePartialRes.exitCode).toBe(1)
					expect(latePartialRes.stderr).toContain(
						`Cannot send input: session ${archiveLookupSessionId} is already archived.`,
					)

					const replayFinishedForEof = yield* Deferred.make<void>()
					const delayedEofRes = yield* archiveLookupCli.run(
						["--format", "jsonl", "sessions", "connect", "--session-id", archiveLookupSessionId],
						{
							onStdoutChunk: (chunk) =>
								chunk.includes("session.archived")
									? Deferred.succeed(replayFinishedForEof, undefined).pipe(Effect.asVoid)
									: Effect.void,
							stdin: Stream.unwrap(
								Deferred.await(replayFinishedForEof).pipe(
									Effect.andThen(Effect.sleep("40 millis")),
									Effect.as(Stream.empty),
								),
							),
						},
					)
					expect(delayedEofRes.exitCode).toBe(0)
					const delayedEofTypes = delayedEofRes.stdout
						.trim()
						.split("\n")
						.map((line) => (JSON.parse(line) as { type: string }).type)
					expect(delayedEofTypes).toContain("session.archived")

					const replayFinishedForExit = yield* Deferred.make<void>()
					const delayedExitRes = yield* archiveLookupCli.run(
						["--format", "jsonl", "sessions", "connect", "--session-id", archiveLookupSessionId],
						{
							onStdoutChunk: (chunk) =>
								chunk.includes("session.archived")
									? Deferred.succeed(replayFinishedForExit, undefined).pipe(Effect.asVoid)
									: Effect.void,
							stdin: Stream.concat(
								Stream.fromEffect(
									Deferred.await(replayFinishedForExit).pipe(
										Effect.andThen(Effect.sleep("40 millis")),
										Effect.as(endedEncoder.encode("/exit\n")),
									),
								),
								Stream.never,
							),
						},
					)
					expect(delayedExitRes.exitCode).toBe(0)

					for (const badBody of [
						{ data: [] },
						{ data: [{ type: "user.message" }] },
						{ data: [{ turn: 7 }] },
						{ data: [{ type: "user.interrupt", turn: 7 }] },
					]) {
						let capturedKey = ""
						const badReceiptRes = yield* decodeRetryCli.run(
							["sessions", "connect", "--session-id", decodeRetrySessionId],
							{
								stdin: "missing turn receipt\n",
								interceptFetch: async (next, request) => {
									if (request.method === "POST" && request.url.endsWith("/events")) {
										capturedKey = request.headers.get("idempotency-key") ?? ""
										return new Response(JSON.stringify(badBody), {
											status: 200,
											headers: { "content-type": "application/json" },
										})
									}
									return next(request)
								},
							},
						)
						expect(badReceiptRes.exitCode).toBe(1)
						expect(capturedKey).toMatch(/^cli_[0-9a-f]{24}$/)
						expect(badReceiptRes.stderr).toContain(`Idempotency-Key: ${capturedKey}`)
					}
				}),
			),
		)
	})

	it("ignores delayed queued receipts after refusal and resumes near head without scanning from seq 0", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const delayedReceiptSigint = makeSigintController()
					const delayedTurn1Running = yield* Deferred.make<void>()
					const releaseDelayedTurn1 = yield* Deferred.make<void>()
					const delayedIdleDelivered = yield* Deferred.make<void>()
					const delayedCli = yield* makeTestServer({
						generate: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(delayedTurn1Running, undefined)
								yield* Deferred.await(releaseDelayedTurn1)
								return {
									thinking: null,
									text: "Refused turn 1",
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "refusal" as const },
								}
							}),
					})
					const delayedSessionId = yield* createReadySession(delayedCli)
					let delayedPosts = 0
					let sigintAfterDelayedReceipt = true
					const delayedRes = yield* delayedCli.run(
						["sessions", "connect", "--session-id", delayedSessionId],
						{
							stdinIsTerminal: true,
							sigintController: delayedReceiptSigint,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									delayedPosts++
									const res = await next(request)
									if (delayedPosts === 2) {
										await runPromise(Deferred.succeed(releaseDelayedTurn1, undefined))
										await runPromise(Deferred.await(delayedIdleDelivered))
										await new Promise((resolve) => {
											setTimeout(resolve, 30)
										})
									}
									return res
								}
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								const res = await next(request)
								if (res.status !== 200 || res.body === null) {
									return res
								}
								const reader = res.body.getReader()
								const decoder = new TextDecoder()
								let idleSignaled = false
								const observed = new ReadableStream<Uint8Array>({
									async pull(controller) {
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										const text = decoder.decode(chunk.value, { stream: true })
										controller.enqueue(chunk.value)
										if (!idleSignaled && text.includes("session.status_idle")) {
											idleSignaled = true
											await runPromise(Deferred.succeed(delayedIdleDelivered, undefined))
										}
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(observed, { status: 200, headers: res.headers })
							},
							terminalReads: [
								Effect.succeed("start turn 1"),
								Deferred.await(delayedTurn1Running).pipe(Effect.as("queue turn 2")),
								Effect.sync(() => {
									sigintAfterDelayedReceipt = delayedReceiptSigint.handleSigint()
								}).pipe(Effect.as("/exit")),
							],
						},
					)
					expect(delayedRes.exitCode).toBe(0)
					expect(delayedPosts).toBe(2)
					expect(sigintAfterDelayedReceipt).toBe(false)
					expect(delayedRes.stderr).not.toContain("Interrupt requested.")

					const resumeCli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `T${args.turn}:${args.input.join("|")}`,
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const resumeSessionId = yield* createReadySession(resumeCli)
					for (const msg of ["one", "two", "three"]) {
						const turnRes = yield* resumeCli.run(
							["sessions", "connect", "--session-id", resumeSessionId],
							{ stdin: `${msg}\n` },
						)
						expect(turnRes.exitCode).toBe(0)
					}
					const latestList = yield* resumeCli.run([
						"sessions:events",
						"list",
						"--session-id",
						resumeSessionId,
						"--limit",
						"1",
						"--order",
						"desc",
					])
					const headSeq =
						(JSON.parse(latestList.stdout) as { data: Array<{ seq: number }> }).data[0]?.seq ?? 0
					expect(headSeq).toBeGreaterThan(5)

					const ascQueries: Array<string> = []
					const descBaselineQueries: Array<string> = []
					const resumed = yield* resumeCli.run(
						["sessions", "connect", "--session-id", resumeSessionId, "--after", String(headSeq)],
						{
							stdin: "four\n",
							interceptFetch: async (next, request) => {
								const url = new URL(request.url)
								if (request.method === "GET" && url.pathname.endsWith("/events")) {
									if (url.searchParams.get("order") === "asc") {
										ascQueries.push(url.search)
									} else if (
										url.searchParams.get("order") === "desc" &&
										url.searchParams.get("after") !== null
									) {
										descBaselineQueries.push(url.search)
									}
								}
								return next(request)
							},
						},
					)
					expect(resumed.exitCode).toBe(0)
					expect(resumed.stdout).toContain("T4:four")
					expect(resumed.stdout).not.toContain("T1:one")
					expect(ascQueries).toHaveLength(0)
					expect(descBaselineQueries).toHaveLength(1)
					expect(descBaselineQueries[0]).toContain(`after=${headSeq + 1}`)
				}),
			),
		)
	})

	it("reports idempotency keys on interrupted sends, bounds oversized piped lines while streaming, and exits a real Bun subprocess on /exit with open stdin", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const intCli = yield* makeTestServer()
					const intSessionId = yield* createReadySession(intCli)
					const postInFlight = yield* Deferred.make<void>()
					let interruptedKey = ""
					const archiverFiber = yield* Deferred.await(postInFlight).pipe(
						Effect.andThen(intCli.run(["sessions", "archive", "--session-id", intSessionId])),
						Effect.forkChild,
					)
					const intRes = yield* intCli.run(["sessions", "connect", "--session-id", intSessionId], {
						stdin: "in flight message\n",
						interceptFetch: async (next, request) => {
							if (request.method === "POST" && request.url.endsWith("/events")) {
								interruptedKey = request.headers.get("idempotency-key") ?? ""
								await runPromise(Deferred.succeed(postInFlight, undefined))
								return await new Promise<Response>((_resolve, reject) => {
									const abort = () => reject(new DOMException("Aborted", "AbortError"))
									if (request.signal.aborted) {
										abort()
										return
									}
									request.signal.addEventListener("abort", abort, { once: true })
								})
							}
							return next(request)
						},
					})
					yield* Fiber.await(archiverFiber)
					expect(intRes.exitCode).toBe(1)
					expect(interruptedKey).toMatch(/^cli_[0-9a-f]{24}$/)
					expect(intRes.stderr).toContain(`Idempotency-Key: ${interruptedKey}`)

					const encoder = new TextEncoder()
					const chunk1k = encoder.encode("a".repeat(1024))
					let activeChunksPulled = 0
					const hugeActiveStdin = Stream.unfold(0, (count) =>
						Effect.sync(() => {
							activeChunksPulled++
							return [chunk1k, count + 1] as const
						}),
					)
					const activeSessId = yield* createReadySession(intCli)
					const hugeActiveRes = yield* intCli.run(
						["sessions", "connect", "--session-id", activeSessId],
						{ stdin: hugeActiveStdin },
					)
					expect(hugeActiveRes.exitCode).toBe(1)
					expect(hugeActiveRes.stderr).toContain("exceeds maximum message length")
					expect(activeChunksPulled).toBeLessThanOrEqual(20)

					let endedChunksPulled = 0
					const hugeEndedStdin = Stream.unfold(0, (count) =>
						Effect.sync(() => {
							endedChunksPulled++
							return [chunk1k, count + 1] as const
						}),
					)
					const hugeEndedRes = yield* intCli.run(
						["sessions", "connect", "--session-id", intSessionId],
						{ stdin: hugeEndedStdin },
					)
					expect(hugeEndedRes.exitCode).toBe(1)
					expect(hugeEndedRes.stderr).toContain("exceeds maximum message length")
					expect(endedChunksPulled).toBeLessThanOrEqual(20)
				}),
			),
		)

		const cliCommand = (cliArgs: ReadonlyArray<string>): readonly [string, Array<string>] => [
			"bun",
			[...PINNED_BUN_FLAGS, fileURLToPath(new URL("../src/main.ts", import.meta.url)), ...cliArgs],
		]
		const openSseResponses: Array<Http.ServerResponse> = []
		let redirectTargetGetHits = 0
		const server = Http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (req.method === "POST" && url.pathname === "/v1/agents/agent_redirect") {
				res.writeHead(302, { location: "/v1/agents/agent_redirect" })
				res.end()
				return
			}
			if (req.method === "GET" && url.pathname === "/v1/agents/agent_redirect") {
				redirectTargetGetHits++
				res.writeHead(200, { "content-type": "application/json" })
				res.end(
					JSON.stringify({
						id: "agent_redirect",
						type: "agent",
						version: 1,
						name: "Unchanged",
						description: null,
						system: null,
						model: { id: "gpt-6.2-sol" },
						created_at: "2026-11-22T00:00:00.000Z",
						updated_at: "2026-11-22T00:00:00.000Z",
						archived_at: null,
					}),
				)
				return
			}
			if (req.method === "GET" && url.pathname === "/v1/sessions/sess_subproc") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(
					JSON.stringify({
						id: "sess_subproc",
						type: "session",
						resources: [],
						status: "idle",
						agent: { id: "agent_1", version: 1 },
						environment_id: "env_1",
						title: null,
						turn: 0,
						usage: { input_tokens: 0, output_tokens: 0 },
						created_at: "2026-11-22T00:00:00.000Z",
						updated_at: "2026-11-22T00:00:00.000Z",
						archived_at: null,
					}),
				)
				return
			}
			if (req.method === "GET" && url.pathname === "/v1/sessions/sess_subproc/events") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ data: [], has_more: false, next_cursor: null }))
				return
			}
			if (req.method === "GET" && url.pathname === "/v1/sessions/sess_subproc/events/stream") {
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
				})
				res.write(": keepalive\n\n")
				openSseResponses.push(res)
				return
			}
			res.writeHead(404, { "content-type": "application/json" })
			res.end(
				JSON.stringify({
					type: "error",
					error: { type: "not_found_error", message: "not found" },
					request_id: "req_subproc",
				}),
			)
		})

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve)
		})
		try {
			const addr = server.address()
			const port = typeof addr === "object" && addr !== null ? addr.port : 0

			const exitCode = await new Promise<number | null>((resolve, reject) => {
				const [cmd, cmdArgs] = cliCommand([
					"sessions",
					"connect",
					"--session-id",
					"sess_subproc",
					"--base-url",
					`http://127.0.0.1:${port}`,
				])
				const child = spawn(cmd, cmdArgs, {
					env: cliProcessEnv({ CHECKFU_API_KEY: "ck_subproc" }),
					stdio: ["pipe", "pipe", "pipe"],
				})
				let stderr = ""
				let sentExit = false
				const timer = setTimeout(() => {
					child.kill("SIGKILL")
					reject(new Error(`Subprocess hung with open stdin. stderr=${stderr}`))
				}, 3000)

				child.stderr.setEncoding("utf8")
				child.stderr.on("data", (chunk: string) => {
					stderr += chunk
					if (!sentExit && stderr.includes("Connected to sess_subproc")) {
						sentExit = true
						child.stdin.write("/exit\n")
					}
				})
				child.on("error", (err) => {
					clearTimeout(timer)
					reject(err)
				})
				child.on("close", (code) => {
					clearTimeout(timer)
					child.stdin.end()
					resolve(code)
				})
			})
			expect(exitCode).toBe(0)

			const badDotSubproc = await new Promise<{
				readonly code: number | null
				readonly stdout: string
				readonly stderr: string
			}>((resolve, reject) => {
				const [cmd, cmdArgs] = cliCommand([
					"agents",
					"retrieve",
					"--agent-id",
					"..",
					"--base-url",
					`http://127.0.0.1:${port}`,
				])
				const child = spawn(cmd, cmdArgs, {
					env: cliProcessEnv({ CHECKFU_API_KEY: "ck_subproc" }),
					stdio: ["ignore", "pipe", "pipe"],
				})
				let stdout = ""
				let stderr = ""
				child.stdout.setEncoding("utf8")
				child.stdout.on("data", (c: string) => {
					stdout += c
				})
				child.stderr.setEncoding("utf8")
				child.stderr.on("data", (c: string) => {
					stderr += c
				})
				child.on("error", reject)
				child.on("close", (code) => resolve({ code, stdout, stderr }))
			})
			expect(badDotSubproc.code).toBe(1)
			expect(badDotSubproc.stdout).toBe("")
			expect(badDotSubproc.stderr).toContain("Invalid --agent-id")

			const redirectSubproc = await new Promise<{
				readonly code: number | null
				readonly stdout: string
				readonly stderr: string
			}>((resolve, reject) => {
				const [cmd, cmdArgs] = cliCommand([
					"agents",
					"update",
					"--agent-id",
					"agent_redirect",
					"--current-version",
					"1",
					"--name",
					"ShouldNotChange",
					"--base-url",
					`http://127.0.0.1:${port}`,
				])
				const child = spawn(cmd, cmdArgs, {
					env: cliProcessEnv({ CHECKFU_API_KEY: "ck_subproc" }),
					stdio: ["ignore", "pipe", "pipe"],
				})
				let stdout = ""
				let stderr = ""
				child.stdout.setEncoding("utf8")
				child.stdout.on("data", (c: string) => {
					stdout += c
				})
				child.stderr.setEncoding("utf8")
				child.stderr.on("data", (c: string) => {
					stderr += c
				})
				child.on("error", reject)
				child.on("close", (code) => resolve({ code, stdout, stderr }))
			})
			expect(redirectSubproc.code).toBe(1)
			expect(redirectSubproc.stdout).toBe("")
			expect(redirectSubproc.stderr).toContain("302")
			expect(redirectTargetGetHits).toBe(0)
		} finally {
			for (const res of openSseResponses) {
				res.end()
			}
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve()
				})
			})
		}
	}, 15_000)

	it("handles replayed refusal before a fresh turn, preserves uncertainty across retry errors, stops stalled TTY sends on archive, and flushes valid lines before chunk overflow", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const replayRefusalCli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: args.turn === 1 ? "Refused-1" : "Accepted-2",
								input_tokens: 2,
								output_tokens: 2,
								stop_reason:
									args.turn === 1
										? ({ type: "refusal" } as const)
										: ({ type: "end_turn" } as const),
							}),
					})
					const replayRefusalSessionId = yield* createReadySession(replayRefusalCli)
					const turn1Refusal = yield* replayRefusalCli.run(
						["sessions", "connect", "--session-id", replayRefusalSessionId],
						{ stdin: "first turn\n" },
					)
					expect(turn1Refusal.exitCode).toBe(0)

					let releaseRefusalReplay: (() => void) | undefined
					const refusalReplayGate = new Promise<void>((resolve) => {
						releaseRefusalReplay = resolve
					})
					let sessionGets = 0
					let staleSnapshotBody = ""
					const turn2AfterRefusal = yield* replayRefusalCli.run(
						["sessions", "connect", "--session-id", replayRefusalSessionId],
						{
							stdin: "second turn\n",
							interceptFetch: async (next, request) => {
								if (
									request.method === "GET" &&
									request.url.endsWith(`/sessions/${replayRefusalSessionId}`)
								) {
									sessionGets++
									const real = await next(request)
									if (sessionGets === 1) {
										staleSnapshotBody = await real.clone().text()
										return real
									}
									return new Response(staleSnapshotBody, {
										status: 200,
										headers: { "content-type": "application/json" },
									})
								}
								if (request.url.includes("/events/stream")) {
									await refusalReplayGate
									return next(request)
								}
								if (request.method === "POST" && request.url.endsWith("/events")) {
									const res = await next(request)
									releaseRefusalReplay?.()
									return res
								}
								return next(request)
							},
						},
					)
					expect(turn2AfterRefusal.exitCode).toBe(0)
					expect(turn2AfterRefusal.stdout).toContain("Accepted-2")

					const rotatedKeys: Array<string> = []
					const rotatedRes = yield* replayRefusalCli.run(
						["sessions", "connect", "--session-id", replayRefusalSessionId],
						{
							stdin: "ambiguous then 401\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									rotatedKeys.push(request.headers.get("idempotency-key") ?? "")
									if (rotatedKeys.length === 1) {
										throw new TypeError("lost response after commit")
									}
									return new Response(
										JSON.stringify({
											type: "error",
											error: { type: "authentication_error", message: "key rotated" },
											request_id: "req_401",
										}),
										{ status: 401, headers: { "content-type": "application/json" } },
									)
								}
								return next(request)
							},
						},
					)
					expect(rotatedRes.exitCode).toBe(1)
					expect(rotatedKeys).toHaveLength(2)
					expect(rotatedKeys[1]).toBe(rotatedKeys[0])
					expect(rotatedRes.stderr).toContain(`Idempotency-Key: ${rotatedKeys[0]}`)

					const stalledTtySessionId = yield* createReadySession(replayRefusalCli)
					const ttyPostStalled = yield* Deferred.make<void>()
					let ttyInterruptedKey = ""
					const ttyArchiver = yield* Deferred.await(ttyPostStalled).pipe(
						Effect.andThen(
							replayRefusalCli.run(["sessions", "archive", "--session-id", stalledTtySessionId]),
						),
						Effect.forkChild,
					)
					const stalledTtyRes = yield* replayRefusalCli.run(
						["sessions", "connect", "--session-id", stalledTtySessionId],
						{
							stdinIsTerminal: true,
							terminalReads: [Effect.succeed("stalled tty send")],
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									ttyInterruptedKey = request.headers.get("idempotency-key") ?? ""
									await runPromise(Deferred.succeed(ttyPostStalled, undefined))
									return await new Promise<Response>((_resolve, reject) => {
										const abort = () => reject(new DOMException("Aborted", "AbortError"))
										if (request.signal.aborted) {
											abort()
											return
										}
										request.signal.addEventListener("abort", abort, { once: true })
									})
								}
								return next(request)
							},
						},
					)
					yield* Fiber.await(ttyArchiver)
					expect(stalledTtyRes.exitCode).toBe(1)
					expect(ttyInterruptedKey).toMatch(/^cli_[0-9a-f]{24}$/)
					expect(stalledTtyRes.stderr).toContain(`Idempotency-Key: ${ttyInterruptedKey}`)

					const chunkExitSessId = yield* createReadySession(replayRefusalCli)
					const exitBeforeOverflow = yield* replayRefusalCli.run(
						["sessions", "connect", "--session-id", chunkExitSessId],
						{ stdin: `/exit\n${"a".repeat(20_000)}` },
					)
					expect(exitBeforeOverflow.exitCode).toBe(0)

					const sentPayloads: Array<string> = []
					const validBeforeOverflow = yield* replayRefusalCli.run(
						["sessions", "connect", "--session-id", chunkExitSessId],
						{
							stdin: `valid first line\n${"a".repeat(20_000)}`,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									sentPayloads.push(await request.clone().text())
								}
								return next(request)
							},
						},
					)
					expect(validBeforeOverflow.exitCode).toBe(1)
					expect(validBeforeOverflow.stderr).toContain("exceeds maximum message length")
					expect(sentPayloads).toHaveLength(1)
					expect(sentPayloads[0]).toContain("valid first line")

					const transientRecoverCli = yield* makeTestServer({
						generate: () =>
							Effect.succeed({
								thinking: null,
								text: "Recovered reply",
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const transientSessionId = yield* createReadySession(transientRecoverCli)
					const turn1Settled = yield* Deferred.make<void>()
					const archiveAfterSettle = yield* Deferred.await(turn1Settled).pipe(
						Effect.andThen(Effect.sleep("30 millis")),
						Effect.andThen(
							transientRecoverCli.run(["sessions", "archive", "--session-id", transientSessionId]),
						),
						Effect.forkChild,
					)
					const openAfterTurnStdin = Stream.concat(
						Stream.make(new TextEncoder().encode("transient then recover\n")),
						Stream.never,
					)
					const transientArchivedRes = yield* transientRecoverCli.run(
						["sessions", "connect", "--session-id", transientSessionId],
						{
							stdin: openAfterTurnStdin,
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								const res = await next(request)
								if (res.status !== 200 || res.body === null) {
									return res
								}
								const reader = res.body.getReader()
								const decoder = new TextDecoder()
								const encoder = new TextEncoder()
								let injectedRetryErr = false
								let idleSignaled = false
								const shiftSeqs = (raw: string): string =>
									raw
										.replaceAll(/^id: (\d+)$/gm, (_m, n: string) => `id: ${Number(n) + 1}`)
										.replaceAll(/"seq":(\d+)/g, (_m, n: string) => `"seq":${Number(n) + 1}`)
								const observed = new ReadableStream<Uint8Array>({
									async pull(controller) {
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										let text = decoder.decode(chunk.value, { stream: true })
										if (injectedRetryErr) {
											text = shiftSeqs(text)
										} else if (text.includes("session.status_idle")) {
											injectedRetryErr = true
											const idleIdx = text.indexOf("event: session.status_idle")
											const frameStart = idleIdx >= 0 ? text.lastIndexOf("\n\n", idleIdx) : -1
											const prefix = frameStart >= 0 ? text.slice(0, frameStart + 2) : ""
											const suffix = frameStart >= 0 ? text.slice(frameStart + 2) : text
											const idleSeqMatch = /"seq":(\d+)/.exec(suffix)
											const errSeq = idleSeqMatch !== null ? Number(idleSeqMatch[1]) : 99
											const retryErrFrame = `id: ${errSeq}\nevent: session.error\ndata: ${JSON.stringify(
												{
													id: "evt_inject_transient",
													seq: errSeq,
													type: "session.error",
													created_at: "2026-11-22T00:00:00.000Z",
													error: {
														type: "upstream_overloaded",
														message: "transient overload",
														retry_status: { type: "retrying" },
													},
												},
											)}\n\n`
											text = `${prefix}${retryErrFrame}${shiftSeqs(suffix)}`
										}
										controller.enqueue(encoder.encode(text))
										if (!idleSignaled && text.includes("session.status_idle")) {
											idleSignaled = true
											await runPromise(Deferred.succeed(turn1Settled, undefined))
										}
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(observed, { status: 200, headers: res.headers })
							},
						},
					)
					yield* Fiber.await(archiveAfterSettle)
					expect(transientArchivedRes.exitCode).toBe(0)
					expect(transientArchivedRes.stderr).toContain(
						"[error] upstream_overloaded: transient overload",
					)
					expect(transientArchivedRes.stdout).toContain("Recovered reply")
				}),
			),
		)
	})

	it("signals the current settlement waiter after slow output and honors /exit during ended-session replay", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const waiterCli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `Reply-${args.turn}:${args.input.join("|")}`,
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const waiterSessionId = yield* createReadySession(waiterCli)
					const turn2IdleRendering = yield* Deferred.make<void>()
					let idleRenderCount = 0
					let postCount = 0
					const [waiterDuration, waiterRes] = yield* Effect.timed(
						waiterCli.run(
							["--format", "jsonl", "sessions", "connect", "--session-id", waiterSessionId],
							{
								stdin: "first\nsecond\n",
								onStdoutChunk: (chunk) =>
									Effect.gen(function* () {
										if (chunk.includes('"session.status_idle"')) {
											idleRenderCount += 1
											if (idleRenderCount === 2) {
												yield* Deferred.succeed(turn2IdleRendering, undefined)
												yield* Effect.sleep("50 millis")
											}
										}
									}),
								interceptFetch: async (next, request) => {
									if (request.method === "POST" && request.url.endsWith("/events")) {
										postCount += 1
										const res = await next(request)
										if (postCount === 2) {
											await runPromise(Deferred.await(turn2IdleRendering))
										}
										return res
									}
									return next(request)
								},
							},
						),
					)
					expect(waiterRes.exitCode).toBe(0)
					expect(postCount).toBe(2)
					expect(idleRenderCount).toBe(2)
					expect(Duration.toMillis(waiterDuration)).toBeLessThan(2000)
					expect(waiterRes.stdout).toContain("Reply-1:first")
					expect(waiterRes.stdout).toContain("Reply-2:second")

					const archiveRes = yield* waiterCli.run([
						"sessions",
						"archive",
						"--session-id",
						waiterSessionId,
					])
					expect(archiveRes.exitCode).toBe(0)

					const makeStalledReplayFetch = () => {
						const encoder = new TextEncoder()
						let postAttempts = 0
						const interceptFetch = async (
							next: (request: Request) => Promise<Response>,
							request: Request,
						): Promise<Response> => {
							if (request.method === "POST" && request.url.endsWith("/events")) {
								postAttempts += 1
								return next(request)
							}
							if (request.url.includes("/events/stream")) {
								let sent = false
								const stalledStream = new ReadableStream<Uint8Array>({
									pull(controller) {
										if (!sent) {
											sent = true
											controller.enqueue(
												encoder.encode(
													'id: 1\nevent: user.message\ndata: {"id":"evt_1","seq":1,"type":"user.message","created_at":"2026-11-22T00:00:00.000Z","content":[{"type":"text","text":"archived history"}]}\n\n',
												),
											)
											return
										}
										return new Promise(() => {})
									},
								})
								return new Response(stalledStream, {
									status: 200,
									headers: { "content-type": "text/event-stream; charset=utf-8" },
								})
							}
							return next(request)
						}
						return { interceptFetch, getPostAttempts: () => postAttempts }
					}

					for (const exitCmd of ["/exit\n", "  \n/quit\n"]) {
						const stalled = makeStalledReplayFetch()
						const [elapsed, pipedExitRes] = yield* Effect.timed(
							waiterCli.run(["sessions", "connect", "--session-id", waiterSessionId], {
								stdin: exitCmd,
								interceptFetch: stalled.interceptFetch,
							}),
						)
						expect(pipedExitRes.exitCode).toBe(0)
						expect(Duration.toMillis(elapsed)).toBeLessThan(1000)
						expect(stalled.getPostAttempts()).toBe(0)
					}

					const ttyStalled = makeStalledReplayFetch()
					const [ttyElapsed, ttyExitRes] = yield* Effect.timed(
						waiterCli.run(["sessions", "connect", "--session-id", waiterSessionId], {
							stdinIsTerminal: true,
							terminalReads: [Effect.succeed("cannot send"), Effect.succeed("/exit")],
							interceptFetch: ttyStalled.interceptFetch,
						}),
					)
					expect(ttyExitRes.exitCode).toBe(0)
					expect(Duration.toMillis(ttyElapsed)).toBeLessThan(1000)
					expect(ttyStalled.getPostAttempts()).toBe(0)
					expect(ttyExitRes.stderr).toContain(
						`Cannot send input: session ${waiterSessionId} is already archived`,
					)
				}),
			),
		)
	})

	it("reports buffered non-newline input on ended sessions and never suppresses another client's matching message", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const encoder = new TextEncoder()
					const cli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `Reply-${args.turn}:${args.input.join("|")}`,
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const endedSessionId = yield* createReadySession(cli)
					expect(
						(yield* cli.run(["sessions", "archive", "--session-id", endedSessionId])).exitCode,
					).toBe(0)

					const [helloElapsed, helloRes] = yield* Effect.timed(
						cli.run(["sessions", "connect", "--session-id", endedSessionId], {
							stdin: Stream.concat(Stream.make(encoder.encode("hello")), Stream.never),
						}),
					)
					expect(helloRes.exitCode).toBe(1)
					expect(Duration.toMillis(helloElapsed)).toBeLessThan(1000)
					expect(helloRes.stderr).toContain(
						`Cannot send input: session ${endedSessionId} is already archived.`,
					)

					const partialPrefixEofRes = yield* cli.run(
						["sessions", "connect", "--session-id", endedSessionId],
						{ stdin: "/ex" },
					)
					expect(partialPrefixEofRes.exitCode).toBe(1)
					expect(partialPrefixEofRes.stderr).toContain(
						`Cannot send input: session ${endedSessionId} is already archived.`,
					)

					const [divergedElapsed, divergedPrefixRes] = yield* Effect.timed(
						cli.run(["sessions", "connect", "--session-id", endedSessionId], {
							stdin: Stream.concat(
								Stream.make(encoder.encode("/ex")),
								Stream.concat(Stream.make(encoder.encode("tra")), Stream.never),
							),
						}),
					)
					expect(divergedPrefixRes.exitCode).toBe(1)
					expect(Duration.toMillis(divergedElapsed)).toBeLessThan(1000)
					expect(divergedPrefixRes.stderr).toContain(
						`Cannot send input: session ${endedSessionId} is already archived.`,
					)

					const chunkedExitRes = yield* cli.run(
						["sessions", "connect", "--session-id", endedSessionId],
						{
							stdin: Stream.concat(
								Stream.make(encoder.encode("/ex")),
								Stream.make(encoder.encode("it\n")),
							),
						},
					)
					expect(chunkedExitRes.exitCode).toBe(0)

					const exitThenPartialRes = yield* cli.run(
						["sessions", "connect", "--session-id", endedSessionId],
						{
							stdin: Stream.concat(Stream.make(encoder.encode("/exit\nhello")), Stream.never),
						},
					)
					expect(exitThenPartialRes.exitCode).toBe(0)

					const sharedSessionId = yield* createReadySession(cli)
					const localPostStarted = yield* Deferred.make<void>()
					const otherMessageRendered = yield* Deferred.make<void>()

					const otherClientFiber = yield* Deferred.await(localPostStarted).pipe(
						Effect.andThen(
							cli.run([
								"sessions:events",
								"send",
								"--session-id",
								sharedSessionId,
								"--event",
								JSON.stringify({
									type: "user.message",
									content: [{ type: "text", text: "shared hello" }],
								}),
							]),
						),
						Effect.forkChild,
					)

					const sharedRes = yield* cli.run(
						["sessions", "connect", "--session-id", sharedSessionId],
						{
							stdin: "shared hello\n",
							onStdoutChunk: (chunk) =>
								chunk.includes("[user] shared hello")
									? Deferred.succeed(otherMessageRendered, undefined).pipe(Effect.asVoid)
									: Effect.void,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									await runPromise(Deferred.succeed(localPostStarted, undefined))
									await runPromise(Deferred.await(otherMessageRendered))
									return new Response(
										JSON.stringify({
											type: "error",
											error: { type: "conflict_error", message: "local send rejected" },
											request_id: "req_shared_reject",
										}),
										{ status: 409, headers: { "content-type": "application/json" } },
									)
								}
								return next(request)
							},
						},
					)
					const otherClientRes = yield* Fiber.join(otherClientFiber)
					expect(otherClientRes.exitCode).toBe(0)
					expect(sharedRes.exitCode).toBe(1)
					expect(sharedRes.stdout).toContain("[user] shared hello")
					expect(sharedRes.stderr).toContain("409 conflict_error")
				}),
			),
		)
	})

	const hasPosixPythonPty = (): boolean => {
		if (process.platform === "win32") {
			return false
		}
		const probe = spawnSync("python3", ["-c", "import fcntl, pty, termios"], {
			stdio: "ignore",
			timeout: 3000,
		})
		return probe.status === 0
	}
	const isLinuxCi = process.env["CI"] === "true" && process.platform === "linux"
	const ptySupported = isLinuxCi || hasPosixPythonPty()

	it("starts `bun checkfu` with .env loading off and refuses anything extra", () => {
		const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
		const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
			readonly scripts?: Record<string, string>
		}
		expect(rootPkg.scripts?.["checkfu"]).toBe(
			"bun --no-env-file --config=apps/cli/bunfig.toml apps/cli/src/main.ts",
		)

		const env = cliProcessEnv()
		const start = (args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}) =>
			spawnSync("bun", [...args, "--help"], {
				cwd: repoRoot,
				env: { ...env, ...extraEnv },
				encoding: "utf8",
				timeout: 20_000,
			})
		const help = start(["checkfu"])
		expect(help.status).toBe(0)
		expect(help.stdout).toContain("sessions")

		for (const refused of [
			start(["checkfu"], { BUN_OPTIONS: "--env-file=.env.example" }),
			start(["checkfu"], { BUN_OPTIONS: "--config=bunfig.toml" }),
			start(["apps/cli/src/main.ts"]),
			start(["--env-file=.env.example", "apps/cli/src/main.ts"]),
		]) {
			expect(refused.status).toBe(1)
			expect(refused.stderr).toContain("--no-env-file")
		}
	})

	it.skipIf(process.platform === "win32")(
		"stops a stream when SIGTERM is sent to `bun checkfu`'s PID",
		async () => {
			const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
			const env = cliProcessEnv()
			let streamClosed = false
			const server = Http.createServer((req, res) => {
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
				})
				res.write(
					'id: 1\nevent: session.status_running\ndata: {"id":"evt_1","seq":1,"type":"session.status_running","turn":1,"created_at":"2026-11-22T00:00:00.000Z"}\n\n',
				)
				req.on("close", () => {
					streamClosed = true
				})
			})
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", resolve)
			})
			try {
				const port = (server.address() as { port: number }).port
				const outcome = await new Promise<{
					readonly stdoutEnded: boolean
					readonly signal: NodeJS.Signals | null
				}>((resolve, reject) => {
					const child = spawn(
						"bun",
						[
							"checkfu",
							"sessions:events",
							"stream",
							"--session-id",
							"sess_kill",
							"--base-url",
							`http://127.0.0.1:${port}`,
						],
						{
							cwd: repoRoot,
							env: { ...env, CHECKFU_API_KEY: "ck_kill" },
							stdio: ["ignore", "pipe", "pipe"],
							detached: true,
						},
					)
					let stdout = ""
					let stdoutEnded = false
					let killed = false
					const timer = setTimeout(() => {
						if (child.pid !== undefined) {
							process.kill(-child.pid, "SIGKILL")
						}
						reject(new Error(`stream did not stop after SIGTERM to its PID: ${stdout}`))
					}, 15_000)
					child.stdout.setEncoding("utf8")
					child.stdout.on("data", (chunk: string) => {
						stdout += chunk
						if (!killed && stdout.includes("session.status_running")) {
							killed = true
							child.kill("SIGTERM")
						}
					})
					child.stdout.on("end", () => {
						stdoutEnded = true
					})
					child.on("error", reject)
					child.on("close", (_code, signal) => {
						clearTimeout(timer)
						resolve({ stdoutEnded, signal })
					})
				})
				expect(outcome.stdoutEnded).toBe(true)
				for (let waited = 0; waited < 3000 && !streamClosed; waited += 50) {
					await new Promise<void>((resolve) => {
						setTimeout(resolve, 50)
					})
				}
				expect(streamClosed).toBe(true)
			} finally {
				server.closeAllConnections()
				await new Promise<void>((resolve) => {
					server.close(() => {
						resolve()
					})
				})
			}
		},
		30_000,
	)

	it.runIf(ptySupported)(
		"delivers one interrupt per Ctrl-C to a single-process start in a real PTY",
		async () => {
			const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

			const openSseResponses: Array<Http.ServerResponse> = []
			const postedEventBodies: Array<string> = []
			const server = Http.createServer((req, res) => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				if (req.method === "GET" && url.pathname === "/v1/sessions/sess_pty") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(
						JSON.stringify({
							id: "sess_pty",
							type: "session",
							resources: [],
							status: "running",
							turn: 1,
							usage: { input_tokens: 0, output_tokens: 0 },
							agent: { id: "agt_pty", version: 1 },
							environment_id: "env_pty",
							title: null,
							created_at: "2026-11-22T00:00:00.000Z",
							updated_at: "2026-11-22T00:00:00.000Z",
							archived_at: null,
						}),
					)
					return
				}
				if (req.method === "GET" && url.pathname === "/v1/sessions/sess_pty/events/stream") {
					res.writeHead(200, {
						"content-type": "text/event-stream; charset=utf-8",
						"cache-control": "no-cache",
					})
					res.write(
						'id: 1\nevent: session.status_running\ndata: {"id":"evt_1","seq":1,"type":"session.status_running","turn":1,"created_at":"2026-11-22T00:00:00.000Z"}\n\n',
					)
					openSseResponses.push(res)
					return
				}
				if (req.method === "POST" && url.pathname === "/v1/sessions/sess_pty/events") {
					let body = ""
					req.setEncoding("utf8")
					req.on("data", (chunk: string) => {
						body += chunk
					})
					req.on("end", () => {
						postedEventBodies.push(body)
						res.writeHead(200, { "content-type": "application/json" })
						res.end(JSON.stringify({ data: [{ type: "user.interrupt" }] }))
					})
					return
				}
				res.writeHead(404, { "content-type": "application/json" })
				res.end(
					JSON.stringify({
						type: "error",
						error: { type: "not_found_error", message: "not found" },
						request_id: "req_pty",
					}),
				)
			})

			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", resolve)
			})
			try {
				const addr = server.address()
				const port = typeof addr === "object" && addr !== null ? addr.port : 0

				const ptyScript = `
import fcntl, json, os, pty, select, signal, subprocess, sys, termios, time

master, slave = pty.openpty()
def setup_ctty():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

cmd = ["bun", "--no-env-file", "--config=apps/cli/bunfig.toml", "apps/cli/src/main.ts", "sessions", "connect", "--session-id", "sess_pty", "--base-url", f"http://127.0.0.1:{sys.argv[1]}"]
p = subprocess.Popen(cmd, cwd=sys.argv[2], stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup_ctty, close_fds=True)
os.close(slave)

out = b""
stage = 0
alive_after_first = False
deadline = time.time() + 12
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        try:
            chunk = os.read(master, 4096)
            if not chunk:
                break
            out += chunk
        except OSError:
            break
    if stage == 0 and b"Connected to sess_pty" in out:
        time.sleep(0.05)
        stage = 1
        os.write(master, b"\\x03")
    elif stage == 1 and b"Press Ctrl-C again to disconnect." in out:
        alive_after_first = p.poll() is None
        stage = 2
        os.write(master, b"\\x03")
    if p.poll() is not None:
        break

if p.poll() is None:
    try:
        p.wait(timeout=max(0.1, deadline - time.time()))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait()
os.close(master)
print(json.dumps({"rc": p.returncode, "aliveAfterFirst": alive_after_first, "output": out.decode("utf-8", errors="replace")}))
`
				const ptyResult = await new Promise<{
					readonly rc: number | null
					readonly aliveAfterFirst: boolean
					readonly output: string
				}>((resolve, reject) => {
					const driver = spawn("python3", ["-c", ptyScript, String(port), repoRoot], {
						env: cliProcessEnv({ CHECKFU_API_KEY: "ck_pty" }),
						stdio: ["ignore", "pipe", "pipe"],
					})
					let stdout = ""
					let stderr = ""
					driver.stdout.setEncoding("utf8")
					driver.stderr.setEncoding("utf8")
					driver.stdout.on("data", (chunk: string) => {
						stdout += chunk
					})
					driver.stderr.on("data", (chunk: string) => {
						stderr += chunk
					})
					driver.on("error", reject)
					driver.on("close", (code) => {
						if (code !== 0) {
							reject(new Error(`PTY driver failed (${code}): ${stderr}`))
							return
						}
						try {
							resolve(
								JSON.parse(stdout.trim()) as {
									readonly rc: number | null
									readonly aliveAfterFirst: boolean
									readonly output: string
								},
							)
						} catch (error) {
							reject(new Error(`Invalid PTY driver JSON: ${stdout} (${String(error)})`))
						}
					})
				})

				expect(ptyResult.aliveAfterFirst).toBe(true)
				expect(ptyResult.rc).toBe(130)
				expect(ptyResult.output).toContain("Interrupt requested.")
				expect(ptyResult.output).toContain("Press Ctrl-C again to disconnect.")
				expect(postedEventBodies).toHaveLength(1)
				expect(JSON.parse(postedEventBodies[0] ?? "{}")).toEqual({
					events: [{ type: "user.interrupt" }],
				})

				postedEventBodies.length = 0
				const pidSigintConnectScript = `
import fcntl, json, os, pty, select, signal, subprocess, sys, termios, time

master, slave = pty.openpty()
def setup_ctty():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

cmd = ["bun", "--no-env-file", "--config=apps/cli/bunfig.toml", "apps/cli/src/main.ts", "sessions", "connect", "--session-id", "sess_pty", "--base-url", f"http://127.0.0.1:{sys.argv[1]}"]
p = subprocess.Popen(cmd, cwd=sys.argv[2], stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup_ctty, close_fds=True)
os.close(slave)

out = b""
stage = 0
alive_after_first = False
deadline = time.time() + 12
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        try:
            chunk = os.read(master, 4096)
            if not chunk:
                break
            out += chunk
        except OSError:
            break
    if stage == 0 and b"Connected to sess_pty" in out:
        time.sleep(0.05)
        stage = 1
        os.kill(p.pid, signal.SIGINT)
    elif stage == 1 and b"Press Ctrl-C again to disconnect." in out:
        alive_after_first = p.poll() is None
        stage = 2
        os.kill(p.pid, signal.SIGINT)
    if p.poll() is not None:
        break

if p.poll() is None:
    try:
        p.wait(timeout=max(0.1, deadline - time.time()))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait()
os.close(master)
print(json.dumps({"rc": p.returncode, "aliveAfterFirst": alive_after_first, "output": out.decode("utf-8", errors="replace")}))
`
				const pidConnectResult = await new Promise<{
					readonly rc: number | null
					readonly aliveAfterFirst: boolean
					readonly output: string
				}>((resolve, reject) => {
					const driver = spawn("python3", ["-c", pidSigintConnectScript, String(port), repoRoot], {
						env: cliProcessEnv({ CHECKFU_API_KEY: "ck_pty" }),
						stdio: ["ignore", "pipe", "pipe"],
					})
					let stdout = ""
					let stderr = ""
					driver.stdout.setEncoding("utf8")
					driver.stderr.setEncoding("utf8")
					driver.stdout.on("data", (chunk: string) => {
						stdout += chunk
					})
					driver.stderr.on("data", (chunk: string) => {
						stderr += chunk
					})
					driver.on("error", reject)
					driver.on("close", (code) => {
						if (code !== 0) {
							reject(new Error(`PTY PID-SIGINT connect driver failed (${code}): ${stderr}`))
							return
						}
						try {
							resolve(
								JSON.parse(stdout.trim()) as {
									readonly rc: number | null
									readonly aliveAfterFirst: boolean
									readonly output: string
								},
							)
						} catch (error) {
							reject(new Error(`Invalid PTY PID-SIGINT connect JSON: ${stdout} (${String(error)})`))
						}
					})
				})

				expect(pidConnectResult.aliveAfterFirst).toBe(true)
				expect(pidConnectResult.rc).toBe(130)
				expect(pidConnectResult.output).toContain("Interrupt requested.")
				expect(pidConnectResult.output).toContain("Press Ctrl-C again to disconnect.")
				expect(postedEventBodies).toHaveLength(1)
				expect(JSON.parse(postedEventBodies[0] ?? "{}")).toEqual({
					events: [{ type: "user.interrupt" }],
				})

				const pidSigintStreamScript = `
import fcntl, json, os, pty, select, signal, subprocess, sys, termios, time

master, slave = pty.openpty()
def setup_ctty():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

cmd = ["bun", "--no-env-file", "--config=apps/cli/bunfig.toml", "apps/cli/src/main.ts", "sessions:events", "stream", "--session-id", "sess_pty", "--base-url", f"http://127.0.0.1:{sys.argv[1]}"]
p = subprocess.Popen(cmd, cwd=sys.argv[2], stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup_ctty, close_fds=True)
os.close(slave)

out = b""
sent = False
deadline = time.time() + 12
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        try:
            chunk = os.read(master, 4096)
            if not chunk:
                break
            out += chunk
        except OSError:
            break
    if not sent and b"session.status_running" in out:
        sent = True
        os.kill(p.pid, signal.SIGINT)
    if p.poll() is not None:
        break

timed_out = False
if p.poll() is None:
    try:
        p.wait(timeout=max(0.1, deadline - time.time()))
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait()
os.close(master)
print(json.dumps({"rc": p.returncode, "timedOut": timed_out, "output": out.decode("utf-8", errors="replace")}))
`
				const pidStreamResult = await new Promise<{
					readonly rc: number | null
					readonly timedOut: boolean
					readonly output: string
				}>((resolve, reject) => {
					const driver = spawn("python3", ["-c", pidSigintStreamScript, String(port), repoRoot], {
						env: cliProcessEnv({ CHECKFU_API_KEY: "ck_pty" }),
						stdio: ["ignore", "pipe", "pipe"],
					})
					let stdout = ""
					let stderr = ""
					driver.stdout.setEncoding("utf8")
					driver.stderr.setEncoding("utf8")
					driver.stdout.on("data", (chunk: string) => {
						stdout += chunk
					})
					driver.stderr.on("data", (chunk: string) => {
						stderr += chunk
					})
					driver.on("error", reject)
					driver.on("close", (code) => {
						if (code !== 0) {
							reject(new Error(`PTY PID-SIGINT stream driver failed (${code}): ${stderr}`))
							return
						}
						try {
							resolve(
								JSON.parse(stdout.trim()) as {
									readonly rc: number | null
									readonly timedOut: boolean
									readonly output: string
								},
							)
						} catch (error) {
							reject(new Error(`Invalid PTY PID-SIGINT stream JSON: ${stdout} (${String(error)})`))
						}
					})
				})

				expect(pidStreamResult.timedOut).toBe(false)
				expect(pidStreamResult.rc).toBe(130)
				expect(pidStreamResult.output).toContain("session.status_running")

				const nonTtyStreamResult = await new Promise<{
					readonly code: number | null
					readonly signal: NodeJS.Signals | null
					readonly timedOut: boolean
					readonly stdout: string
				}>((resolve, reject) => {
					const child = spawn(
						"bun",
						[
							...PINNED_BUN_FLAGS,
							"apps/cli/src/main.ts",
							"sessions:events",
							"stream",
							"--session-id",
							"sess_pty",
							"--base-url",
							`http://127.0.0.1:${port}`,
						],
						{
							cwd: repoRoot,
							env: cliProcessEnv({ CHECKFU_API_KEY: "ck_pty" }),
							stdio: ["ignore", "pipe", "pipe"],
						},
					)
					let stdout = ""
					let sent = false
					let timedOut = false
					const timer = setTimeout(() => {
						timedOut = true
						child.kill("SIGKILL")
					}, 4500)
					child.stdout.setEncoding("utf8")
					child.stdout.on("data", (chunk: string) => {
						stdout += chunk
						if (!sent && stdout.includes("session.status_running")) {
							sent = true
							child.kill("SIGINT")
						}
					})
					child.on("error", (err) => {
						clearTimeout(timer)
						reject(err)
					})
					child.on("close", (code, signal) => {
						clearTimeout(timer)
						resolve({ code, signal, timedOut, stdout })
					})
				})
				expect(nonTtyStreamResult.timedOut).toBe(false)
				expect(nonTtyStreamResult.code).toBe(130)
				expect(nonTtyStreamResult.stdout).toContain("session.status_running")
			} finally {
				for (const res of openSseResponses) {
					res.end()
				}
				await new Promise<void>((resolve) => {
					server.close(() => {
						resolve()
					})
				})
			}
		},
		25_000,
	)

	it("reports buffered piped input on live session termination, separates confirmed 429 rejections from unconfirmed delivery, and bounds turn bookkeeping", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const encoder = new TextEncoder()
					let turnCount = 0
					const cli = yield* makeTestServer({
						generate: (args) =>
							Effect.sync(() => {
								turnCount += 1
								return {
									thinking: null,
									text: `Reply-${args.turn}:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})

					const liveBufferedSessionId = yield* createReadySession(cli)
					const streamReady = yield* Deferred.make<void>()
					const archiver1 = yield* Deferred.await(streamReady).pipe(
						Effect.andThen(Effect.sleep("40 millis")),
						Effect.andThen(cli.run(["sessions", "archive", "--session-id", liveBufferedSessionId])),
						Effect.forkChild,
					)
					const liveBufferedRes = yield* cli.run(
						["sessions", "connect", "--session-id", liveBufferedSessionId],
						{
							stdin: Stream.concat(
								Stream.make(encoder.encode("buffered before archive")),
								Stream.never,
							),
							interceptFetch: async (next, request) => {
								if (request.url.includes("/events/stream")) {
									await runPromise(Deferred.succeed(streamReady, undefined))
								}
								return next(request)
							},
						},
					)
					yield* Fiber.await(archiver1)
					expect(liveBufferedRes.exitCode).toBe(1)
					expect(liveBufferedRes.stderr).toContain("ended before buffered input was submitted")

					const liveSecondSessionId = yield* createReadySession(cli)
					const firstReplyRendered = yield* Deferred.make<void>()
					const archiver2 = yield* Deferred.await(firstReplyRendered).pipe(
						Effect.andThen(Effect.sleep("30 millis")),
						Effect.andThen(cli.run(["sessions", "archive", "--session-id", liveSecondSessionId])),
						Effect.forkChild,
					)
					const liveSecondRes = yield* cli.run(
						["sessions", "connect", "--session-id", liveSecondSessionId],
						{
							stdin: Stream.concat(
								Stream.make(encoder.encode("first line\nsecond buffered")),
								Stream.never,
							),
							onStdoutChunk: (chunk) =>
								chunk.includes("Reply-1:first line")
									? Deferred.succeed(firstReplyRendered, undefined).pipe(Effect.asVoid)
									: Effect.void,
						},
					)
					yield* Fiber.await(archiver2)
					expect(liveSecondRes.exitCode).toBe(1)
					expect(liveSecondRes.stderr).toContain("ended before buffered input was submitted")

					const queueFullSessionId = yield* createReadySession(cli)
					let confirmed429Calls = 0
					const confirmed429Res = yield* cli.run(
						["sessions", "connect", "--session-id", queueFullSessionId],
						{
							stdin: "queued message\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									confirmed429Calls += 1
									return new Response(
										JSON.stringify({
											type: "error",
											error: {
												type: "rate_limit_error",
												message:
													"Too many queued user messages are already waiting for the active turn.",
											},
											request_id: `req_429_${confirmed429Calls}`,
										}),
										{ status: 429, headers: { "content-type": "application/json" } },
									)
								}
								return next(request)
							},
						},
					)
					expect(confirmed429Calls).toBe(3)
					expect(confirmed429Res.exitCode).toBe(1)
					expect(confirmed429Res.stderr).toContain("429 rate_limit_error")
					expect(confirmed429Res.stderr).not.toContain("delivery unconfirmed")
					expect(confirmed429Res.stderr).not.toContain("Idempotency-Key:")

					const mixedKeys: Array<string | null> = []
					const mixed429Res = yield* cli.run(
						["sessions", "connect", "--session-id", queueFullSessionId],
						{
							stdin: "ambiguous then 429\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									mixedKeys.push(request.headers.get("idempotency-key"))
									if (mixedKeys.length === 1) {
										throw new TypeError("socket dropped after send")
									}
									return new Response(
										JSON.stringify({
											type: "error",
											error: {
												type: "rate_limit_error",
												message:
													"Too many queued user messages are already waiting for the active turn.",
											},
											request_id: `req_mixed_${mixedKeys.length}`,
										}),
										{ status: 429, headers: { "content-type": "application/json" } },
									)
								}
								return next(request)
							},
						},
					)
					expect(mixedKeys).toHaveLength(3)
					expect(new Set(mixedKeys).size).toBe(1)
					expect(mixed429Res.exitCode).toBe(1)
					expect(mixed429Res.stderr).toContain("delivery unconfirmed")
					expect(mixed429Res.stderr).toContain(`Idempotency-Key: ${mixedKeys[0]}`)

					const unconfirmed429Keys: Array<string | null> = []
					const unconfirmed429Res = yield* cli.run(
						["sessions", "connect", "--session-id", queueFullSessionId],
						{
							stdin: "unconfirmed 429\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									unconfirmed429Keys.push(request.headers.get("idempotency-key"))
									return new Response(
										JSON.stringify({
											type: "error",
											error: { type: "rate_limit_error", message: "ambiguous rate limit" },
											request_id: `req_u429_${unconfirmed429Keys.length}`,
											unconfirmed_index: 0,
										}),
										{ status: 429, headers: { "content-type": "application/json" } },
									)
								}
								return next(request)
							},
						},
					)
					expect(unconfirmed429Keys).toHaveLength(3)
					expect(unconfirmed429Res.exitCode).toBe(1)
					expect(unconfirmed429Res.stderr).toContain("delivery unconfirmed")
					expect(unconfirmed429Res.stderr).toContain(`Idempotency-Key: ${unconfirmed429Keys[0]}`)

					const multiTtySessionId = yield* createReadySession(cli)
					const multiTtyRes = yield* cli.run(
						["sessions", "connect", "--session-id", multiTtySessionId],
						{
							stdinIsTerminal: true,
							terminalReads: [
								Effect.succeed("tty turn 1"),
								Effect.sleep("20 millis").pipe(Effect.as("tty turn 2")),
								Effect.sleep("20 millis").pipe(Effect.as("/exit")),
							],
						},
					)
					expect(multiTtyRes.exitCode).toBe(0)
					expect(turnCount).toBeGreaterThanOrEqual(2)

					const multiFailCli = yield* makeTestServer({
						generate: (args) =>
							args.turn === 2
								? Effect.fail({
										_tag: "TurnFailed" as const,
										error_type: "upstream_error" as const,
										message: "turn 2 provider boom",
										terminal: false,
									})
								: Effect.succeed({
										thinking: null,
										text: `Ok-${args.turn}`,
										input_tokens: 2,
										output_tokens: 2,
										stop_reason: { type: "end_turn" as const },
									}),
					})
					const multiFailSessionId = yield* createReadySession(multiFailCli)
					const turn1Done = yield* Deferred.make<void>()
					const turn2Done = yield* Deferred.make<void>()
					const stagedMultiFailStdin = Stream.concat(
						Stream.make(encoder.encode("m1\n")),
						Stream.concat(
							Stream.fromEffect(
								Deferred.await(turn1Done).pipe(
									Effect.andThen(Effect.sleep("20 millis")),
									Effect.as(encoder.encode("m2\n")),
								),
							),
							Stream.fromEffect(
								Deferred.await(turn2Done).pipe(
									Effect.andThen(Effect.sleep("20 millis")),
									Effect.as(encoder.encode("m3\n")),
								),
							),
						),
					)
					const multiFailRes = yield* multiFailCli.run(
						["sessions", "connect", "--session-id", multiFailSessionId],
						{
							stdin: stagedMultiFailStdin,
							onStdoutChunk: (chunk) =>
								chunk.includes("Ok-1")
									? Deferred.succeed(turn1Done, undefined).pipe(Effect.asVoid)
									: Effect.void,
							interceptFetch: async (next, request) => {
								const res = await next(request)
								if (!request.url.includes("/events/stream") || res.body === null) {
									return res
								}
								const reader = res.body.getReader()
								const decoder = new TextDecoder()
								let signaledTurn2 = false
								const observed = new ReadableStream<Uint8Array>({
									async pull(controller) {
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										const text = decoder.decode(chunk.value, { stream: true })
										controller.enqueue(chunk.value)
										if (!signaledTurn2 && text.includes("retries_exhausted")) {
											signaledTurn2 = true
											await runPromise(Deferred.succeed(turn2Done, undefined))
										}
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(observed, { status: res.status, headers: res.headers })
							},
						},
					)
					expect(multiFailRes.exitCode).toBe(1)
					expect(multiFailRes.stderr).toContain("Turn 2 failed:")
					expect(multiFailRes.stderr).toContain("turn 2 provider boom")
					expect(multiFailRes.stdout).toContain("Ok-1")
					expect(multiFailRes.stdout).toContain("Ok-3")
				}),
			),
		)
	})

	it("validates interrupt receipts, keeps TTY open after confirmed message rejections, and distinguishes retrying vs terminal turn errors", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const cli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `Ok:${args.input.join("|")}`,
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const sessionId = yield* createReadySession(cli)

					for (const badBody of [{ data: [] }, { data: [{ type: "user.message", turn: 1 }] }]) {
						let capturedKey = ""
						const badIntRes = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
							stdin: "/interrupt\n",
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									capturedKey = request.headers.get("idempotency-key") ?? ""
									return new Response(JSON.stringify(badBody), {
										status: 200,
										headers: { "content-type": "application/json" },
									})
								}
								return next(request)
							},
						})
						expect(badIntRes.exitCode).toBe(1)
						expect(capturedKey).toMatch(/^cli_[0-9a-f]{24}$/)
						expect(badIntRes.stderr).toContain("delivery unconfirmed")
						expect(badIntRes.stderr).toContain(`Idempotency-Key: ${capturedKey}`)
						expect(badIntRes.stderr).not.toContain("Interrupt requested.")
					}

					let ttyIntKey = ""
					const ttyBadIntRes = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdinIsTerminal: true,
						terminalReads: [Effect.succeed("/interrupt"), Effect.succeed("/exit")],
						interceptFetch: async (next, request) => {
							if (request.method === "POST" && request.url.endsWith("/events")) {
								ttyIntKey = request.headers.get("idempotency-key") ?? ""
								return new Response(JSON.stringify({ data: [] }), {
									status: 200,
									headers: { "content-type": "application/json" },
								})
							}
							return next(request)
						},
					})
					expect(ttyBadIntRes.exitCode).toBe(0)
					expect(ttyIntKey).toMatch(/^cli_[0-9a-f]{24}$/)
					expect(ttyBadIntRes.stderr).toContain("Interrupt failed:")
					expect(ttyBadIntRes.stderr).toContain(`Idempotency-Key: ${ttyIntKey}`)
					expect(ttyBadIntRes.stderr).not.toContain("Interrupt requested.")

					const ttyRecoverSessionId = yield* createReadySession(cli)
					const validReplyRendered = yield* Deferred.make<void>()
					let queueFullRejected = false
					const ttyRecoverRes = yield* cli.run(
						["sessions", "connect", "--session-id", ttyRecoverSessionId],
						{
							stdinIsTerminal: true,
							terminalReads: [
								Effect.succeed("x".repeat(20_000)),
								Effect.succeed("queue full message"),
								Effect.succeed("corrected follow-up"),
								Deferred.await(validReplyRendered).pipe(Effect.as("/exit")),
							],
							onStdoutChunk: (chunk) =>
								chunk.includes("Ok:corrected follow-up")
									? Deferred.succeed(validReplyRendered, undefined).pipe(Effect.asVoid)
									: Effect.void,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									const bodyText = await request.clone().text()
									if (bodyText.includes("queue full message")) {
										queueFullRejected = true
										return new Response(
											JSON.stringify({
												type: "error",
												error: {
													type: "rate_limit_error",
													message: "Too many queued user messages.",
												},
												request_id: "req_tty_429",
											}),
											{ status: 429, headers: { "content-type": "application/json" } },
										)
									}
								}
								return next(request)
							},
						},
					)
					expect(ttyRecoverRes.exitCode).toBe(0)
					expect(queueFullRejected).toBe(true)
					expect(ttyRecoverRes.stderr).toContain(
						"Send failed: API error (400 invalid_request_error)",
					)
					expect(ttyRecoverRes.stderr).toContain("Send failed: API error (429 rate_limit_error)")
					expect(ttyRecoverRes.stdout).toContain("Ok:corrected follow-up")

					const retryingTurnStarted = yield* Deferred.make<void>()
					const releaseRetryingTurn = yield* Deferred.make<void>()
					const retryingCli = yield* makeTestServer({
						generate: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(retryingTurnStarted, undefined)
								yield* Deferred.await(releaseRetryingTurn)
								return {
									thinking: null,
									text: "never",
									input_tokens: 1,
									output_tokens: 1,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const retryingSessionId = yield* createReadySession(retryingCli)
					const retryErrDelivered = yield* Deferred.make<void>()
					const archiveDuringRetry = yield* Deferred.await(retryErrDelivered).pipe(
						Effect.andThen(Effect.sleep("25 millis")),
						Effect.andThen(
							retryingCli.run(["sessions", "archive", "--session-id", retryingSessionId]),
						),
						Effect.forkChild,
					)
					const retryingArchivedRes = yield* retryingCli.run(
						["sessions", "connect", "--session-id", retryingSessionId],
						{
							stdin: "trigger retrying then archive\n",
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								const res = await next(request)
								if (res.status !== 200 || res.body === null) {
									return res
								}
								const reader = res.body.getReader()
								const decoder = new TextDecoder()
								const encoder = new TextEncoder()
								let injected = false
								const shiftSeqs = (raw: string): string =>
									raw
										.replaceAll(/^id: (\d+)$/gm, (_m, n: string) => `id: ${Number(n) + 1}`)
										.replaceAll(/"seq":(\d+)/g, (_m, n: string) => `"seq":${Number(n) + 1}`)
								const observed = new ReadableStream<Uint8Array>({
									async pull(controller) {
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										let text = decoder.decode(chunk.value, { stream: true })
										if (injected) {
											text = shiftSeqs(text)
										} else if (text.includes("session.status_running")) {
											injected = true
											const seqMatches = [...text.matchAll(/"seq":(\d+)/g)]
											const lastSeq = seqMatches.length > 0 ? Number(seqMatches.at(-1)?.[1]) : 2
											const errSeq = lastSeq + 1
											const retryErr = `id: ${errSeq}\nevent: session.error\ndata: ${JSON.stringify(
												{
													id: "evt_inject_retrying",
													seq: errSeq,
													type: "session.error",
													created_at: "2026-11-22T00:00:00.000Z",
													error: {
														type: "upstream_overloaded",
														message: "temporary retryable error",
														retry_status: { type: "retrying" },
													},
												},
											)}\n\n`
											text = `${text}${retryErr}`
											await runPromise(Deferred.succeed(retryErrDelivered, undefined))
										}
										controller.enqueue(encoder.encode(text))
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(observed, { status: 200, headers: res.headers })
							},
						},
					)
					yield* Deferred.succeed(releaseRetryingTurn, undefined)
					yield* Fiber.await(archiveDuringRetry)
					expect(retryingArchivedRes.exitCode).toBe(1)
					expect(retryingArchivedRes.stderr).toContain(
						"Session terminated before turn 1 completed.",
					)
					expect(retryingArchivedRes.stderr).not.toContain("Turn 1 failed:")

					const terminalErrCli = yield* makeTestServer({
						generate: () =>
							Effect.fail({
								_tag: "TurnFailed" as const,
								error_type: "invalid_request_error" as const,
								message: "fatal context overflow",
								terminal: true,
							}),
					})
					const terminalErrSessionId = yield* createReadySession(terminalErrCli)
					const terminalErrRes = yield* terminalErrCli.run(
						["sessions", "connect", "--session-id", terminalErrSessionId],
						{ stdin: "trigger terminal error\n" },
					)
					expect(terminalErrRes.exitCode).toBe(1)
					expect(terminalErrRes.stderr).toContain("Turn 1 failed:")
					expect(terminalErrRes.stderr).toContain("fatal context overflow")
				}),
			),
		)
	})

	it("distinguishes started vs queued receipts on lagging session views and bounds resume suffix scans on busy sessions", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const turn1Finished = yield* Deferred.make<void>()
					const releaseSseAfterPost2 = yield* Deferred.make<void>()
					const raceCli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									yield* Deferred.succeed(turn1Finished, undefined)
									return {
										thinking: null,
										text: "Refused turn 1",
										input_tokens: 2,
										output_tokens: 2,
										stop_reason: { type: "refusal" as const },
									}
								}
								return {
									thinking: null,
									text: `Started turn 2:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const raceSessionId = yield* createReadySession(raceCli)
					const encoder = new TextEncoder()
					let postIndex = 0
					let getSessionCount = 0
					let post2Receipt: { readonly turn?: number; readonly queued?: boolean } | undefined

					const stagedStdin = Stream.concat(
						Stream.make(encoder.encode("first turn\n")),
						Stream.fromEffect(
							Deferred.await(turn1Finished).pipe(
								Effect.andThen(Effect.sleep("40 millis")),
								Effect.as(encoder.encode("second starts fresh\n")),
							),
						),
					)

					const raceRes = yield* raceCli.run(
						["sessions", "connect", "--session-id", raceSessionId],
						{
							stdin: stagedStdin,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									postIndex += 1
									const res = await next(request)
									if (postIndex === 2) {
										const parsed = (await res.clone().json()) as {
											data?: ReadonlyArray<{ readonly turn?: number; readonly queued?: boolean }>
										}
										post2Receipt = parsed.data?.[0]
										await runPromise(Deferred.succeed(releaseSseAfterPost2, undefined))
									}
									return res
								}
								if (
									request.method === "GET" &&
									request.url.endsWith(`/sessions/${raceSessionId}`)
								) {
									getSessionCount += 1
									const res = await next(request)
									if (getSessionCount > 1) {
										const body = (await res.json()) as { status?: string; turn?: number }
										return new Response(JSON.stringify({ ...body, status: "idle", turn: 1 }), {
											status: 200,
											headers: { "content-type": "application/json" },
										})
									}
									return res
								}
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								const res = await next(request)
								if (res.status !== 200 || res.body === null) {
									return res
								}
								const reader = res.body.getReader()
								const decoder = new TextDecoder()
								let heldFirstIdle = false
								const gated = new ReadableStream<Uint8Array>({
									async pull(controller) {
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										const text = decoder.decode(chunk.value, { stream: true })
										if (!heldFirstIdle && text.includes("session.status_idle")) {
											heldFirstIdle = true
											await runPromise(Deferred.await(releaseSseAfterPost2))
										}
										controller.enqueue(chunk.value)
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(gated, { status: 200, headers: res.headers })
							},
						},
					)
					expect(post2Receipt).toMatchObject({ turn: 2, queued: false })
					expect(raceRes.exitCode).toBe(0)
					expect(raceRes.stdout).toContain("Started turn 2:second starts fresh")
					expect(raceRes.stderr).not.toContain("did not start")

					const busyCli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `Busy-${args.turn}:${args.input.join("|")}`,
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const busySessionId = yield* createReadySession(busyCli)
					for (const msg of ["a", "b"]) {
						expect(
							(yield* busyCli.run(["sessions", "connect", "--session-id", busySessionId], {
								stdin: `${msg}\n`,
							})).exitCode,
						).toBe(0)
					}
					const headPage = JSON.parse(
						(yield* busyCli.run([
							"sessions:events",
							"list",
							"--session-id",
							busySessionId,
							"--limit",
							"1",
							"--order",
							"desc",
						])).stdout,
					) as { data: Array<{ seq: number }> }
					const headSeq = headPage.data[0]?.seq ?? 0
					const resumeAfter = Math.max(1, headSeq - 2)
					expect(headSeq - resumeAfter).toBeLessThanOrEqual(resumeAfter)

					let syntheticHead = headSeq
					let descBaselineQueries = 0
					let suffixPagesServed = 0
					let prefixPagesServed = 0
					const [busyDuration, busyResumeRes] = yield* Effect.timed(
						busyCli.run(
							[
								"sessions",
								"connect",
								"--session-id",
								busySessionId,
								"--after",
								String(resumeAfter),
							],
							{
								stdin: "/exit\n",
								interceptFetch: async (next, request) => {
									const url = new URL(request.url)
									if (
										request.method === "GET" &&
										url.pathname === `/v1/sessions/${busySessionId}/events`
									) {
										const order = url.searchParams.get("order")
										const afterParam = url.searchParams.get("after")
										if (order === "desc" && url.searchParams.get("limit") === "1") {
											return new Response(
												JSON.stringify({
													data: [
														{
															id: `evt_${syntheticHead}`,
															seq: syntheticHead,
															type: "user.message",
															created_at: "2026-11-22T00:00:00.000Z",
															content: [{ type: "text", text: "busy" }],
														},
													],
													has_more: true,
													next_cursor: syntheticHead,
												}),
												{ status: 200, headers: { "content-type": "application/json" } },
											)
										}
										if (order === "desc" && afterParam === String(resumeAfter + 1)) {
											descBaselineQueries += 1
										}
										if (
											order === "asc" &&
											afterParam !== null &&
											Number(afterParam) >= resumeAfter
										) {
											suffixPagesServed += 1
											const cursor = Number(afterParam)
											const nextSeq1 = cursor + 1
											const nextSeq2 = cursor + 2
											syntheticHead = Math.max(syntheticHead + 2, nextSeq2 + 1)
											return new Response(
												JSON.stringify({
													data: [
														{
															id: `evt_${nextSeq1}`,
															seq: nextSeq1,
															type: "user.message",
															created_at: "2026-11-22T00:00:00.000Z",
															content: [{ type: "text", text: "live-1" }],
														},
														{
															id: `evt_${nextSeq2}`,
															seq: nextSeq2,
															type: "user.message",
															created_at: "2026-11-22T00:00:00.000Z",
															content: [{ type: "text", text: "live-2" }],
														},
													],
													has_more: true,
													next_cursor: nextSeq2,
												}),
												{ status: 200, headers: { "content-type": "application/json" } },
											)
										}
										if (
											order === "asc" &&
											(afterParam === null || Number(afterParam) < resumeAfter)
										) {
											prefixPagesServed += 1
										}
									}
									return next(request)
								},
							},
						),
					)
					expect(busyResumeRes.exitCode).toBe(0)
					expect(Duration.toMillis(busyDuration)).toBeLessThan(1500)
					expect(descBaselineQueries).toBe(1)
					expect(suffixPagesServed).toBe(0)
					expect(prefixPagesServed).toBe(0)
				}),
			),
		)
	})

	it("clears queued-turn markers when started later, interrupts predecessor turns from queued receipts, and retries transient startup lookups", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const turn1Started = yield* Deferred.make<void>()
					const releaseTurn1 = yield* Deferred.make<void>()
					const turn1SettledRefusal = yield* Deferred.make<void>()
					const post3Returned = yield* Deferred.make<void>()
					const clearQueueCli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									yield* Deferred.succeed(turn1Started, undefined)
									yield* Deferred.await(releaseTurn1)
									return {
										thinking: null,
										text: "Refused turn 1",
										input_tokens: 2,
										output_tokens: 2,
										stop_reason: { type: "refusal" as const },
									}
								}
								return {
									thinking: null,
									text: `StartedAfterClear:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const clearQueueSessionId = yield* createReadySession(clearQueueCli)
					const encoder = new TextEncoder()
					let clearPosts = 0
					let clearGets = 0
					let post2Receipt: { readonly turn?: number; readonly queued?: boolean } | undefined
					let post3Receipt: { readonly turn?: number; readonly queued?: boolean } | undefined

					const clearStdin = Stream.concat(
						Stream.make(encoder.encode("turn 1 msg\n")),
						Stream.concat(
							Stream.fromEffect(
								Deferred.await(turn1Started).pipe(Effect.as(encoder.encode("queued turn 2\n"))),
							),
							Stream.fromEffect(
								Deferred.await(turn1SettledRefusal).pipe(
									Effect.andThen(Effect.sleep("25 millis")),
									Effect.as(encoder.encode("starts turn 2\n")),
								),
							),
						),
					)

					const clearRes = yield* clearQueueCli.run(
						["sessions", "connect", "--session-id", clearQueueSessionId],
						{
							stdin: clearStdin,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									clearPosts += 1
									const res = await next(request)
									const parsed = (await res.clone().json()) as {
										data?: ReadonlyArray<{ readonly turn?: number; readonly queued?: boolean }>
									}
									if (clearPosts === 2) {
										post2Receipt = parsed.data?.[0]
										await runPromise(Deferred.succeed(releaseTurn1, undefined))
									} else if (clearPosts === 3) {
										post3Receipt = parsed.data?.[0]
										await runPromise(Deferred.succeed(post3Returned, undefined))
									}
									return res
								}
								if (
									request.method === "GET" &&
									request.url.endsWith(`/sessions/${clearQueueSessionId}`)
								) {
									clearGets += 1
									const res = await next(request)
									if (clearGets > 1) {
										const body = (await res.json()) as { status?: string; turn?: number }
										return new Response(JSON.stringify({ ...body, status: "idle", turn: 1 }), {
											status: 200,
											headers: { "content-type": "application/json" },
										})
									}
									return res
								}
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								const res = await next(request)
								if (res.status !== 200 || res.body === null) {
									return res
								}
								const reader = res.body.getReader()
								const decoder = new TextDecoder()
								let sawFirstIdle = false
								let heldAfterFirstIdle = false
								const gated = new ReadableStream<Uint8Array>({
									async pull(controller) {
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										const text = decoder.decode(chunk.value, { stream: true })
										if (sawFirstIdle && !heldAfterFirstIdle) {
											heldAfterFirstIdle = true
											await runPromise(Deferred.await(post3Returned))
											await new Promise((resolve) => {
												setTimeout(resolve, 40)
											})
										}
										controller.enqueue(chunk.value)
										if (!sawFirstIdle && text.includes("session.status_idle")) {
											sawFirstIdle = true
											await runPromise(Deferred.succeed(turn1SettledRefusal, undefined))
										}
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(gated, { status: 200, headers: res.headers })
							},
						},
					)
					expect(post2Receipt).toMatchObject({ turn: 2, queued: true })
					expect(post3Receipt).toMatchObject({ turn: 2, queued: false })
					expect(clearRes.exitCode).toBe(0)
					expect(clearRes.stdout).toContain("StartedAfterClear:")
					expect(clearRes.stderr).not.toContain("did not start")

					const otherTurn1Started = yield* Deferred.make<void>()
					const otherTurn1Interrupted = yield* Deferred.make<void>()
					const releaseSseStream = yield* Deferred.make<void>()
					const ttyPredecessorSigint = makeSigintController()
					const predCli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									yield* Deferred.succeed(otherTurn1Started, undefined)
									yield* Deferred.await(otherTurn1Interrupted)
									return yield* Effect.fail({
										_tag: "TurnInterrupted" as const,
										model_usage: { input_tokens: 2, output_tokens: 0 },
									})
								}
								return {
									thinking: null,
									text: `Turn2:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
						interrupt: () => Deferred.succeed(otherTurn1Interrupted, undefined).pipe(Effect.asVoid),
					})
					const predSessionId = yield* createReadySession(predCli)
					const connectedIdle = yield* Deferred.make<void>()
					const otherStartedFiber = yield* Deferred.await(connectedIdle).pipe(
						Effect.andThen(
							predCli.run([
								"sessions:events",
								"send",
								"--session-id",
								predSessionId,
								"--event",
								JSON.stringify({
									type: "user.message",
									content: [{ type: "text", text: "other client turn 1" }],
								}),
							]),
						),
						Effect.forkChild,
					)
					let firstCtrlCConsumed = false
					const predRes = yield* predCli.run(
						["sessions", "connect", "--session-id", predSessionId],
						{
							stdinIsTerminal: true,
							sigintController: ttyPredecessorSigint,
							interceptFetch: async (next, request) => {
								if (request.url.includes("/events/stream")) {
									await runPromise(Deferred.succeed(connectedIdle, undefined))
									await runPromise(Deferred.await(releaseSseStream))
								}
								return next(request)
							},
							terminalReads: [
								Deferred.await(otherTurn1Started).pipe(Effect.as("local queued for turn 2")),
								Effect.sync(() => {
									firstCtrlCConsumed = ttyPredecessorSigint.handleSigint()
								}).pipe(
									Effect.andThen(Deferred.await(otherTurn1Interrupted)),
									Effect.andThen(Deferred.succeed(releaseSseStream, undefined)),
									Effect.andThen(Effect.sleep("30 millis")),
									Effect.as("/exit"),
								),
							],
						},
					)
					yield* Fiber.await(otherStartedFiber)
					expect(predRes.exitCode).toBe(0)
					expect(firstCtrlCConsumed).toBe(true)
					expect(predRes.stderr).toContain("Interrupt requested.")

					const startupRetryCli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `StartupOk:${args.input.join("|")}`,
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const startupSessionId = yield* createReadySession(startupRetryCli)
					let startupGetCalls = 0
					const startupRes = yield* startupRetryCli.run(
						["sessions", "connect", "--session-id", startupSessionId],
						{
							stdin: "hello after 503\n",
							interceptFetch: async (next, request) => {
								if (
									request.method === "GET" &&
									request.url.endsWith(`/sessions/${startupSessionId}`)
								) {
									startupGetCalls += 1
									if (startupGetCalls <= 2) {
										return new Response(
											JSON.stringify({
												type: "error",
												error: {
													type: "service_unavailable",
													message: "Session projection catching up.",
												},
												request_id: `req_startup_503_${startupGetCalls}`,
											}),
											{ status: 503, headers: { "content-type": "application/json" } },
										)
									}
								}
								return next(request)
							},
						},
					)
					expect(startupGetCalls).toBe(3)
					expect(startupRes.exitCode).toBe(0)
					expect(startupRes.stdout).toContain("StartupOk:hello after 503")
				}),
			),
		)
	})

	it("keeps the directory it runs in from supplying credentials, a server URL or code", async () => {
		const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url))
		let evilHits = 0
		let legitHits = 0
		const evilServer = Http.createServer((_req, res) => {
			evilHits += 1
			res.writeHead(200, { "content-type": "application/json" })
			res.end("{}")
		})
		const legitServer = Http.createServer((req, res) => {
			legitHits += 1
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (req.method === "GET" && url.pathname === "/v1/sessions/sess_env") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(
					JSON.stringify({
						id: "sess_env",
						type: "session",
						resources: [],
						status: "idle",
						turn: 0,
						usage: { input_tokens: 0, output_tokens: 0 },
						agent: { id: "agt_env", version: 1 },
						environment_id: "env_1",
						title: null,
						created_at: "2026-11-22T00:00:00.000Z",
						updated_at: "2026-11-22T00:00:00.000Z",
						archived_at: null,
					}),
				)
				return
			}
			res.writeHead(404, { "content-type": "application/json" })
			res.end(
				JSON.stringify({
					type: "error",
					error: { type: "not_found_error", message: "not found" },
					request_id: "req_env",
				}),
			)
		})
		await Promise.all([
			new Promise<void>((resolve) => {
				evilServer.listen(0, "127.0.0.1", resolve)
			}),
			new Promise<void>((resolve) => {
				legitServer.listen(0, "127.0.0.1", resolve)
			}),
		])
		const untrustedDir = mkdtempSync(join(tmpdir(), "checkfu-untrusted-cwd-"))
		const cleanDir = mkdtempSync(join(tmpdir(), "checkfu-clean-cwd-"))
		try {
			const evilPort = (evilServer.address() as { port: number }).port
			const legitPort = (legitServer.address() as { port: number }).port
			const nestedWorkDir = join(untrustedDir, "packages", "app")
			mkdirSync(nestedWorkDir, { recursive: true })
			for (const dir of [untrustedDir, nestedWorkDir]) {
				writeFileSync(
					join(dir, ".env"),
					`CHECKFU_API_KEY=ck_from_untrusted_dotenv\nCHECKFU_API_URL=http://127.0.0.1:${evilPort}\n`,
				)
				writeFileSync(join(dir, ".env.local"), `CHECKFU_URL=http://127.0.0.1:${evilPort}\n`)
				writeFileSync(
					join(dir, "evil-preload.js"),
					'process.stderr.write("PRELOAD_EXECUTED\\n"); process.exit(99);\n',
				)
				writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./evil-preload.js"]\n')
			}
			const baseEnv = cliProcessEnv({ CHECKFU_CONFIG_DIR: cleanDir })
			const runBun = (
				args: ReadonlyArray<string>,
				env: Record<string, string>,
				cwd = nestedWorkDir,
			) =>
				new Promise<{
					readonly status: number | null
					readonly stdout: string
					readonly stderr: string
				}>((resolve, reject) => {
					const child = spawn("bun", [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
					let stdout = ""
					let stderr = ""
					child.stdout.setEncoding("utf8")
					child.stderr.setEncoding("utf8")
					child.stdout.on("data", (chunk: string) => {
						stdout += chunk
					})
					child.stderr.on("data", (chunk: string) => {
						stderr += chunk
					})
					child.on("error", reject)
					child.on("close", (status) => resolve({ status, stdout, stderr }))
				})
			const retrieve = ["sessions", "retrieve", "--session-id", "sess_env"]

			const exported = await runBun([...PINNED_BUN_FLAGS, mainPath, ...retrieve], {
				...baseEnv,
				CHECKFU_API_KEY: "ck_dummy_exported_secret",
				CHECKFU_API_URL: `http://127.0.0.1:${legitPort}`,
			})
			expect(exported.status).toBe(0)
			expect(exported.stderr).not.toContain("PRELOAD_EXECUTED")
			expect(legitHits).toBe(1)
			expect(evilHits).toBe(0)

			const nothingExported = await runBun([...PINNED_BUN_FLAGS, mainPath, ...retrieve], baseEnv)
			expect(nothingExported.status).toBe(1)
			expect(nothingExported.stderr).toContain("Missing CHECKFU_API_KEY")
			expect(nothingExported.stderr).not.toContain("PRELOAD_EXECUTED")
			expect(evilHits).toBe(0)

			for (const unpinned of [[], ["--no-env-file"], [PINNED_BUN_FLAGS[1]]]) {
				const direct = await runBun(
					[...unpinned, mainPath, ...retrieve],
					{
						...baseEnv,
						CHECKFU_API_KEY: "ck_exported_secret",
						CHECKFU_API_URL: `http://127.0.0.1:${legitPort}`,
					},
					cleanDir,
				)
				expect(direct.status).toBe(1)
				expect(direct.stderr).toContain("bun checkfu")
			}
			expect(legitHits).toBe(1)
			expect(evilHits).toBe(0)
		} finally {
			rmSync(untrustedDir, { recursive: true, force: true })
			rmSync(cleanDir, { recursive: true, force: true })
			await Promise.all([
				new Promise<void>((resolve) => {
					evilServer.close(() => {
						resolve()
					})
				}),
				new Promise<void>((resolve) => {
					legitServer.close(() => {
						resolve()
					})
				}),
			])
		}
	}, 25_000)

	it("skips replayed SSE sequence numbers and rechecks lagging running snapshots", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context())
					const turn1Gate = yield* Deferred.make<void>()
					const replayCli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									yield* Deferred.await(turn1Gate)
								}
								return {
									thinking: null,
									text: `Turn${args.turn}:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const replaySessionId = yield* createReadySession(replayCli)
					let streamConnections = 0
					let savedInitialFrames = ""
					const replayRes = yield* replayCli.run(
						["sessions", "connect", "--session-id", replaySessionId],
						{
							stdin: "first\nsecond\n",
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								streamConnections += 1
								const conn = streamConnections
								const res = await next(request)
								if (res.status !== 200 || res.body === null) {
									return res
								}
								const reader = res.body.getReader()
								const decoder = new TextDecoder()
								const encoder = new TextEncoder()
								if (conn === 1) {
									let buffered = ""
									let errored = false
									const dropping = new ReadableStream<Uint8Array>({
										async pull(controller) {
											if (errored) {
												return
											}
											const chunk = await reader.read()
											if (chunk.done) {
												controller.close()
												return
											}
											const text = decoder.decode(chunk.value, { stream: true })
											buffered += text
											controller.enqueue(chunk.value)
											if (buffered.includes("session.status_running")) {
												savedInitialFrames = buffered
												errored = true
												await reader.cancel()
												controller.error(new TypeError("simulated drop after turn 1 running"))
											}
										},
										cancel(reason) {
											return reader.cancel(reason)
										},
									})
									return new Response(dropping, { status: 200, headers: res.headers })
								}
								let replayedPrefix = false
								const replaying = new ReadableStream<Uint8Array>({
									async pull(controller) {
										if (!replayedPrefix) {
											replayedPrefix = true
											controller.enqueue(encoder.encode(savedInitialFrames))
											await runPromise(Deferred.succeed(turn1Gate, undefined))
											return
										}
										const chunk = await reader.read()
										if (chunk.done) {
											controller.close()
											return
										}
										controller.enqueue(chunk.value)
									},
									cancel(reason) {
										return reader.cancel(reason)
									},
								})
								return new Response(replaying, { status: 200, headers: res.headers })
							},
						},
					)
					expect(streamConnections).toBeGreaterThanOrEqual(2)
					expect(replayRes.exitCode).toBe(0)
					expect(replayRes.stdout).toContain("Turn1:first")
					expect(replayRes.stdout).toContain("Turn2:second")
					expect(replayRes.stdout.split("[user] first")).toHaveLength(2)

					const lagTurn1Running = yield* Deferred.make<void>()
					const releaseLagTurn1 = yield* Deferred.make<void>()
					const lagCli = yield* makeTestServer({
						generate: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(lagTurn1Running, undefined)
								yield* Deferred.await(releaseLagTurn1)
								return {
									thinking: null,
									text: "Refused lag turn 1",
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "refusal" as const },
								}
							}),
					})
					const lagSessionId = yield* createReadySession(lagCli)
					const encoder = new TextEncoder()
					let lagPosts = 0
					let lagGets = 0
					const lagStdin = Stream.concat(
						Stream.make(encoder.encode("turn 1\n")),
						Stream.fromEffect(
							Deferred.await(lagTurn1Running).pipe(Effect.as(encoder.encode("queued turn 2\n"))),
						),
					)
					const [lagDuration, lagRes] = yield* Effect.timed(
						lagCli.run(["sessions", "connect", "--session-id", lagSessionId], {
							stdin: lagStdin,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									lagPosts += 1
									const res = await next(request)
									if (lagPosts === 2) {
										await runPromise(Deferred.succeed(releaseLagTurn1, undefined))
									}
									return res
								}
								if (request.method === "GET" && request.url.endsWith(`/sessions/${lagSessionId}`)) {
									lagGets += 1
									const res = await next(request)
									if (lagGets === 2 || lagGets === 3) {
										const body = (await res.json()) as { status?: string; turn?: number }
										return new Response(JSON.stringify({ ...body, status: "running", turn: 1 }), {
											status: 200,
											headers: { "content-type": "application/json" },
										})
									}
									return res
								}
								return next(request)
							},
						}),
					)
					expect(lagGets).toBe(4)
					expect(Duration.toMillis(lagDuration)).toBeLessThan(2000)
					expect(lagRes.exitCode).toBe(1)
					expect(lagRes.stderr).toContain(
						"Queued turn 2 did not start because turn 1 stopped with refusal.",
					)

					const raceTurn1Running = yield* Deferred.make<void>()
					const releaseRaceTurn1 = yield* Deferred.make<void>()
					const lookupInFlight = yield* Deferred.make<void>()
					const archivedRendered = yield* Deferred.make<void>()
					const raceCli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									yield* Deferred.succeed(raceTurn1Running, undefined)
									yield* Deferred.await(releaseRaceTurn1)
									return {
										thinking: null,
										text: "Refused turn 1",
										input_tokens: 2,
										output_tokens: 2,
										stop_reason: { type: "refusal" as const },
									}
								}
								return {
									thinking: null,
									text: `CompletedTurn2:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const raceSessionId = yield* createReadySession(raceCli)
					const otherClientDone = yield* Deferred.await(lookupInFlight).pipe(
						Effect.andThen(
							raceCli.run([
								"sessions:events",
								"send",
								"--session-id",
								raceSessionId,
								"--event",
								JSON.stringify({
									type: "user.message",
									content: [{ type: "text", text: "trigger turn 2" }],
								}),
							]),
						),
						Effect.andThen(
							Effect.gen(function* () {
								for (let i = 0; i < 200; i++) {
									const s = yield* raceCli.run([
										"sessions",
										"retrieve",
										"--session-id",
										raceSessionId,
									])
									const parsed = JSON.parse(s.stdout) as { status: string; turn: number }
									if (parsed.status === "idle" && parsed.turn === 2) {
										break
									}
									yield* Effect.sleep("5 millis")
								}
							}),
						),
						Effect.andThen(raceCli.run(["sessions", "archive", "--session-id", raceSessionId])),
						Effect.forkChild,
					)
					let racePosts = 0
					let raceGets = 0
					const raceStdin = Stream.concat(
						Stream.make(encoder.encode("race turn 1\n")),
						Stream.fromEffect(
							Deferred.await(raceTurn1Running).pipe(
								Effect.as(encoder.encode("race queued turn 2\n")),
							),
						),
					)
					const raceRes = yield* raceCli.run(
						["sessions", "connect", "--session-id", raceSessionId],
						{
							stdin: raceStdin,
							onStdoutChunk: (chunk) =>
								chunk.includes("CompletedTurn2:") ? Effect.void : Effect.void,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									racePosts += 1
									const res = await next(request)
									if (racePosts === 2) {
										await runPromise(Deferred.succeed(releaseRaceTurn1, undefined))
									}
									return res
								}
								if (
									request.method === "GET" &&
									request.url.endsWith(`/sessions/${raceSessionId}`)
								) {
									raceGets += 1
									if (raceGets === 2) {
										const paused = new Promise<void>((resolve) => {
											if (request.signal.aborted) {
												resolve()
												return
											}
											const done = () => resolve()
											request.signal.addEventListener("abort", done, { once: true })
											void runPromise(Deferred.await(archivedRendered)).then(done)
										})
										await runPromise(Deferred.succeed(lookupInFlight, undefined))
										await paused
										if (request.signal.aborted) {
											throw new DOMException("Aborted", "AbortError")
										}
									}
									return next(request)
								}
								if (request.url.includes("/events/stream")) {
									const res = await next(request)
									if (res.status !== 200 || res.body === null) {
										return res
									}
									const reader = res.body.getReader()
									const decoder = new TextDecoder()
									let sawArchived = false
									const observed = new ReadableStream<Uint8Array>({
										async pull(controller) {
											const chunk = await reader.read()
											if (chunk.done) {
												if (sawArchived) {
													await runPromise(Deferred.succeed(archivedRendered, undefined))
												}
												controller.close()
												return
											}
											const text = decoder.decode(chunk.value, { stream: true })
											if (text.includes("session.archived")) {
												sawArchived = true
											}
											controller.enqueue(chunk.value)
										},
										cancel(reason) {
											return reader.cancel(reason)
										},
									})
									return new Response(observed, { status: 200, headers: res.headers })
								}
								return next(request)
							},
						},
					)
					yield* Fiber.await(otherClientDone)
					expect(raceGets).toBe(2)
					expect(raceRes.exitCode).toBe(0)
					expect(raceRes.stdout).toContain("CompletedTurn2:")

					const malformedCli = yield* makeTestServer()
					const malformedSessionId = yield* createReadySession(malformedCli)
					const malformedConnect = yield* malformedCli.run(
						["sessions", "connect", "--session-id", malformedSessionId],
						{
							stdin: "hello\n",
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								return new Response('id: 2\nevent: session.status_idle\ndata: {"seq":2}\n\n', {
									status: 200,
									headers: { "content-type": "text/event-stream; charset=utf-8" },
								})
							},
						},
					)
					expect(malformedConnect.exitCode).toBe(1)
					expect(malformedConnect.stderr).toContain("Invalid SSE event payload")

					const malformedStream = yield* malformedCli.run(
						["sessions:events", "stream", "--session-id", malformedSessionId],
						{
							interceptFetch: async (next, request) => {
								if (!request.url.includes("/events/stream")) {
									return next(request)
								}
								return new Response('id: 2\nevent: session.status_idle\ndata: {"seq":2}\n\n', {
									status: 200,
									headers: { "content-type": "text/event-stream; charset=utf-8" },
								})
							},
						},
					)
					expect(malformedStream.exitCode).toBe(1)
					expect(malformedStream.stderr).toContain("Invalid SSE event payload")
				}),
			),
		)
	}, 15_000)

	it("aborts or ignores halted-queue status lookups once SSE confirms the turn started, while still failing when truly halted or given invalid UTF-8 stdin", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
					const encoder = new TextEncoder()

					const failTurn1Running = yield* Deferred.make<void>()
					const releaseFailTurn1 = yield* Deferred.make<void>()
					const releaseFailTurn2 = yield* Deferred.make<void>()
					const failLookupInFlight = yield* Deferred.make<void>()
					const sseTurn2RunningDelivered = yield* Deferred.make<void>()
					const failCli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									yield* Deferred.succeed(failTurn1Running, undefined)
									yield* Deferred.await(releaseFailTurn1)
									return {
										thinking: null,
										text: "Refused turn 1",
										input_tokens: 2,
										output_tokens: 2,
										stop_reason: { type: "refusal" as const },
									}
								}
								yield* Deferred.await(releaseFailTurn2)
								return {
									thinking: null,
									text: `RecoveredTurn2:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const failSessionId = yield* createReadySession(failCli)
					const triggerFailTurn2 = yield* Deferred.await(failLookupInFlight).pipe(
						Effect.andThen(
							failCli.run([
								"sessions:events",
								"send",
								"--session-id",
								failSessionId,
								"--event",
								JSON.stringify({
									type: "user.message",
									content: [{ type: "text", text: "resume turn 2" }],
								}),
							]),
						),
						Effect.forkChild,
					)
					let failPosts = 0
					let failGets = 0
					let failGetAborted = false
					const failStdin = Stream.concat(
						Stream.make(encoder.encode("turn 1\n")),
						Stream.fromEffect(
							Deferred.await(failTurn1Running).pipe(Effect.as(encoder.encode("queued turn 2\n"))),
						),
					)
					const failRes = yield* failCli.run(
						["sessions", "connect", "--session-id", failSessionId],
						{
							stdin: failStdin,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									failPosts += 1
									const res = await next(request)
									if (failPosts === 2) {
										await runPromise(Deferred.succeed(releaseFailTurn1, undefined))
									}
									return res
								}
								if (request.url.includes("/events/stream")) {
									const res = await next(request)
									if (res.status !== 200 || res.body === null) {
										return res
									}
									const reader = res.body.getReader()
									const decoder = new TextDecoder()
									let sseBuffer = ""
									const observed = new ReadableStream<Uint8Array>({
										async pull(controller) {
											const chunk = await reader.read()
											if (chunk.done) {
												controller.close()
												return
											}
											sseBuffer += decoder.decode(chunk.value, { stream: true })
											controller.enqueue(chunk.value)
											if ((sseBuffer.match(/event: session\.status_running/g) ?? []).length >= 2) {
												await runPromise(Deferred.succeed(sseTurn2RunningDelivered, undefined))
											}
										},
										cancel(reason) {
											return reader.cancel(reason)
										},
									})
									return new Response(observed, { status: 200, headers: res.headers })
								}
								if (
									request.method === "GET" &&
									request.url.endsWith(`/sessions/${failSessionId}`)
								) {
									failGets += 1
									if (failGets === 2) {
										const releaseOnAbort = () => {
											failGetAborted = true
											void runPromise(Deferred.succeed(releaseFailTurn2, undefined))
										}
										request.signal.addEventListener("abort", releaseOnAbort, { once: true })
										await runPromise(Deferred.succeed(failLookupInFlight, undefined))
										await runPromise(Deferred.await(sseTurn2RunningDelivered))
										if (!request.signal.aborted) {
											await new Promise<void>((resolve) => {
												const timer = setTimeout(resolve, 60)
												request.signal.addEventListener(
													"abort",
													() => {
														clearTimeout(timer)
														resolve()
													},
													{ once: true },
												)
											})
										}
										if (request.signal.aborted) {
											throw new DOMException("Aborted", "AbortError")
										}
										setTimeout(() => {
											void runPromise(Deferred.succeed(releaseFailTurn2, undefined))
										}, 20)
										return new Response(
											JSON.stringify({
												type: "error",
												error: {
													type: "authentication_error",
													message: "Simulated lookup failure",
												},
												request_id: "req_fail_401",
											}),
											{ status: 401, headers: { "content-type": "application/json" } },
										)
									}
								}
								return next(request)
							},
						},
					)
					yield* Fiber.await(triggerFailTurn2)
					expect(failGets).toBe(2)
					expect(failGetAborted).toBe(true)
					expect(failRes.exitCode).toBe(0)
					expect(failRes.stdout).toContain("RecoveredTurn2:")

					const stallTurn1Running = yield* Deferred.make<void>()
					const releaseStallTurn1 = yield* Deferred.make<void>()
					const stallLookupInFlight = yield* Deferred.make<void>()
					const stallCli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									yield* Deferred.succeed(stallTurn1Running, undefined)
									yield* Deferred.await(releaseStallTurn1)
									return {
										thinking: null,
										text: "Refused turn 1",
										input_tokens: 2,
										output_tokens: 2,
										stop_reason: { type: "refusal" as const },
									}
								}
								return {
									thinking: null,
									text: `UnblockedTurn2:${args.input.join("|")}`,
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "end_turn" as const },
								}
							}),
					})
					const stallSessionId = yield* createReadySession(stallCli)
					const triggerStallTurn2 = yield* Deferred.await(stallLookupInFlight).pipe(
						Effect.andThen(
							stallCli.run([
								"sessions:events",
								"send",
								"--session-id",
								stallSessionId,
								"--event",
								JSON.stringify({
									type: "user.message",
									content: [{ type: "text", text: "unblock turn 2" }],
								}),
							]),
						),
						Effect.forkChild,
					)
					let stallPosts = 0
					let stallGets = 0
					let stalledGetAborted = false
					const stallStdin = Stream.concat(
						Stream.make(encoder.encode("stall turn 1\n")),
						Stream.fromEffect(
							Deferred.await(stallTurn1Running).pipe(Effect.as(encoder.encode("stall queued 2\n"))),
						),
					)
					const stallOutcome = yield* Effect.race(
						stallCli
							.run(["sessions", "connect", "--session-id", stallSessionId], {
								stdin: stallStdin,
								interceptFetch: async (next, request) => {
									if (request.method === "POST" && request.url.endsWith("/events")) {
										stallPosts += 1
										const res = await next(request)
										if (stallPosts === 2) {
											await runPromise(Deferred.succeed(releaseStallTurn1, undefined))
										}
										return res
									}
									if (
										request.method === "GET" &&
										request.url.endsWith(`/sessions/${stallSessionId}`)
									) {
										stallGets += 1
										if (stallGets === 2) {
											const waitForAbort = new Promise<Response>((_resolve, reject) => {
												const onAbort = () => {
													stalledGetAborted = true
													reject(new DOMException("Aborted", "AbortError"))
												}
												if (request.signal.aborted) {
													onAbort()
													return
												}
												request.signal.addEventListener("abort", onAbort, { once: true })
											})
											await runPromise(Deferred.succeed(stallLookupInFlight, undefined))
											return await waitForAbort
										}
									}
									return next(request)
								},
							})
							.pipe(Effect.map((res) => ({ _tag: "done" as const, res }))),
						Effect.sleep("2 seconds").pipe(Effect.as({ _tag: "timeout" as const })),
					)
					yield* Fiber.await(triggerStallTurn2)
					expect(stallOutcome._tag).toBe("done")
					if (stallOutcome._tag === "done") {
						expect(stallGets).toBe(2)
						expect(stalledGetAborted).toBe(true)
						expect(stallOutcome.res.exitCode).toBe(0)
						expect(stallOutcome.res.stdout).toContain("UnblockedTurn2:")
					}

					const haltedTurn1Running = yield* Deferred.make<void>()
					const releaseHaltedTurn1 = yield* Deferred.make<void>()
					const haltedCli = yield* makeTestServer({
						generate: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(haltedTurn1Running, undefined)
								yield* Deferred.await(releaseHaltedTurn1)
								return {
									thinking: null,
									text: "Refused turn 1",
									input_tokens: 2,
									output_tokens: 2,
									stop_reason: { type: "refusal" as const },
								}
							}),
					})
					const haltedSessionId = yield* createReadySession(haltedCli)
					let haltedPosts = 0
					let haltedGets = 0
					const haltedStdin = Stream.concat(
						Stream.make(encoder.encode("halted turn 1\n")),
						Stream.fromEffect(
							Deferred.await(haltedTurn1Running).pipe(
								Effect.as(encoder.encode("halted queued 2\n")),
							),
						),
					)
					const haltedRes = yield* haltedCli.run(
						["sessions", "connect", "--session-id", haltedSessionId],
						{
							stdin: haltedStdin,
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									haltedPosts += 1
									const res = await next(request)
									if (haltedPosts === 2) {
										await runPromise(Deferred.succeed(releaseHaltedTurn1, undefined))
									}
									return res
								}
								if (
									request.method === "GET" &&
									request.url.endsWith(`/sessions/${haltedSessionId}`)
								) {
									haltedGets += 1
									if (haltedGets === 2) {
										return new Response(
											JSON.stringify({
												type: "error",
												error: {
													type: "authentication_error",
													message: "Halted lookup unauthorized",
												},
												request_id: "req_halted_401",
											}),
											{ status: 401, headers: { "content-type": "application/json" } },
										)
									}
								}
								return next(request)
							},
						},
					)
					expect(haltedGets).toBe(2)
					expect(haltedRes.exitCode).toBe(1)
					expect(haltedRes.stderr).toContain("401")
					expect(haltedRes.stderr).toContain("Halted lookup unauthorized")

					const badUtf8Cli = yield* makeTestServer()
					const badUtf8SessionId = yield* createReadySession(badUtf8Cli)
					let badUtf8Posts = 0
					const badUtf8Res = yield* badUtf8Cli.run(
						["sessions", "connect", "--session-id", badUtf8SessionId],
						{
							stdin: Stream.make(new Uint8Array([0x68, 0x69, 0xff, 0x0a])),
							interceptFetch: async (next, request) => {
								if (request.method === "POST" && request.url.endsWith("/events")) {
									badUtf8Posts += 1
								}
								return next(request)
							},
						},
					)
					expect(badUtf8Res.exitCode).toBe(1)
					expect(badUtf8Res.stderr).toContain("stdin")
					expect(badUtf8Res.stderr).toContain("not valid UTF-8")
					expect(badUtf8Posts).toBe(0)
				}),
			),
		)
	}, 15_000)

	it("scopes the TTY Ctrl-C disconnect latch to the interrupted turn so a newly started queued turn is interrupted instead of disconnecting", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
					const turn1Started = yield* Deferred.make<void>()
					const turn1Interrupted = yield* Deferred.make<void>()
					const turn2Started = yield* Deferred.make<void>()
					const turn2Interrupted = yield* Deferred.make<void>()
					const turn2RunningObserved = yield* Deferred.make<void>()
					const sigintController = makeSigintController()

					const cli = yield* makeTestServer({
						generate: (args) =>
							Effect.gen(function* () {
								if (args.turn === 1) {
									yield* Deferred.succeed(turn1Started, undefined)
									yield* Deferred.await(turn1Interrupted)
									return yield* Effect.fail({
										_tag: "TurnInterrupted" as const,
										model_usage: { input_tokens: 2, output_tokens: 0 },
									})
								}
								yield* Deferred.succeed(turn2Started, undefined)
								yield* Deferred.await(turn2Interrupted)
								return yield* Effect.fail({
									_tag: "TurnInterrupted" as const,
									model_usage: { input_tokens: 2, output_tokens: 0 },
								})
							}),
						interrupt: (args) =>
							args.turn === 1
								? Deferred.succeed(turn1Interrupted, undefined).pipe(Effect.asVoid)
								: Deferred.succeed(turn2Interrupted, undefined).pipe(Effect.asVoid),
					})
					const sessionId = yield* createReadySession(cli)

					let turn1FirstCtrlC = false
					let turn2FirstCtrlC = false
					let turn2SecondCtrlC = true

					const result = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdinIsTerminal: true,
						sigintController,
						interceptFetch: async (next, request) => {
							if (!request.url.includes("/events/stream")) {
								return next(request)
							}
							const res = await next(request)
							if (res.status !== 200 || res.body === null) {
								return res
							}
							const reader = res.body.getReader()
							const decoder = new TextDecoder()
							let sseBuffer = ""
							const observed = new ReadableStream<Uint8Array>({
								async pull(controller) {
									const chunk = await reader.read()
									if (chunk.done) {
										controller.close()
										return
									}
									sseBuffer += decoder.decode(chunk.value, { stream: true })
									controller.enqueue(chunk.value)
									if ((sseBuffer.match(/event: session\.status_running/g) ?? []).length >= 2) {
										await runPromise(Deferred.succeed(turn2RunningObserved, undefined))
									}
								},
								cancel(reason) {
									return reader.cancel(reason)
								},
							})
							return new Response(observed, { status: 200, headers: res.headers })
						},
						terminalReads: [
							Effect.succeed("first turn"),
							Deferred.await(turn1Started).pipe(Effect.as("already queued turn 2")),
							Effect.gen(function* () {
								yield* Effect.sleep("25 millis")
								turn1FirstCtrlC = sigintController.handleSigint()
								yield* Deferred.await(turn1Interrupted)
								yield* Deferred.await(turn2Started)
								yield* Deferred.await(turn2RunningObserved)
								yield* Effect.sleep("25 millis")
								turn2FirstCtrlC = sigintController.handleSigint()
								turn2SecondCtrlC = sigintController.handleSigint()
								if (turn2FirstCtrlC) {
									yield* Deferred.await(turn2Interrupted)
									yield* Effect.sleep("40 millis")
								}
								return "/exit"
							}),
						],
					})

					expect(result.exitCode).toBe(0)
					expect(turn1FirstCtrlC).toBe(true)
					expect(turn2FirstCtrlC).toBe(true)
					expect(turn2SecondCtrlC).toBe(false)

					const eventsRes = yield* cli.run([
						"sessions:events",
						"list",
						"--session-id",
						sessionId,
						"--transform",
						"data.#.type",
					])
					expect(eventsRes.exitCode).toBe(0)
					const eventTypes = JSON.parse(eventsRes.stdout) as Array<string>
					expect(eventTypes.filter((t) => t === "user.interrupt")).toHaveLength(2)
				}),
			),
		)
	})

	it("detects unread piped input waiting in a subsequent chunk when the session ends after an earlier turn settles", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
					const encoder = new TextEncoder()
					const cli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `Reply-${args.turn}:${args.input.join("|")}`,
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const sessionId = yield* createReadySession(cli)
					const turn1Rendered = yield* Deferred.make<void>()
					const releaseSecondChunk = yield* Deferred.make<void>()

					const archiver = yield* Deferred.await(turn1Rendered).pipe(
						Effect.andThen(Effect.sleep("25 millis")),
						Effect.andThen(cli.run(["sessions", "archive", "--session-id", sessionId])),
						Effect.forkChild,
					)

					const pipedStdin = Stream.concat(
						Stream.make(encoder.encode("first turn\n")),
						Stream.fromEffect(
							Deferred.await(releaseSecondChunk).pipe(
								Effect.as(encoder.encode("second unread turn\n")),
							),
						),
					)

					const res = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdin: pipedStdin,
						onStdoutChunk: (chunk) =>
							chunk.includes("Reply-1:first turn")
								? Deferred.succeed(turn1Rendered, undefined).pipe(Effect.asVoid)
								: Effect.void,
						interceptFetch: async (next, request) => {
							if (!request.url.includes("/events/stream")) {
								return next(request)
							}
							const response = await next(request)
							if (response.status !== 200 || response.body === null) {
								return response
							}
							const reader = response.body.getReader()
							const decoder = new TextDecoder()
							const observed = new ReadableStream<Uint8Array>({
								async pull(controller) {
									const chunk = await reader.read()
									if (chunk.done) {
										controller.close()
										return
									}
									const text = decoder.decode(chunk.value, { stream: true })
									controller.enqueue(chunk.value)
									if (text.includes("session.archived")) {
										setTimeout(() => {
											void runPromise(Deferred.succeed(releaseSecondChunk, undefined))
										}, 5)
									}
								},
								cancel(reason) {
									return reader.cancel(reason)
								},
							})
							return new Response(observed, { status: 200, headers: response.headers })
						},
					})
					yield* Fiber.await(archiver)

					expect(res.exitCode).toBe(1)
					expect(res.stdout).toContain("Reply-1:first turn")
					expect(res.stderr).toContain("ended before buffered input was submitted")
				}),
			),
		)
	})

	it("connects and resumes cleanly against a legacy /v1 server omitting turn from status events", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer({
						generate: (args) =>
							Effect.succeed({
								thinking: null,
								text: `LegacyT${args.turn}:${args.input.join("|")}`,
								input_tokens: 2,
								output_tokens: 2,
								stop_reason: { type: "end_turn" as const },
							}),
					})
					const sessionId = yield* createReadySession(cli)

					const stripTurnFromStatusEvents = async (
						next: (request: Request) => Promise<Response>,
						request: Request,
					): Promise<Response> => {
						const url = new URL(request.url)
						if (request.method === "GET" && url.pathname.endsWith("/events")) {
							const real = await next(request)
							if (real.status !== 200) {
								return real
							}
							const body = (await real.json()) as {
								readonly data: Array<{ readonly type?: string; readonly turn?: number }>
								readonly has_more: boolean
								readonly next_cursor: number | null
							}
							const stripped = body.data.map((entry) => {
								if (
									entry.type === "session.status_running" ||
									entry.type === "session.status_idle"
								) {
									const { turn: _omitted, ...rest } = entry
									return rest
								}
								return entry
							})
							return new Response(JSON.stringify({ ...body, data: stripped }), {
								status: 200,
								headers: { "content-type": "application/json" },
							})
						}
						if (request.method === "GET" && url.pathname.endsWith("/events/stream")) {
							const real = await next(request)
							if (real.status !== 200 || real.body === null) {
								return real
							}
							const reader = real.body.getReader()
							const decoder = new TextDecoder()
							const encoder = new TextEncoder()
							const strippedBody = new ReadableStream<Uint8Array>({
								async pull(controller) {
									const chunk = await reader.read()
									if (chunk.done) {
										controller.close()
										return
									}
									const text = decoder.decode(chunk.value, { stream: true })
									const rewritten = text.replaceAll(/"turn":\d+,?/g, "").replaceAll(",}", "}")
									controller.enqueue(encoder.encode(rewritten))
								},
								cancel(reason) {
									return reader.cancel(reason)
								},
							})
							return new Response(strippedBody, { status: 200, headers: real.headers })
						}
						return next(request)
					}

					const firstTurn = yield* cli.run(["sessions", "connect", "--session-id", sessionId], {
						stdin: "hello legacy\n",
						interceptFetch: stripTurnFromStatusEvents,
					})
					expect(firstTurn.exitCode).toBe(0)
					expect(firstTurn.stdout).toContain("LegacyT1:hello legacy")

					const latestList = JSON.parse(
						(yield* cli.run([
							"sessions:events",
							"list",
							"--session-id",
							sessionId,
							"--limit",
							"1",
							"--order",
							"desc",
						])).stdout,
					) as { data: Array<{ seq: number }> }
					const headSeq = latestList.data[0]?.seq ?? 0
					expect(headSeq).toBeGreaterThan(0)

					let prefixScanSeen = false
					const resumed = yield* cli.run(
						["sessions", "connect", "--session-id", sessionId, "--after", String(headSeq)],
						{
							stdin: "second legacy\n",
							interceptFetch: async (next, request) => {
								const url = new URL(request.url)
								if (
									request.method === "GET" &&
									url.pathname.endsWith("/events") &&
									url.searchParams.get("order") === "asc"
								) {
									prefixScanSeen = true
								}
								return stripTurnFromStatusEvents(next, request)
							},
						},
					)
					expect(resumed.exitCode).toBe(0)
					expect(prefixScanSeen).toBe(true)
					expect(resumed.stdout).toContain("LegacyT2:second legacy")
				}),
			),
		)
	})
})
