import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { MAX_MESSAGE_TEXT_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import { makeApiHandler } from "../src/Http/Router.ts"
import { HarnessTurnTimeout, conversationName } from "../src/Pi/PiDurableHarness.ts"
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

const textOf = (message: TranscriptContext["messages"][number]) =>
	typeof message.content === "string"
		? message.content
		: message.content.map((part) => (part.type === "text" ? part.text : "")).join("")

const conversationOf = (context: TranscriptContext) =>
	context.messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map(textOf)

describe("one Pi conversation per session", () => {
	it.live("keeps every turn of a session in one conversation that Pi remembers", () => {
		const contexts: Array<ReadonlyArray<string>> = []
		const { layer, conversations } = makePiDurableTestLayer(async (model, context) => {
			contexts.push(conversationOf(context))
			return makeAssistantReply(model, null, `Echo: ${extractLastUserText(context)}`, 1, 1)
		})

		return Effect.gen(function* () {
			const { fetch: apiFetch } = yield* makeApiHandler
			const session = yield* createIdleSession(apiFetch)
			yield* sendAndSettle(apiFetch, session.id, ["one"], 1)
			yield* sendAndSettle(apiFetch, session.id, ["two"], 2)
			expect(conversations).toEqual([session.id, session.id])
			expect(contexts.at(-1)).toEqual(["one", "Echo: one", "two"])
		}).pipe(Effect.scoped, Effect.provide(layer))
	})

	it.live("starts an empty conversation when the session object has lost its storage", () => {
		const contexts: Array<ReadonlyArray<string>> = []
		const { layer, forgetPiState } = makePiDurableTestLayer(async (model, context) => {
			contexts.push(conversationOf(context))
			return makeAssistantReply(model, null, `Echo: ${extractLastUserText(context)}`, 1, 1)
		})

		return Effect.gen(function* () {
			const { fetch: apiFetch } = yield* makeApiHandler
			const session = yield* createIdleSession(apiFetch)
			yield* sendAndSettle(apiFetch, session.id, ["one"], 1)
			yield* Effect.promise(() => forgetPiState(conversationName(session.id)))
			yield* sendAndSettle(apiFetch, session.id, ["two"], 2)
			expect(contexts.at(-1)).toEqual(["two"])
		}).pipe(Effect.scoped, Effect.provide(layer))
	})

	it.live("keeps the model's whole reply in its context when the published reply is cut", () => {
		const prefix = "p".repeat(MAX_MESSAGE_TEXT_LENGTH)
		const history: Array<string> = []
		const { layer } = makePiDurableTestLayer(async (model, context) => {
			for (const message of context.messages) {
				if (message.role === "assistant") {
					history.push(textOf(message))
				}
			}
			const text = extractLastUserText(context) === "First" ? prefix + "unpublished suffix" : "Done"
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
			expect(history).toEqual([prefix + "unpublished suffix"])
		}).pipe(Effect.scoped, Effect.provide(layer))
	})

	it.live(
		"fails a turn whose harness is unreachable, then continues in the same conversation once it is back",
		() => {
			const contexts: Array<ReadonlyArray<string>> = []
			const { layer, unreachable, conversations } = makePiDurableTestLayer(
				async (model, context) => {
					contexts.push(conversationOf(context))
					return makeAssistantReply(model, null, `Echo: ${extractLastUserText(context)}`, 1, 1)
				},
			)

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const session = yield* createIdleSession(apiFetch)
				yield* sendAndSettle(apiFetch, session.id, ["one"], 1)

				unreachable.add(conversationName(session.id))
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

				unreachable.delete(conversationName(session.id))
				yield* sendAndSettle(apiFetch, session.id, ["three"], 3)
				expect(conversations).toEqual([session.id, session.id])
				expect(contexts.at(-1)).toEqual(["one", "Echo: one", "three"])
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)

	it.live(
		"stops a turn its interrupt never reached before running the next one in the same conversation",
		() => {
			const gate = Latch.makeUnsafe(false)
			const started = Latch.makeUnsafe(false)
			const { layer, unreachable, conversations, resets } = makePiDurableTestLayer(
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
				unreachable.add(conversationName(session.id))
				expect((yield* post({ events: [{ type: "user.interrupt" }] })).status).toBe(200)
				yield* waitForSession(
					apiFetch,
					session.id,
					(current) => current.status === "idle",
					"interrupted session did not settle idle",
				)

				// The model call ignores its abort signal, so the turn is still running in Pi.
				// Only resetting the object can clear it.
				unreachable.delete(conversationName(session.id))
				yield* sendAndSettle(apiFetch, session.id, ["next"], 2)
				expect(resets.length).toBeGreaterThan(0)
				expect(new Set(resets)).toEqual(new Set([conversationName(session.id)]))
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
				expect(conversations.at(-1)).toBe(conversationName(session.id))
			}).pipe(Effect.ensuring(gate.open), Effect.scoped, Effect.provide(layer))
		},
	)

	it.live(
		"abandons a turn the harness never settles, then continues in the same conversation",
		() => {
			const gate = Latch.makeUnsafe(false)
			const started = Latch.makeUnsafe(false)
			const { layer, conversations, resets } = makePiDurableTestLayer(async (model, context) => {
				const text = extractLastUserText(context)
				if (text === "stuck") {
					started.openUnsafe()
					await Effect.runPromise(gate.await)
				}
				return makeAssistantReply(model, null, `Echo: ${text}`, 1, 1)
			})

			return Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const session = yield* createIdleSession(apiFetch)
				const sent = yield* sendRequest(apiFetch, {
					method: "POST",
					path: `/v1/sessions/${session.id}/events`,
					headers: AUTH_HEADERS,
					body: {
						events: [{ type: "user.message", content: [{ type: "text", text: "stuck" }] }],
					},
				})
				expect(sent.status).toBe(200)
				yield* started.await
				yield* waitForSession(
					apiFetch,
					session.id,
					(current) => current.status === "idle" && current.turn === 1,
					"stuck turn was not abandoned",
				)

				const listEvents = () =>
					Effect.gen(function* () {
						const listed = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/sessions/${session.id}/events`,
							headers: AUTH_HEADERS,
						})
						expect(listed.status).toBe(200)
						return (
							(yield* Effect.promise(() => listed.json())) as {
								data: ReadonlyArray<{
									type: string
									content?: ReadonlyArray<{ type: string; text?: string }>
									error?: { type: string; retry_status: { type: string } }
									stop_reason?: { type: string }
								}>
							}
						).data
					})

				const turn1Events = yield* listEvents()
				expect(turn1Events.map((event) => event.type)).toEqual([
					"user.message",
					"session.status_running",
					"span.model_request_start",
					"span.model_request_end",
					"session.error",
					"session.status_idle",
				])
				expect(turn1Events[4]?.error).toMatchObject({
					type: "harness_unavailable",
					retry_status: { type: "exhausted" },
				})
				expect(turn1Events[5]?.stop_reason).toEqual({ type: "retries_exhausted" })

				yield* sendAndSettle(apiFetch, session.id, ["next"], 2)
				expect(conversations.at(-1)).toBe(conversationName(session.id))
				expect(resets.length).toBeGreaterThan(0)
				expect(new Set(resets)).toEqual(new Set([conversationName(session.id)]))

				const turn2Events = (yield* listEvents()).slice(turn1Events.length)
				expect(turn2Events.map((event) => event.type)).toEqual([
					"user.message",
					"session.status_running",
					"span.model_request_start",
					"agent.message",
					"span.model_request_end",
					"session.status_idle",
				])
				expect(turn2Events[3]?.content).toEqual([{ type: "text", text: "Echo: next" }])
				expect(turn2Events[5]?.stop_reason).toEqual({ type: "end_turn" })
			}).pipe(
				Effect.ensuring(gate.open),
				Effect.scoped,
				Effect.provide(
					// Long enough for the next turn to reset the object and try again.
					Layer.succeed(HarnessTurnTimeout, "250 millis").pipe(Layer.provideMerge(layer)),
				),
			)
		},
	)
})
