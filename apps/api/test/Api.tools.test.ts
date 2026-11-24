import { MAX_TOOL_RESULT_TEXT_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import type { AssistantMessage, Api, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { makeApiHandler } from "../src/Http/Router.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import {
	AUTH_HEADERS,
	createIdleSession,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"

const LONG_OUTPUT = "x".repeat(MAX_TOOL_RESULT_TEXT_LENGTH + 100)

const registryWithTools = () => {
	const registry = createCheckfuRegistry()
	registry.install({
		name: "probe",
		tools: [
			{
				name: "lookup",
				description: "Look a key up.",
				parameters: { type: "object", properties: { key: { type: "string" } } },
				replay: "safe",
				execute: (args) =>
					Promise.resolve({ output: [{ type: "text", text: `value of ${JSON.stringify(args)}` }] }),
			},
			{
				name: "photo",
				description: "Return a 2 MiB picture.",
				parameters: { type: "object", properties: {} },
				replay: "safe",
				execute: () =>
					Promise.resolve({
						output: [
							{
								type: "image",
								data: "A".repeat(Math.ceil((2 * 1024 * 1024 * 4) / 3)),
								mimeType: "image/png",
							},
						],
					}),
			},
			{
				name: "flood",
				description: "Return several megabytes of text.",
				parameters: { type: "object", properties: {} },
				replay: "safe",
				execute: () =>
					Promise.resolve({ output: [{ type: "text", text: "line of output\n".repeat(400_000) }] }),
			},
			{
				name: "dump",
				description: "Return a long text.",
				parameters: { type: "object", properties: {} },
				replay: "safe",
				execute: () => Promise.resolve({ output: [{ type: "text", text: LONG_OUTPUT }] }),
			},
		],
	})
	return registry
}

const callTools = (
	model: Model<Api>,
	calls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly key?: string }>,
): AssistantMessage => ({
	...makeAssistantReply(model, null, "", 3, 2),
	content: calls.map((call) => ({
		type: "toolCall" as const,
		id: call.id,
		name: call.name,
		arguments: call.key === undefined ? {} : { key: call.key },
	})),
	stopReason: "toolUse",
})

const toolResultCount = (context: TranscriptContext): number =>
	context.messages.filter((message) => message.role === "toolResult").length

const listEvents = (
	apiFetch: Parameters<typeof sendRequest>[0],
	sessionId: string,
): Effect.Effect<ReadonlyArray<Schema.JsonObject>> =>
	Effect.gen(function* () {
		const res = yield* sendRequest(apiFetch, {
			method: "GET",
			path: `/v1/sessions/${sessionId}/events?limit=100`,
			headers: AUTH_HEADERS,
		})
		expect(res.status).toBe(200)
		const body = (yield* Effect.promise(() => res.json())) as {
			readonly data: ReadonlyArray<Schema.JsonObject>
		}
		return body.data
	})

describe("Tool calls on the session log", () => {
	it("publishes a committed turn's tool calls and results in order, before its reply", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(
			(model, context) =>
				Promise.resolve(
					toolResultCount(context) === 0
						? callTools(model, [
								{ id: "call-1", name: "lookup", key: "alpha" },
								{ id: "call-2", name: "dump" },
							])
						: makeAssistantReply(model, null, "Both done.", 5, 4),
				),
			undefined,
			undefined,
			registryWithTools,
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["use the tools"], 1)

					const events = yield* listEvents(apiFetch, session.id)
					const turn = events.filter((event) => String(event["type"]).startsWith("agent."))
					// Each call's use and result are published together, in the order the calls were made.
					expect(turn.map((event) => event["type"])).toEqual([
						"agent.tool_use",
						"agent.tool_result",
						"agent.tool_use",
						"agent.tool_result",
						"agent.message",
					])
					expect(turn[0]).toMatchObject({
						tool_use_id: "call-1",
						name: "lookup",
						input: { key: "alpha" },
					})
					expect(turn[1]).toMatchObject({
						tool_use_id: "call-1",
						content: [{ type: "text", text: 'value of {"key":"alpha"}' }],
						is_error: false,
					})
					expect(turn[1]).not.toHaveProperty("truncated")
					expect(turn[2]).toMatchObject({ tool_use_id: "call-2", name: "dump", input: {} })
					expect(turn[3]).toMatchObject({
						tool_use_id: "call-2",
						content: [{ type: "text", text: LONG_OUTPUT.slice(0, MAX_TOOL_RESULT_TEXT_LENGTH) }],
						is_error: false,
						truncated: true,
					})
					expect(turn[4]).toMatchObject({ content: [{ type: "text", text: "Both done." }] })
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("records no tool calls for a turn that fails after using a tool", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(
			(model, context) =>
				Promise.resolve(
					toolResultCount(context) === 0
						? callTools(model, [{ id: "call-1", name: "lookup", key: "alpha" }])
						: {
								...makeAssistantReply(model, null, "", 0, 0),
								stopReason: "error" as const,
								errorMessage: "upstream failure",
							},
				),
			undefined,
			undefined,
			registryWithTools,
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["use the tool"], 1)

					const types = (yield* listEvents(apiFetch, session.id)).map((event) => event["type"])
					expect(types).toContain("session.error")
					expect(types.filter((type) => String(type).startsWith("agent."))).toEqual([])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("keeps a turn whose tool returns megabytes, with Pi's bound on what it stores", async () => {
		const seen: Array<number> = []
		const { layer, closeAll } = makePiDurableTestLayer(
			(model, context) => {
				const results = context.messages.filter((message) => message.role === "toolResult")
				if (results.length === 0) {
					return Promise.resolve(callTools(model, [{ id: "call-1", name: "flood" }]))
				}
				for (const message of results) {
					seen.push(
						message.content.map((part) => (part.type === "text" ? part.text : "")).join("").length,
					)
				}
				return Promise.resolve(makeAssistantReply(model, null, "Read it.", 5, 4))
			},
			undefined,
			undefined,
			registryWithTools,
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["flood"], 1)

					// The tool returned about 6 MB; what Pi stored, and the model read back, is its 50 KB bound.
					expect(seen).toHaveLength(1)
					expect(seen[0]).toBeLessThan(60_000)
					const turn = (yield* listEvents(apiFetch, session.id)).filter((event) =>
						String(event["type"]).startsWith("agent."),
					)
					expect(turn.map((event) => event["type"])).toEqual([
						"agent.tool_use",
						"agent.tool_result",
						"agent.message",
					])
					expect(turn[1]).toMatchObject({ truncated: true })
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("keeps a turn whose tool returns a 2 MiB image, with a note in the image's place", async () => {
		const seen: Array<ReadonlyArray<string>> = []
		const { layer, closeAll } = makePiDurableTestLayer(
			(model, context) => {
				const results = context.messages.filter((message) => message.role === "toolResult")
				if (results.length === 0) {
					return Promise.resolve(callTools(model, [{ id: "call-1", name: "photo" }]))
				}
				for (const message of results) {
					seen.push(message.content.map((part) => (part.type === "text" ? part.text : part.type)))
				}
				return Promise.resolve(makeAssistantReply(model, null, "Saw it.", 5, 4))
			},
			undefined,
			undefined,
			registryWithTools,
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["photo"], 1)
					expect(seen).toHaveLength(1)
					expect(seen[0]).toHaveLength(1)
					expect(seen[0]?.[0]).toContain("left out")
					const types = (yield* listEvents(apiFetch, session.id)).map((event) => event["type"])
					expect(types).toContain("agent.message")
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})
})
