import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { MAX_MESSAGE_TEXT_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	PI_SEED_MAX_CHARS,
	PI_SEED_MAX_MESSAGES,
	SEED_MESSAGE_OVERHEAD_TOKENS,
	estimateSeedTokens,
	seedTokenBudget,
	trimTailToBudget,
} from "../src/Pi/PiContextBudget.ts"
import { conversationName } from "../src/Pi/PiDurableHarness.ts"
import {
	AUTH_HEADERS,
	createIdleSession,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
	waitForSession,
} from "./helpers/ApiHarness.ts"

describe("Pi history recovery and small-context budgeting", () => {
	it.live(
		"rebuilds the Pi conversation from the event log when Pi's state is gone, and sends no history otherwise",
		() => {
			const textOf = (message: TranscriptContext["messages"][number]) =>
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
			const contexts: Array<ReadonlyArray<{ readonly role: string; readonly text: string }>> = []
			const { layer, requests, forgetPiState } = makePiDurableTestLayer(async (model, context) => {
				contexts.push(
					context.messages
						.filter((message) => message.role === "user" || message.role === "assistant")
						.map((message) => ({ role: message.role, text: textOf(message) })),
				)
				return makeAssistantReply(model, null, `Echo: ${extractLastUserText(context)}`, 1, 1)
			})

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const session = yield* createIdleSession(apiFetch)
				const runTurn = (text: string, turn: number) =>
					sendAndSettle(apiFetch, session.id, [text], turn)

				yield* runTurn("one", 1)
				yield* runTurn("two", 2)
				expect(requests.map((request) => request.seed)).toEqual([undefined, undefined])

				yield* Effect.promise(() => forgetPiState(conversationName(session.id, 0)))
				yield* runTurn("three", 3)
				const earlier = [
					{ role: "user", text: "one" },
					{ role: "assistant", text: "Echo: one" },
					{ role: "user", text: "two" },
					{ role: "assistant", text: "Echo: two" },
				]
				expect(requests.map((request) => request.seed?.messages)).toEqual([
					undefined,
					undefined,
					undefined,
					earlier,
				])
				expect(contexts.at(-1)).toEqual([...earlier, { role: "user", text: "three" }])

				yield* runTurn("four", 4)
				expect(requests.at(-1)?.seed).toBeUndefined()
				expect(contexts.at(-1)).toHaveLength(7)
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)

	it.live(
		"continues a truncated reply from exactly the assistant text published to the session",
		() => {
			const prefix = "p".repeat(MAX_MESSAGE_TEXT_LENGTH)
			const history: Array<string> = []
			const { layer } = makePiDurableTestLayer(async (model, context) => {
				for (const message of context.messages) {
					if (message.role === "assistant") {
						history.push(
							message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
						)
					}
				}
				const text =
					extractLastUserText(context) === "First" ? prefix + "unpublished suffix" : "Done"
				return makeAssistantReply(model, null, text, 5, 1)
			})

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const session = yield* createIdleSession(apiFetch)
				yield* sendAndSettle(apiFetch, session.id, ["First"], 1)
				const views = yield* SessionView
				const page = yield* views.list(Session.ref(session.id))
				const published = page.entries
					.map((entry) => entry.event)
					.find((event) => event._tag === "agent.message")
				expect(published).toMatchObject({
					content: [{ type: "text", text: prefix }],
					truncated: true,
				})
				yield* sendAndSettle(apiFetch, session.id, ["Next"], 2)
				expect(history).toEqual([prefix])
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)

	it.live(
		"rebuilds from the newest events backwards across pages and stops at the seed budget",
		() => {
			const { layer, requests, forgetPiState } = makePiDurableTestLayer(async (model, context) =>
				makeAssistantReply(model, null, `re: ${extractLastUserText(context).slice(0, 8)}`, 1, 1),
			)

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler

				const long = yield* createIdleSession(apiFetch)
				const expected: Array<{ role: string; text: string }> = []
				for (let turn = 1; turn <= 18; turn++) {
					yield* sendAndSettle(apiFetch, long.id, [`q${turn}`], turn)
					expected.push(
						{ role: "user", text: `q${turn}` },
						{ role: "assistant", text: `re: q${turn}` },
					)
				}
				yield* Effect.promise(() => forgetPiState(conversationName(long.id, 0)))
				yield* sendAndSettle(apiFetch, long.id, ["q19"], 19)
				expect(requests.at(-1)?.seed?.messages).toEqual(expected)

				const heavy = yield* createIdleSession(apiFetch)
				const block = "y".repeat(16_384)
				for (let turn = 1; turn <= 8; turn++) {
					yield* sendAndSettle(apiFetch, heavy.id, [block], turn)
				}
				yield* Effect.promise(() => forgetPiState(conversationName(heavy.id, 0)))
				yield* sendAndSettle(apiFetch, heavy.id, ["after"], 9)
				const seed = requests.at(-1)?.seed?.messages ?? []
				expect(seed.reduce((total, message) => total + message.text.length, 0)).toBe(
					PI_SEED_MAX_CHARS,
				)
				expect(seed[0]?.role).toBe("user")
				expect(seed[0]?.text.length).toBeLessThan(block.length)
				expect(seed.at(-1)).toEqual({ role: "assistant", text: "re: yyyyyyyy" })
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)

	it.live(
		"fails a turn whose harness is unreachable, then continues in a fresh conversation rebuilt from the log",
		() => {
			const contexts: Array<ReadonlyArray<string>> = []
			const { layer, requests, unreachable, conversations } = makePiDurableTestLayer(
				async (model, context) => {
					contexts.push(
						context.messages.map((message) =>
							typeof message.content === "string"
								? message.content
								: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
						),
					)
					return makeAssistantReply(model, null, `Echo: ${extractLastUserText(context)}`, 1, 1)
				},
			)

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const session = yield* createIdleSession(apiFetch)
				yield* sendAndSettle(apiFetch, session.id, ["one"], 1)

				unreachable.add(conversationName(session.id, 0))
				yield* sendAndSettle(apiFetch, session.id, ["two"], 2)
				const listed = yield* sendRequest(apiFetch, {
					method: "GET",
					path: `/v1/sessions/${session.id}/events?order=desc&limit=3`,
					headers: AUTH_HEADERS,
				})
				const tail = (
					(yield* Effect.promise(() => listed.json())) as {
						data: ReadonlyArray<{
							type: string
							error?: { type: string; retry_status: { type: string } }
						}>
					}
				).data
				expect(tail.map((event) => event.type)).toEqual([
					"session.status_idle",
					"session.error",
					"span.model_request_end",
				])
				expect(tail[1]?.error).toMatchObject({
					type: "harness_unavailable",
					retry_status: { type: "exhausted" },
				})

				yield* sendAndSettle(apiFetch, session.id, ["three"], 3)
				expect(conversations).toEqual([
					conversationName(session.id, 0),
					conversationName(session.id, 1),
					conversationName(session.id, 1),
				])
				expect(conversationName("s", 1)).not.toBe(conversationName("s#1", 0))
				expect(conversationName("1:s", 0)).not.toBe(conversationName("s", 1))
				expect(requests.at(-1)?.seed?.messages).toEqual([
					{ role: "user", text: "one" },
					{ role: "assistant", text: "Echo: one" },
				])
				expect(contexts.at(-1)).toEqual(["one", "Echo: one", "three"])

				yield* sendAndSettle(apiFetch, session.id, ["four"], 4)
				expect(conversations.at(-1)).toBe(conversationName(session.id, 1))
				expect(requests.at(-1)?.seed).toBeUndefined()
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)

	it.live(
		"ends the turn as unreachable when an interrupt cannot reach the harness, then continues in a fresh conversation",
		() => {
			const gate = Latch.makeUnsafe(false)
			const started = Latch.makeUnsafe(false)
			const { layer, unreachable, conversations } = makePiDurableTestLayer(
				async (model, context) => {
					const text = extractLastUserText(context)
					if (text === "long") {
						started.openUnsafe()
						await Effect.runPromise(gate.await)
					}
					return makeAssistantReply(model, null, `Echo: ${text}`, 1, 1)
				},
			)

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const session = yield* createIdleSession(apiFetch)
				const post = (body: unknown) =>
					sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body,
					})
				yield* post({
					events: [{ type: "user.message", content: [{ type: "text", text: "long" }] }],
				})
				yield* started.await
				unreachable.add(conversationName(session.id, 0))
				expect((yield* post({ events: [{ type: "user.interrupt" }] })).status).toBe(200)
				yield* waitForSession(
					apiFetch,
					session.id,
					(current) => current.status === "idle",
					"interrupted session did not settle idle",
				)

				yield* sendAndSettle(apiFetch, session.id, ["next"], 2)
				const listed = yield* sendRequest(apiFetch, {
					method: "GET",
					path: `/v1/sessions/${session.id}/events`,
					headers: AUTH_HEADERS,
				})
				const events = (
					(yield* Effect.promise(() => listed.json())) as {
						data: ReadonlyArray<{ type: string; error?: { type: string } }>
					}
				).data
				expect(events.map((event) => event.type)).toEqual([
					"user.message",
					"session.status_running",
					"span.model_request_start",
					"user.interrupt",
					"span.model_request_end",
					"session.error",
					"session.status_idle",
					"user.message",
					"session.status_running",
					"span.model_request_start",
					"agent.message",
					"span.model_request_end",
					"session.status_idle",
				])
				expect(events[5]?.error?.type).toBe("harness_unavailable")
				expect(conversations.at(-1)).toBe(conversationName(session.id, 1))
			}).pipe(Effect.ensuring(gate.open), Effect.scoped, Effect.provide(layer))
		},
	)

	it.live(
		"caps a rebuilt conversation at the newest messages",
		() => {
			const { layer, requests, forgetPiState } = makePiDurableTestLayer(async (model) =>
				makeAssistantReply(model, null, "ok", 1, 1),
			)

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const session = yield* createIdleSession(apiFetch)
				const turns = PI_SEED_MAX_MESSAGES / 2 + 5
				for (let turn = 1; turn <= turns; turn++) {
					yield* sendAndSettle(apiFetch, session.id, [`q${turn}`], turn)
				}
				yield* Effect.promise(() => forgetPiState(conversationName(session.id, 0)))
				yield* sendAndSettle(apiFetch, session.id, ["after"], turns + 1)
				const seed = requests.at(-1)?.seed?.messages ?? []
				expect(seed).toHaveLength(PI_SEED_MAX_MESSAGES)
				expect(seed[0]).toEqual({ role: "user", text: "q6" })
				expect(seed.at(-1)).toEqual({ role: "assistant", text: "ok" })
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
		30_000,
	)

	it.live("budgets rebuilt history against small-context models like gpt-4", () => {
		expect(
			seedTokenBudget({
				contextWindow: 8192,
				system: "s".repeat(20_000),
				currentInput: "prompt",
			}),
		).toBe(0)
		// UTF-8 byte bound applies to mixed-case ASCII identifiers as well as non-ASCII.
		expect(estimateSeedTokens("aBcDeFgHiJkLmN")).toBe(14)

		const system = "You are a concise assistant. ".repeat(50) // ~1,450 bytes
		const recoveryBytesSeen: Array<number> = []
		const summaryTokensSeen: Array<number> = []
		let recovered = false
		const { layer, requests, forgetPiState } = makePiDurableTestLayer(async (model, context) => {
			const lastText = extractLastUserText(context)
			if (lastText.startsWith("<conversation>")) {
				summaryTokensSeen.push(Math.ceil(JSON.stringify(context.messages).length / 4))
				return makeAssistantReply(model, null, "Summary.", 200, 30)
			}
			const totalPromptBytes = context.messages.reduce((sum, message) => {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
				return sum + estimateSeedTokens(text) + SEED_MESSAGE_OVERHEAD_TOKENS
			}, 0)
			if (recovered) {
				recoveryBytesSeen.push(totalPromptBytes)
			}
			const approxTokens = Math.ceil(totalPromptBytes / 3)
			return makeAssistantReply(model, null, `reply-${"aBcDeFgH".repeat(400)}`, approxTokens, 1200)
		})

		return Effect.gen(function* () {
			const { fetch: apiFetch } = yield* makeApiHandler
			const agentRes = yield* sendRequest(apiFetch, {
				method: "POST",
				path: "/v1/agents",
				headers: AUTH_HEADERS,
				body: { name: "Small Window Agent", model: "gpt-4", system },
			})
			expect(agentRes.status).toBe(201)
			const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

			const envRes = yield* sendRequest(apiFetch, {
				method: "POST",
				path: "/v1/environments",
				headers: AUTH_HEADERS,
				body: { name: "Env" },
			})
			const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

			const sessRes = yield* sendRequest(apiFetch, {
				method: "POST",
				path: "/v1/sessions",
				headers: AUTH_HEADERS,
				body: { agent: agent.id, environment_id: env.id },
			})
			const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

			// Build ~40,000 bytes of mixed-case ASCII identifier history (far over gpt-4's 8,192-token window).
			for (let turn = 1; turn <= 6; turn++) {
				yield* sendAndSettle(apiFetch, session.id, [`turn-${turn}-${"XkQpLmNz".repeat(400)}`], turn)
			}

			// Lose Pi state and recover on Turn 7 with a substantial prompt.
			yield* Effect.promise(() => forgetPiState(conversationName(session.id, 0)))
			recovered = true
			const currentInput = `turn-7-${"qRstUvWx".repeat(200)}`
			yield* sendAndSettle(apiFetch, session.id, [currentInput], 7)

			const seed = requests.at(-1)?.seed?.messages ?? []
			const seedChars = seed.reduce((sum, message) => sum + message.text.length, 0)
			const seedTokens = seed.reduce(
				(sum, message) => sum + estimateSeedTokens(message.text) + SEED_MESSAGE_OVERHEAD_TOKENS,
				0,
			)
			const allowedSeedTokens = seedTokenBudget({
				contextWindow: 8192,
				system,
				currentInput,
			})
			expect(seed.length).toBeGreaterThan(0)
			expect(seed[0]?.role).toBe("user")
			expect(seedChars).toBeLessThan(PI_SEED_MAX_CHARS)
			expect(seedTokens).toBeLessThanOrEqual(allowedSeedTokens)

			// Follow-up Turn 8 also completes cleanly.
			recovered = false
			yield* sendAndSettle(apiFetch, session.id, [`turn-8-${"wXyZaBcD".repeat(200)}`], 8)
			expect(recoveryBytesSeen).toHaveLength(1)
			expect(recoveryBytesSeen[0]).toBeLessThanOrEqual(8192 - 2048)
			expect(summaryTokensSeen.every((tokens) => tokens < 8192)).toBe(true)
		}).pipe(Effect.scoped, Effect.provide(layer))
	})

	it.live(
		"preserves the newest prompt alongside a long reply on small-context recovery and accounts for non-ASCII token density",
		() => {
			// Byte-level BPE upper bound: Japanese characters count as 3 UTF-8 bytes each,
			// and surrogate-pair emoji count as 4 without ever being split by trimTailToBudget.
			expect(estimateSeedTokens("日本語のテスト")).toBe(21)
			expect(trimTailToBudget("a🚀b", 2, 10)).toBe("b")
			expect(trimTailToBudget("a🚀b", 3, 10)).toBe("🚀b")
			expect(trimTailToBudget("日本語テスト", 100, 9)).toBe("テスト")

			const { layer, requests, forgetPiState } = makePiDurableTestLayer(async (model, context) => {
				const last = extractLastUserText(context)
				if (last === "Write a long essay") {
					// Larger than gpt-4's entire 8,192-token window on its own, plus truncated to bump generation.
					return makeAssistantReply(
						model,
						null,
						"e".repeat(MAX_MESSAGE_TEXT_LENGTH + 200),
						100,
						4000,
					)
				}
				if (last.startsWith("日本語")) {
					return makeAssistantReply(model, null, "日本語の応答です。".repeat(300), 100, 1000)
				}
				return makeAssistantReply(model, null, "Continued cleanly.", 100, 20)
			})

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const agentRes = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/agents",
					headers: AUTH_HEADERS,
					body: { name: "GPT-4 Agent", model: "gpt-4" },
				})
				const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
				const envRes = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/environments",
					headers: AUTH_HEADERS,
					body: { name: "Env" },
				})
				const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

				// 1. Truncated long reply on gpt-4 triggers a new generation; follow-up "continue"
				// MUST retain both the user prompt and a trimmed tail of the reply (never empty seed).
				const longReplyRes = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/sessions",
					headers: AUTH_HEADERS,
					body: { agent: agent.id, environment_id: env.id },
				})
				const longReplySess = (yield* Effect.promise(() => longReplyRes.json())) as { id: string }
				yield* sendAndSettle(apiFetch, longReplySess.id, ["Write a long essay"], 1)
				yield* sendAndSettle(apiFetch, longReplySess.id, ["continue"], 2)

				const longReplySeed = requests.at(-1)?.seed?.messages ?? []
				expect(longReplySeed).toHaveLength(2)
				expect(longReplySeed[0]).toEqual({ role: "user", text: "Write a long essay" })
				expect(longReplySeed[1]?.role).toBe("assistant")
				expect(longReplySeed[1]?.text.length).toBeGreaterThan(0)
				expect(
					longReplySeed.reduce(
						(sum, msg) => sum + estimateSeedTokens(msg.text) + SEED_MESSAGE_OVERHEAD_TOKENS,
						0,
					),
				).toBeLessThanOrEqual(
					seedTokenBudget({ contextWindow: 8192, system: null, currentInput: "continue" }),
				)

				// 2. Non-ASCII Japanese transcript on gpt-4 must stay strictly within the 8,192-token
				// byte-level BPE upper bound on recovery.
				const jpRes = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/sessions",
					headers: AUTH_HEADERS,
					body: { agent: agent.id, environment_id: env.id },
				})
				const jpSess = (yield* Effect.promise(() => jpRes.json())) as { id: string }
				const jpPrompt = "日本語の質問です。".repeat(200) // 1,800 Japanese chars = 5,400 UTF-8 bytes
				yield* sendAndSettle(apiFetch, jpSess.id, [jpPrompt], 1)
				yield* sendAndSettle(apiFetch, jpSess.id, [jpPrompt], 2)
				yield* Effect.promise(() => forgetPiState(conversationName(jpSess.id, 0)))

				const jpFollowUp = "続けてください。"
				yield* sendAndSettle(apiFetch, jpSess.id, [jpFollowUp], 3)

				const jpSeed = requests.at(-1)?.seed?.messages ?? []
				expect(jpSeed.length).toBeGreaterThanOrEqual(2)
				expect(jpSeed[0]?.role).toBe("user")
				const jpSeedUtf8Bytes = jpSeed.reduce(
					(sum, msg) => sum + new TextEncoder().encode(msg.text).length,
					0,
				)
				const jpFollowUpBytes = new TextEncoder().encode(jpFollowUp).length
				// Worst-case 1 token/UTF-8-byte across the rebuilt seed + follow-up stays below gpt-4's window.
				expect(jpSeedUtf8Bytes + jpFollowUpBytes).toBeLessThan(8192 - 2048)
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)

	it.live(
		"rebuilds earlier committed history on the next turn when a trimmed recovery turn fails or is interrupted",
		() => {
			const textOf = (message: TranscriptContext["messages"][number]) =>
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
			const contextsByPrompt = new Map<
				string,
				{
					readonly system: string | undefined
					readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>
				}
			>()
			const interruptStarted = Latch.makeUnsafe(false)

			const { layer, requests, forgetPiState } = makePiDurableTestLayer(
				async (model, context, signal) => {
					const last = extractLastUserText(context)
					const leading = context.messages[0]
					contextsByPrompt.set(last, {
						system: leading?.role === "system" ? JSON.stringify(leading) : undefined,
						messages: context.messages
							.filter((m) => m.role === "user" || m.role === "assistant")
							.map((m) => ({ role: m.role, text: textOf(m) })),
					})
					if (last.startsWith("fail-huge-") || last.startsWith("fail-partial-")) {
						return {
							...makeAssistantReply(model, null, "", 10, 0),
							stopReason: "error" as const,
							errorMessage: "400 context_length_exceeded",
						}
					}
					if (last.startsWith("interrupt-huge-")) {
						interruptStarted.openUnsafe()
						await new Promise<void>((resolve) => {
							if (signal?.aborted) {
								resolve()
								return
							}
							signal?.addEventListener("abort", () => resolve(), { once: true })
						})
						return { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" as const }
					}
					return makeAssistantReply(model, null, `Echo: ${last}`, 20, 8)
				},
			)

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const agentRes = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/agents",
					headers: AUTH_HEADERS,
					body: {
						name: "Small Window Recovery Agent",
						model: "gpt-4",
						system: "Preserve every committed fact.",
					},
				})
				const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
				const envRes = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/environments",
					headers: AUTH_HEADERS,
					body: { name: "Recovery Env" },
				})
				const env = (yield* Effect.promise(() => envRes.json())) as { id: string }
				const createSession = () =>
					Effect.gen(function* () {
						const res = yield* sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/sessions",
							headers: AUTH_HEADERS,
							body: { agent: agent.id, environment_id: env.id },
						})
						return (yield* Effect.promise(() => res.json())) as { id: string }
					})

				// 1. Failed huge-prompt recovery leaves empty trimmed root -> next short prompt rebuilds full history.
				const sessFailed = yield* createSession()
				yield* sendAndSettle(apiFetch, sessFailed.id, ["secret ALPHA-99"], 1)
				yield* sendAndSettle(apiFetch, sessFailed.id, ["fact BETA-77"], 2)
				yield* Effect.promise(() => forgetPiState(conversationName(sessFailed.id, 0)))

				// Huge prompt exhausts gpt-4's 8,192-token seed budget -> empty trimmed seed, then fails.
				yield* sendAndSettle(apiFetch, sessFailed.id, [`fail-huge-${"x".repeat(8000)}`], 3)
				expect(requests.at(-1)?.seed).toMatchObject({ messages: [], trimmed: true })

				// Short follow-up MUST rebuild Turn 1 & Turn 2 history + keep system prompt.
				yield* sendAndSettle(apiFetch, sessFailed.id, ["recall-after-failed-huge"], 4)
				expect(requests.at(-1)?.seed).toMatchObject({
					trimmed: false,
					messages: [
						{ role: "user", text: "secret ALPHA-99" },
						{ role: "assistant", text: "Echo: secret ALPHA-99" },
						{ role: "user", text: "fact BETA-77" },
						{ role: "assistant", text: "Echo: fact BETA-77" },
					],
				})
				const ctxAfterFailed = contextsByPrompt.get("recall-after-failed-huge")
				expect(ctxAfterFailed?.system).toContain("Preserve every committed fact.")
				expect(ctxAfterFailed?.messages).toEqual([
					{ role: "user", text: "secret ALPHA-99" },
					{ role: "assistant", text: "Echo: secret ALPHA-99" },
					{ role: "user", text: "fact BETA-77" },
					{ role: "assistant", text: "Echo: fact BETA-77" },
					{ role: "user", text: "recall-after-failed-huge" },
				])

				// Subsequent Turn 5 after the rebuilt turn succeeded needs no further seeding.
				yield* sendAndSettle(apiFetch, sessFailed.id, ["turn-5-no-reseed"], 5)
				expect(requests.at(-1)?.seed).toBeUndefined()

				// 2. Interrupted huge-prompt recovery also rebuilds full history on the next short prompt.
				const sessInterrupted = yield* createSession()
				yield* sendAndSettle(apiFetch, sessInterrupted.id, ["keep GAMMA-11"], 1)
				yield* Effect.promise(() => forgetPiState(conversationName(sessInterrupted.id, 0)))

				yield* sendRequest(apiFetch, {
					method: "POST",
					path: `/v1/sessions/${sessInterrupted.id}/events`,
					headers: AUTH_HEADERS,
					body: {
						events: [
							{
								type: "user.message",
								content: [{ type: "text", text: `interrupt-huge-${"y".repeat(8000)}` }],
							},
						],
					},
				})
				yield* interruptStarted.await
				yield* sendRequest(apiFetch, {
					method: "POST",
					path: `/v1/sessions/${sessInterrupted.id}/events`,
					headers: AUTH_HEADERS,
					body: { events: [{ type: "user.interrupt" }] },
				})
				yield* waitForSession(
					apiFetch,
					sessInterrupted.id,
					(current) => current.status === "idle" && current.turn === 2,
					"interrupted recovery turn did not settle",
				)

				yield* sendAndSettle(apiFetch, sessInterrupted.id, ["recall-after-interrupt"], 3)
				expect(contextsByPrompt.get("recall-after-interrupt")?.messages).toEqual([
					{ role: "user", text: "keep GAMMA-11" },
					{ role: "assistant", text: "Echo: keep GAMMA-11" },
					{ role: "user", text: "recall-after-interrupt" },
				])

				// 3. Partially trimmed recovery seed that fails -> next short prompt replaces the trimmed
				//    fragment via ResetEntry with the full untrimmed Turn 1 + Turn 2 history.
				const sessPartial = yield* createSession()
				const firstFact = `older-fact-${"A".repeat(400)}`
				const secondFact = `newer-fact-${"B".repeat(400)}`
				yield* sendAndSettle(apiFetch, sessPartial.id, [firstFact], 1)
				yield* sendAndSettle(apiFetch, sessPartial.id, [secondFact], 2)
				yield* Effect.promise(() => forgetPiState(conversationName(sessPartial.id, 0)))

				// Leave ~450 bytes of seed budget: fits a trimmed tail of Turn 2, drops Turn 1, then fails.
				const partialPrompt = `fail-partial-${"z".repeat(5600)}`
				yield* sendAndSettle(apiFetch, sessPartial.id, [partialPrompt], 3)
				const partialSeed = requests.at(-1)?.seed
				expect(partialSeed?.trimmed).toBe(true)
				expect(partialSeed?.messages).toHaveLength(2)
				expect(partialSeed?.messages[0]?.text.length).toBeLessThan(secondFact.length)

				// Short Turn 4 gets FULL untrimmed Turn 1 + Turn 2 with no leftover trimmed entries.
				yield* sendAndSettle(apiFetch, sessPartial.id, ["recall-after-partial"], 4)
				expect(contextsByPrompt.get("recall-after-partial")?.messages).toEqual([
					{ role: "user", text: firstFact },
					{ role: "assistant", text: `Echo: ${firstFact}` },
					{ role: "user", text: secondFact },
					{ role: "assistant", text: `Echo: ${secondFact}` },
					{ role: "user", text: "recall-after-partial" },
				])
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)
})
