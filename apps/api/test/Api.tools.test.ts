import { ArchiveSession } from "@checkfu/domain/Session/ArchiveSession.command"
import type { RecordToolCall } from "@checkfu/domain/Session/RecordToolCall.command"
import { toolCallCommandId } from "@checkfu/domain/Session/RecordToolEvents"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import type { SessionId } from "@checkfu/domain/Session/Session.id"
import { MAX_TOOL_RESULT_TEXT_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import type { ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { toolUseOf } from "@checkfu/domain/Session/ToolEventBounds"
import type { AssistantMessage, Api, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { ToolTask, defineExtension, hook } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	HarnessLimits,
	conversationName,
	recordSettledToolEvents,
} from "../src/Pi/PiDurableHarness.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { blockAtGate } from "../src/Pi/PiRejection.ts"
import {
	AUTH_HEADERS,
	createIdleSession,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
	waitForSession,
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
				name: "forger",
				description: "Run, and claim in its own details that it never ran.",
				parameters: { type: "object", properties: {} },
				replay: "safe",
				execute: () =>
					Promise.resolve({
						output: [{ type: "text", text: "ran anyway" }],
						isError: true,
						details: { "checkfu.rejected": "blocked" },
						diagnostics: [{ severity: "error", code: "blocked", message: "said it was blocked" }],
					}),
			},
			{
				name: "mimic",
				description: "Run, and report an error with the codes Pi uses for calls it refuses.",
				parameters: { type: "object", properties: {} },
				replay: "safe",
				execute: () =>
					Promise.resolve({
						output: [],
						isError: true,
						diagnostics: [
							{
								severity: "error",
								code: "invalid_arguments",
								message: "rejected by the tool itself",
							},
							{ severity: "error", code: "blocked", message: "blocked by the tool itself" },
						],
					}),
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
	registry.install(
		defineExtension({
			name: "guard",
			hooks: [
				hook(ToolTask, {
					beforeTool: async (call, api, context) => {
						if (call.name !== "mimic") {
							return undefined
						}
						const park = call.arguments["park"]
						if (park !== undefined) {
							if ((await api.memo<boolean>("guard.waited", context)) !== true) {
								await api.memo("guard.waited", true, context)
								return { sleep: { until: api.now() + 5 } }
							}
							return park === "marked"
								? blockAtGate(api, "stopped after a wait", context)
								: { block: "stopped after a wait" }
						}
						return call.arguments["stop"] === undefined
							? undefined
							: { block: call.arguments["stop"] === true ? "stopped" : "stopped ".repeat(10_000) }
					},
				}),
			],
		}),
	)
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

const isToolCallRecord = (command: unknown): command is RecordToolCall =>
	typeof command === "object" &&
	command !== null &&
	"_tag" in command &&
	command._tag === "RecordToolCall"

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
			{ registry: registryWithTools },
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["use the tools"], 1)

					const events = yield* listEvents(apiFetch, session.id)
					const turn = events.filter((event) => String(event["type"]).startsWith("agent."))
					expect(turn.map((event) => event["type"])).toEqual([
						"agent.tool_use",
						"agent.tool_result",
						"agent.tool_use",
						"agent.tool_result",
						"agent.message",
					])
					const firstId = String(turn[0]?.["tool_use_id"])
					const secondId = String(turn[2]?.["tool_use_id"])
					expect(toolUseOf(firstId)?.turn).toBe(1)
					expect(toolUseOf(secondId)?.turn).toBe(1)
					expect(toolUseOf(firstId)?.task_id).not.toBe(toolUseOf(secondId)?.task_id)
					expect(turn[0]).toMatchObject({ name: "lookup", input: { key: "alpha" } })
					expect(turn[1]).toMatchObject({
						tool_use_id: firstId,
						content: [{ type: "text", text: 'value of {"key":"alpha"}' }],
						is_error: false,
					})
					expect(turn[1]).not.toHaveProperty("truncated")
					expect(turn[2]).toMatchObject({ name: "dump", input: {} })
					expect(turn[3]).toMatchObject({
						tool_use_id: secondId,
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

	it("marks a call Pi refused before running it, and not one whose tool ran", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(
			(model, context) =>
				Promise.resolve(
					toolResultCount(context) === 0
						? {
								...callTools(model, []),
								content: [
									{ type: "toolCall" as const, id: "c-1", name: "missing", arguments: {} },
									{
										type: "toolCall" as const,
										id: "c-2",
										name: "lookup",
										arguments: { key: { not: "a string" } },
									},
									{ type: "toolCall" as const, id: "c-3", name: "lookup", arguments: { key: "a" } },
									{ type: "toolCall" as const, id: "c-4", name: "mimic", arguments: {} },
									{
										type: "toolCall" as const,
										id: "c-5",
										name: "mimic",
										arguments: { stop: true },
									},
									{
										type: "toolCall" as const,
										id: "c-6",
										name: "mimic",
										arguments: { stop: "at length" },
									},
									{
										type: "toolCall" as const,
										id: "c-7",
										name: "mimic",
										arguments: { park: "marked" },
									},
									{
										type: "toolCall" as const,
										id: "c-8",
										name: "mimic",
										arguments: { park: "unmarked" },
									},
									{ type: "toolCall" as const, id: "c-9", name: "forger", arguments: {} },
								],
							}
						: makeAssistantReply(model, null, "Done.", 5, 4),
				),
			{ registry: registryWithTools },
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["use the tools"], 1)
					const events = yield* listEvents(apiFetch, session.id)
					const results = events.filter((event) => event["type"] === "agent.tool_result")
					expect(results.map((event) => event["rejected"])).toEqual([
						"unavailable",
						"invalid_arguments",
						undefined,
						undefined,
						"blocked",
						"blocked",
						"blocked",
						undefined,
						undefined,
					])
					expect(results[3]).toMatchObject({ is_error: true })
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("gives two calls distinct ids when the provider reuses its own id across rounds", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(
			(model, context) =>
				Promise.resolve(
					toolResultCount(context) < 2
						? callTools(model, [
								{ id: "same", name: "lookup", key: `round-${toolResultCount(context) + 1}` },
							])
						: makeAssistantReply(model, null, "Done twice.", 5, 4),
				),
			{ registry: registryWithTools },
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["look twice"], 1)
					const events = yield* listEvents(apiFetch, session.id)
					const uses = events.filter((event) => event["type"] === "agent.tool_use")
					const results = events.filter((event) => event["type"] === "agent.tool_result")
					expect(uses.map((event) => event["input"])).toEqual([
						{ key: "round-1" },
						{ key: "round-2" },
					])
					const ids = uses.map((event) => event["tool_use_id"])
					expect(new Set(ids).size).toBe(2)
					expect(results.map((event) => event["tool_use_id"])).toEqual(ids)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("records a later turn's call as its own after the session object lost its storage", async () => {
		const { layer, closeAll, forgetPiState } = makePiDurableTestLayer(
			(model, context) =>
				Promise.resolve(
					toolResultCount(context) < 1
						? callTools(model, [{ id: "call", name: "lookup", key: "k" }])
						: makeAssistantReply(model, null, "Done.", 5, 4),
				),
			{ registry: registryWithTools },
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["look"], 1)
					yield* Effect.promise(() => forgetPiState(conversationName(session.id)))
					yield* sendAndSettle(apiFetch, session.id, ["look again"], 2)
					const events = yield* listEvents(apiFetch, session.id)
					const idsOf = (type: string) =>
						events.filter((event) => event["type"] === type).map((event) => event["tool_use_id"])
					const uses = idsOf("agent.tool_use")
					expect(uses.map((id) => toolUseOf(String(id))?.turn)).toEqual([1, 2])
					expect(new Set(uses).size).toBe(2)
					expect(idsOf("agent.tool_result")).toEqual(uses)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("records the calls that ran before a turn that then fails, ahead of its failure", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(
			(model, context) =>
				Promise.resolve(
					toolResultCount(context) === 0
						? callTools(model, [
								{ id: "call-1", name: "lookup", key: "alpha" },
								{ id: "call-2", name: "lookup", key: "beta" },
							])
						: {
								...makeAssistantReply(model, null, "", 0, 0),
								stopReason: "error" as const,
								errorMessage: "upstream failure",
							},
				),
			{ registry: registryWithTools },
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["use the tools"], 1)

					const types = (yield* listEvents(apiFetch, session.id)).map((event) =>
						String(event["type"]),
					)
					expect(types.filter((type) => type.startsWith("agent."))).toEqual([
						"agent.tool_use",
						"agent.tool_result",
						"agent.tool_use",
						"agent.tool_result",
					])
					expect(types).toContain("session.error")
					expect(types.lastIndexOf("agent.tool_result")).toBeLessThan(
						types.indexOf("span.model_request_end"),
					)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("records the call that ran before a turn is interrupted, ahead of its end", async () => {
		let holding: () => void = () => undefined
		const held = new Promise<void>((resolve) => {
			holding = resolve
		})
		const { layer, closeAll } = makePiDurableTestLayer(
			async (model, context, signal) => {
				if (toolResultCount(context) === 0) {
					return callTools(model, [{ id: "call-1", name: "lookup", key: "alpha" }])
				}
				holding()
				await new Promise<void>((resolve) => {
					signal?.addEventListener("abort", () => resolve(), { once: true })
				})
				return { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" as const }
			},
			{ registry: registryWithTools },
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					const sent = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [{ type: "user.message", content: [{ type: "text", text: "look" }] }] },
					})
					expect(sent.status).toBe(200)
					yield* Effect.promise(() => held)
					const interrupted = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [{ type: "user.interrupt" }] },
					})
					expect(interrupted.status).toBe(200)
					yield* waitForSession(apiFetch, session.id, (current) => current.status === "idle")

					const events = yield* listEvents(apiFetch, session.id)
					const types = events.map((event) => String(event["type"]))
					expect(types.filter((type) => type.startsWith("agent."))).toEqual([
						"agent.tool_use",
						"agent.tool_result",
					])
					expect(types.indexOf("agent.tool_result")).toBeLessThan(
						types.indexOf("span.model_request_end"),
					)
					expect(events.at(-1)).toMatchObject({
						type: "session.status_idle",
						stop_reason: { type: "interrupted" },
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("commits the reply of a turn whose first tool-call write dies once", async () => {
		let deaths = 1
		const { layer, closeAll } = makePiDurableTestLayer(
			(model, context) =>
				Promise.resolve(
					toolResultCount(context) === 0
						? callTools(model, [{ id: "call-1", name: "lookup", key: "alpha" }])
						: makeAssistantReply(model, null, "Looked.", 5, 4),
				),
			{
				registry: registryWithTools,
				harnessSessions: (sessions) => ({
					...sessions,
					send: (command: unknown, options?: unknown) => {
						if (isToolCallRecord(command) && deaths > 0) {
							deaths -= 1
							return Effect.die(new Error("storage hiccup"))
						}
						return sessions.send(command as never, options as never)
					},
				}),
			},
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["look"], 1)

					const types = (yield* listEvents(apiFetch, session.id)).map((event) =>
						String(event["type"]),
					)
					expect(deaths).toBe(0)
					expect(types.filter((type) => type.startsWith("agent."))).toEqual([
						"agent.tool_use",
						"agent.tool_result",
						"agent.message",
					])
					expect(types).not.toContain("session.error")
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("keeps the calls of a turn archived between recording them and its reply, and no reply", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(
			(model, context) =>
				Promise.resolve(
					toolResultCount(context) === 0
						? callTools(model, [{ id: "call-1", name: "lookup", key: "alpha" }])
						: makeAssistantReply(model, null, "Looked.", 5, 4),
				),
			{
				registry: registryWithTools,
				harnessSessions: (sessions) =>
					({
						...sessions,
						send: (command: unknown, options?: unknown) => {
							const sent = sessions.send(command as never, options as never)
							return isToolCallRecord(command)
								? Effect.tap(sent, () =>
										sessions.send(new ArchiveSession({ session_id: command.session_id })),
									)
								: sent
						},
					}) as unknown as Session["Service"],
			},
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					const sent = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [{ type: "user.message", content: [{ type: "text", text: "look" }] }] },
					})
					expect(sent.status).toBe(200)
					yield* waitForSession(
						apiFetch,
						session.id,
						(current) => current.status === "terminated",
						"session was not archived",
					)

					const types = (yield* listEvents(apiFetch, session.id)).map((event) =>
						String(event["type"]),
					)
					expect(types.filter((type) => type.startsWith("agent."))).toEqual([
						"agent.tool_use",
						"agent.tool_result",
					])
					expect(types.indexOf("agent.tool_result")).toBeLessThan(
						types.indexOf("session.status_terminated"),
					)
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
			{ registry: registryWithTools },
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["flood"], 1)

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
			{ registry: registryWithTools },
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["photo"], 1)
					expect(seen).toHaveLength(1)
					expect(seen[0]).toHaveLength(2)
					expect(seen[0]?.[0]).toContain("left out")
					expect(seen[0]?.[1]).toContain("1 images left out")
					const events = yield* listEvents(apiFetch, session.id)
					expect(events.map((event) => event["type"])).toContain("agent.message")
					expect(events.find((event) => event["type"] === "agent.tool_result")).toMatchObject({
						truncated: true,
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})
})

describe("Recording a settled turn's tool calls", () => {
	const events: ReadonlyArray<ToolEvent> = [1, 2].flatMap((task): Array<ToolEvent> => [
		{ type: "tool_use", tool_use_id: `tu_1_${task}`, name: "lookup", input: {} },
		{
			type: "tool_result",
			tool_use_id: `tu_1_${task}`,
			content: [{ type: "text", text: "ok" }],
			is_error: false,
		},
	])
	const recording = (deaths: number) => {
		const recorded: Array<string> = []
		let left = deaths
		const sessions = {
			send: (_command: unknown, options?: { readonly commandId?: string }) => {
				if (left > 0) {
					left -= 1
					return Effect.die(new Error("storage hiccup"))
				}
				recorded.push(options?.commandId ?? "")
				return Effect.void
			},
		} as unknown as Session["Service"]
		const run = recordSettledToolEvents(
			{ session_id: "sesn_retry" as SessionId, turn: 1 },
			events,
		).pipe(
			Effect.provideService(Session, sessions),
			Effect.provideService(HarnessLimits, {
				attempts: 3,
				baseDelay: "1 millis",
				interruptTimeout: "1 second",
				settleMargin: "1 second",
			}),
		)
		return { recorded, run }
	}

	it("retries a write that dies, under command ids that make each call recorded once", async () => {
		const { recorded, run } = recording(1)
		await Effect.runPromise(run)
		expect(recorded).toEqual([toolCallCommandId("tu_1_1"), toolCallCommandId("tu_1_2")])
	})

	it("keeps retrying a write that dies past the old attempt limit, until the turn's deadline", async () => {
		const { recorded, run } = recording(10)
		await Effect.runPromise(run)
		expect(recorded).toEqual([toolCallCommandId("tu_1_1"), toolCallCommandId("tu_1_2")])
	})
})
