import * as Domain from "@alchemy.run/domain"
import { Agent } from "@checkfu/domain/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/domain/Agent/AgentVersion.id"
import { AgentVersionByNumberView } from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { AgentView } from "@checkfu/domain/Agent/AgentView.view"
import { ArchiveAgent } from "@checkfu/domain/Agent/ArchiveAgent.command"
import { CreateAgent } from "@checkfu/domain/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/domain/Agent/CreateAgent.decision"
import { UpdateAgent } from "@checkfu/domain/Agent/UpdateAgent.command"
import { UpdateAgentDecision } from "@checkfu/domain/Agent/UpdateAgent.decision"
import { DeleteEnvironment } from "@checkfu/domain/Environment/DeleteEnvironment.command"
import { Environment } from "@checkfu/domain/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { SessionErrorEvent } from "@checkfu/domain/Session/AbandonTurn.command"
import {
	SessionArchived,
	SessionStatusTerminated,
} from "@checkfu/domain/Session/ArchiveSession.command"
import {
	AgentMessage,
	AgentThinking,
	SessionStatusIdle,
	SpanModelRequestEnd,
} from "@checkfu/domain/Session/CommitModelReply.command"
import { SpanModelRequestStart } from "@checkfu/domain/Session/RecordModelRequestStart.command"
import {
	AgentMcpToolResult,
	AgentMcpToolUse,
	AgentToolResult,
	AgentToolUse,
	AgentCustomToolUse,
} from "@checkfu/domain/Session/RecordToolCall.command"
import { UserInterrupt } from "@checkfu/domain/Session/SendUserInterrupt.command"
import { UserToolConfirmation } from "@checkfu/domain/Session/ConfirmTool.command"
import { UserCustomToolResult } from "@checkfu/domain/Session/ReturnCustomToolResult.command"
import { encodeToolUseIds } from "@checkfu/domain/Session/SessionTypes"
import { SessionStatusRunning, UserMessage } from "@checkfu/domain/Session/SendUserMessage.command"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { AdmitSession } from "@checkfu/domain/Session/AdmitSession.command"
import { AdmitSessionDecision } from "@checkfu/domain/Session/AdmitSession.decision"
import { SessionEvent } from "../src/Http/Api.ts"
import {
	AgentVersionWaitTimeout,
	SSE_CATCHUP_PAGE_SIZE,
	SessionReadWaitTimeout,
	SseKeepaliveInterval,
	SseMaxConnectionDuration,
	makeApiHandler,
} from "../src/Http/Router.ts"
import { serializeSessionEvent } from "../src/Http/SessionsHandlers.ts"
import type { DomainSessionEvent } from "../src/Http/SessionsHandlers.ts"
import {
	AUTH_HEADERS,
	createIdleSession,
	extractLastUserText,
	makeApiTestClient,
	makeAssistantReply,
	makePiDurableTestLayer,
	readSseUntil,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"

const testNotice = (message: string) =>
	new SessionErrorEvent({
		error: { type: "test_notice", message, retry_status: { type: "retrying" } },
	})

describe("Session event batching, interrupts, and SSE streaming", () => {
	it("reports the confirmed prefix of a batch without logging user message text when a later command fails unexpectedly", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		const loggedEntries: Array<unknown> = []
		const captureLogger = Logger.layer([
			Logger.make(({ message }) => {
				loggedEntries.push(message)
			}),
		])
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const real = yield* Session
					let failOnSend = Number.POSITIVE_INFINITY
					let sends = 0
					const flaky: typeof real = {
						...real,
						send: ((
							command: Parameters<typeof real.send>[0],
							options?: Parameters<typeof real.send>[1],
						) =>
							++sends === failOnSend
								? Effect.die(new Error("storage unavailable"))
								: real.send(command, options)) as typeof real.send,
					}
					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(Session, flaky),
					)
					const session = yield* createIdleSession(apiFetch)
					failOnSend = sends + 2
					const secretMessage = "TOP_SECRET_USER_TEXT_MUST_NOT_LOG"
					const res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [secretMessage, "second"].map((text) => ({
								type: "user.message",
								content: [{ type: "text", text }],
							})),
						},
					})
					expect(res.status).toBe(500)
					const body = (yield* Effect.promise(() => res.json())) as {
						accepted: ReadonlyArray<{ content: ReadonlyArray<{ text: string }> }>
						failed_index?: number
						unconfirmed_index?: number
					}
					expect(body.accepted.map((event) => event.content[0]?.text)).toEqual([secretMessage])
					expect(body.failed_index).toBeUndefined()
					expect(body.unconfirmed_index).toBe(1)

					const serializedLogs = JSON.stringify(loggedEntries)
					expect(serializedLogs).not.toContain(secretMessage)
					expect(serializedLogs).toContain('"accepted_count":1')
					expect(serializedLogs).toContain('"unconfirmed_index":1')
				}).pipe(Effect.scoped, Effect.provide([layer, captureLogger])),
			)
		} finally {
			await closeAll()
		}
	})

	it("enters the workspace and gives it the hosts the environment allows before each turn, and ends a turn whose preparation was interrupted", async () => {
		let modelCalls = 0
		const { layer, closeAll, workspaceCalls, preparedWorkspaces, preparations } =
			makePiDurableTestLayer(async (model) => {
				modelCalls += 1
				return makeAssistantReply(model, null, "ok", 1, 1)
			})
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendAndSettle(apiFetch, session.id, ["Hello."], 1)
					expect(workspaceCalls).toEqual([`prepare ${session.id} 1`])
					expect(preparedWorkspaces).toEqual([
						{ sessionId: session.id, repositories: [], allowedHosts: null },
					])
					expect(modelCalls).toBe(1)

					preparations.push({ ok: false, interrupted: true })
					yield* sendAndSettle(apiFetch, session.id, ["Stop."], 2)
					const listed = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
					})
					const events = (yield* Effect.promise(() => listed.json())) as {
						data: ReadonlyArray<{ type: string; stop_reason?: unknown }>
					}
					expect(events.data.at(-1)?.stop_reason).toEqual({ type: "interrupted" })
					expect(events.data.some(({ type }) => type === "session.error")).toBe(false)
					expect(modelCalls).toBe(1)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("ends an interrupted turn only when the harness stops, and stops the harness and discards the workspace when a session is archived", async () => {
		let aborted = 0
		const starts: Array<() => void> = []
		const started = [0, 1].map(
			() =>
				new Promise<void>((resolve) => {
					starts.push(resolve)
				}),
		)
		let calls = 0
		const { layer, closeAll, discardedWorkspaces, workspaceCalls } = makePiDurableTestLayer(
			async (model, _context, signal) => {
				starts[calls++]?.()
				await new Promise<void>((resolve) => {
					signal?.addEventListener(
						"abort",
						() => {
							aborted += 1
							resolve()
						},
						{ once: true },
					)
				})
				return { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" as const }
			},
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const post = (id: string, path: string, body?: unknown) =>
						sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/sessions/${id}${path}`,
							headers: AUTH_HEADERS,
							...(body === undefined ? {} : { body }),
						})
					const message = {
						events: [{ type: "user.message", content: [{ type: "text", text: "work" }] }],
					}
					const statusOf = (id: string) =>
						Effect.gen(function* () {
							const res = yield* sendRequest(apiFetch, {
								method: "GET",
								path: `/v1/sessions/${id}`,
								headers: AUTH_HEADERS,
							})
							return ((yield* Effect.promise(() => res.json())) as { status: string }).status
						})

					const interrupted = yield* createIdleSession(apiFetch)
					yield* post(interrupted.id, "/events", message)
					yield* Effect.promise(() => started[0]!)
					expect(
						(yield* post(interrupted.id, "/events", { events: [{ type: "user.interrupt" }] }))
							.status,
					).toBe(200)
					for (
						let attempt = 0;
						attempt < 400 && (yield* statusOf(interrupted.id)) !== "idle";
						attempt++
					) {
						yield* Effect.sleep("5 millis")
					}
					const listed = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${interrupted.id}/events`,
						headers: AUTH_HEADERS,
					})
					const events = (
						(yield* Effect.promise(() => listed.json())) as {
							data: ReadonlyArray<{ type: string; stop_reason?: { type: string } }>
						}
					).data
					expect(events.map((event) => event.type)).toEqual([
						"user.message",
						"session.status_running",
						"span.model_request_start",
						"user.interrupt",
						"span.model_request_end",
						"session.status_idle",
					])
					expect(events.at(-1)?.stop_reason).toEqual({ type: "interrupted" })
					expect(aborted).toBe(1)
					expect(workspaceCalls).toContain(`interrupt ${interrupted.id} 1`)

					const archived = yield* createIdleSession(apiFetch)
					yield* post(archived.id, "/events", message)
					yield* Effect.promise(() => started[1]!)
					expect((yield* post(archived.id, "/archive")).status).toBe(200)
					for (
						let attempt = 0;
						attempt < 400 && (aborted < 2 || discardedWorkspaces.length === 0);
						attempt++
					) {
						yield* Effect.sleep("5 millis")
					}
					expect(aborted).toBe(2)
					expect(discardedWorkspaces).toEqual([archived.id])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("validates oversized joined user.message text, reports partial event-batch failures, and prefers Last-Event-ID over ?after=", async () => {
		let releaseTurn: (() => void) | undefined
		const turnBlocked = new Promise<void>((resolve) => {
			releaseTurn = resolve
		})

		const { layer, closeAll } = makePiDurableTestLayer(async (model, context, signal) => {
			const text = extractLastUserText(context)
			if (text === "slow-turn") {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					const onAbort = () => resolve()
					signal?.addEventListener("abort", onAbort, { once: true })
					void turnBlocked.then(() => {
						signal?.removeEventListener("abort", onAbort)
						resolve()
					})
				})
				if (signal?.aborted) {
					return {
						...makeAssistantReply(model, null, "", 0, 0),
						stopReason: "aborted",
						errorMessage: "Aborted",
					}
				}
			}
			return makeAssistantReply(model, null, `Reply: ${text}`, 5, 3)
		})

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Test Agent", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Test Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					const oversizedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									type: "user.message",
									content: [
										{ type: "text", text: "a".repeat(9000) },
										{ type: "text", text: "b".repeat(9000) },
									],
								},
							],
						},
					})
					expect(oversizedRes.status).toBe(400)

					const runningStream = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					const slowSendRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									type: "user.message",
									content: [{ type: "text", text: "slow-turn" }],
								},
							],
						},
					})
					expect(slowSendRes.status).toBe(200)
					yield* Effect.promise(() =>
						readSseUntil(runningStream, (evt) => evt.type === "session.status_running"),
					)

					const message = (text: string) => ({
						type: "user.message",
						content: [{ type: "text", text }],
					})
					const queuedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: Array.from({ length: 7 }, (_, n) => message(`queued-${n}`)) },
					})
					expect(queuedRes.status).toBe(200)
					const overflowRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [message("eighth"), message("ninth")] },
					})
					expect(overflowRes.status).toBe(429)
					const overflowBody = (yield* Effect.promise(() => overflowRes.json())) as {
						accepted: ReadonlyArray<{ type: string; content: ReadonlyArray<{ text: string }> }>
						failed_index?: number
						unconfirmed_index?: number
					}
					expect(overflowBody.accepted.map((event) => event.content[0]?.text)).toEqual(["eighth"])
					expect(overflowBody.failed_index).toBe(1)
					expect(overflowBody.unconfirmed_index).toBeUndefined()

					releaseTurn?.()
					const waitIdleStream = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					const allSoFar = yield* Effect.promise(() =>
						readSseUntil(waitIdleStream, (evt) => evt.type === "session.status_idle"),
					)
					expect(allSoFar.length).toBeGreaterThanOrEqual(4)

					const thirdId = allSoFar[2]!.id
					const resumedStream = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream?after=1`,
						headers: { ...AUTH_HEADERS, "last-event-id": thirdId },
					})
					const resumedFrames = yield* Effect.promise(() =>
						readSseUntil(resumedStream, (evt) => evt.type === "session.status_idle"),
					)
					expect(resumedFrames.map((f) => f.id)).toEqual(allSoFar.slice(3).map((f) => f.id))

					const overriddenInvalidQueryStream = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream?after=invalid`,
						headers: { ...AUTH_HEADERS, "last-event-id": thirdId },
					})
					expect(overriddenInvalidQueryStream.status).toBe(200)
					const overriddenFrames = yield* Effect.promise(() =>
						readSseUntil(overriddenInvalidQueryStream, (evt) => evt.type === "session.status_idle"),
					)
					expect(overriddenFrames.map((f) => f.id)).toEqual(allSoFar.slice(3).map((f) => f.id))

					const invalidQueryStream = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream?after=invalid`,
						headers: AUTH_HEADERS,
					})
					expect(invalidQueryStream.status).toBe(400)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			releaseTurn?.()
			await closeAll()
		}
	})

	it("does not repeat a failed turn's prompt on the next turn and rejects version-mismatched partial updates", async () => {
		const seenInputs: Array<string> = []
		let turnCount = 0

		const { layer, closeAll } = makePiDurableTestLayer(async (model, context) => {
			turnCount++
			const text = extractLastUserText(context)
			seenInputs.push(text)
			if (turnCount === 1) {
				return {
					...makeAssistantReply(model, null, "", 0, 0),
					stopReason: "error",
					errorMessage: "temporary upstream failure",
				}
			}
			return makeAssistantReply(model, null, `Answered: ${text}`, 10, 5)
		})

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Agent One", model: "gpt-4o-mini", system: "System 1" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const mismatchAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agent.id}`,
						headers: AUTH_HEADERS,
						body: { version: 2, name: "Should Reject" },
					})
					expect(mismatchAgentRes.status).toBe(409)

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env One" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const mismatchEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/environments/${env.id}`,
						headers: AUTH_HEADERS,
						body: { version: 2, name: "Should Reject" },
					})
					expect(mismatchEnvRes.status).toBe(409)

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					const stream1 = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "First prompt" }] }],
						},
					})
					const turn1Frames = yield* Effect.promise(() =>
						readSseUntil(stream1, (evt) => evt.type === "session.status_idle"),
					)
					const afterTurn1 = turn1Frames.at(-1)!.id

					const stream2 = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream?after=${afterTurn1}`,
						headers: AUTH_HEADERS,
					})
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "Second prompt" }] },
							],
						},
					})
					const turn2Frames = yield* Effect.promise(() =>
						readSseUntil(stream2, (evt) => evt.type === "session.status_idle"),
					)
					expect(turn2Frames.find((f) => f.event === "agent.message")?.data.content).toEqual([
						{ type: "text", text: "Answered: Second prompt" },
					])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}

		expect(seenInputs).toEqual(["First prompt", "Second prompt"])
	})

	it("preserves a successor turn when user interrupts a blocked generation and immediately sends a new message", async () => {
		let turn1StartedResolve: (() => void) | undefined
		const turn1Started = new Promise<void>((resolve) => {
			turn1StartedResolve = resolve
		})
		let turn1Aborted = false

		const { layer, closeAll } = makePiDurableTestLayer(async (model, context, signal) => {
			const text = extractLastUserText(context)
			if (text === "blocked-turn-1") {
				turn1StartedResolve?.()
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						turn1Aborted = true
						resolve()
						return
					}
					signal?.addEventListener(
						"abort",
						() => {
							turn1Aborted = true
							resolve()
						},
						{ once: true },
					)
				})
				return {
					...makeAssistantReply(model, null, "", 0, 0),
					stopReason: "aborted",
					errorMessage: "Aborted by successor turn",
				}
			}
			return makeAssistantReply(model, null, `Successor: ${text}`, 8, 4)
		})

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Race Agent", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Race Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }

					const streamRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})

					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "blocked-turn-1" }] },
							],
						},
					})
					yield* Effect.promise(() => turn1Started)

					const interruptRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [{ type: "user.interrupt" }] },
					})
					expect(interruptRes.status).toBe(200)

					const turn2Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "fresh-turn-2" }] }],
						},
					})
					expect(turn2Res.status).toBe(200)

					const frames = yield* Effect.promise(() =>
						readSseUntil(streamRes, (evt) => evt.type === "agent.message"),
					)
					expect(frames.find((f) => f.event === "agent.message")?.data.content).toEqual([
						{ type: "text", text: "Successor: fresh-turn-2" },
					])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}

		expect(turn1Aborted).toBe(true)
	})

	it("pages SSE catch-up and percent-decodes route IDs", async () => {
		const listCalls: Array<{ after?: number; take?: number; returned?: number }> = []
		const eventsCalls: Array<{ readonly after?: number }> = []

		const { layer: baseLayer, closeAll } = makePiDurableTestLayer(async (model, context) =>
			makeAssistantReply(model, null, `Reply ${extractLastUserText(context)}`, 4, 2),
		)
		const spySessionViewLayer = Layer.effect(
			SessionView,
			Effect.map(SessionView, (originalViews) => ({
				...originalViews,
				list: (ref, opts) => {
					const call: (typeof listCalls)[number] = {
						...(opts?.after === undefined ? {} : { after: opts.after }),
						...(opts?.take === undefined ? {} : { take: opts.take }),
					}
					listCalls.push(call)
					return originalViews
						.list(ref, opts)
						.pipe(Effect.tap((page) => Effect.sync(() => (call.returned = page.entries.length))))
				},
				events: (ref, opts) => {
					eventsCalls.push(opts?.after === undefined ? {} : { after: opts.after })
					return originalViews.events(ref, opts)
				},
			})),
		)
		const spiedLayer = spySessionViewLayer.pipe(Layer.provideMerge(baseLayer))

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const createAgent = yield* CreateAgentDecision
					const agentViews = yield* AgentView
					const sessions = yield* Session
					const sessionViews = yield* SessionView

					const spaceReceipt = yield* createAgent.send(
						new CreateAgent({
							agent_id: AgentId.make("team A"),
							version_id: AgentVersionId.make("teamA_v1"),
							name: "Space Team",
							model: { id: "gpt-4o-mini" },
							system: null,
							description: null,
						}),
					)
					const literalReceipt = yield* createAgent.send(
						new CreateAgent({
							agent_id: AgentId.make("team%20A"),
							version_id: AgentVersionId.make("teamPct20A_v1"),
							name: "Literal Percent Team",
							model: { id: "gpt-4o-mini" },
							system: null,
							description: null,
						}),
					)
					const spaceCommit = spaceReceipt.commits.find((c) => c.stream === "Agent/team A")
					if (spaceCommit !== undefined) {
						yield* agentViews.get(Agent.ref(AgentId.make("team A")), { atLeast: spaceCommit })
					}
					const literalCommit = literalReceipt.commits.find((c) => c.stream === "Agent/team%20A")
					if (literalCommit !== undefined) {
						yield* agentViews.get(Agent.ref(AgentId.make("team%20A")), { atLeast: literalCommit })
					}

					const getSpaceRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/team%20A",
						headers: AUTH_HEADERS,
					})
					expect(getSpaceRes.status).toBe(200)
					const spaceAgent = (yield* Effect.promise(() => getSpaceRes.json())) as {
						id: string
						name: string
					}
					expect(spaceAgent).toMatchObject({ id: "team A", name: "Space Team" })

					const getLiteralRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/team%2520A",
						headers: AUTH_HEADERS,
					})
					expect(getLiteralRes.status).toBe(200)
					const literalAgent = (yield* Effect.promise(() => getLiteralRes.json())) as {
						id: string
						name: string
					}
					expect(literalAgent).toMatchObject({ id: "team%20A", name: "Literal Percent Team" })

					const updateSpaceRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents/team%20A",
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Space Team Updated" },
					})
					expect(updateSpaceRes.status).toBe(200)

					const verifyLiteralRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/team%2520A",
						headers: AUTH_HEADERS,
					})
					const verifyLiteral = (yield* Effect.promise(() => verifyLiteralRes.json())) as {
						name: string
						version: number
					}
					expect(verifyLiteral).toMatchObject({ name: "Literal Percent Team", version: 1 })

					const malformedRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/agents/%E0%A4%A",
						headers: AUTH_HEADERS,
					})
					expect(malformedRes.status).toBe(404)

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "SSE Paging Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: "team A", environment_id: env.id },
					})
					const sess = (yield* Effect.promise(() => sessRes.json())) as { id: string }
					const sessionId = SessionId.make(sess.id)

					const extraErrors = SSE_CATCHUP_PAGE_SIZE + 15
					let lastReceipt: { readonly stream: string; readonly version: number } | undefined
					for (let i = 1; i <= extraErrors; i++) {
						lastReceipt = yield* sessions.import(sessionId, [testNotice(`Event ${i}`)], {
							commandId: `test-notice-${i}`,
							expectedVersion: lastReceipt?.version ?? 1,
						})
					}
					if (lastReceipt !== undefined) {
						yield* sessionViews.get(Session.ref(sessionId), { atLeast: lastReceipt })
					}

					listCalls.length = 0
					eventsCalls.length = 0
					const streamRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sess.id}/events/stream`,
						headers: AUTH_HEADERS,
					})

					const readerPromise = readSseUntil(
						streamRes,
						(evt) =>
							evt.type === "session.error" &&
							(evt.error as { message?: string } | undefined)?.message === "Live after catchup",
					)

					yield* Effect.sleep("5 millis").pipe(
						Effect.repeat({ until: () => eventsCalls.length > 0 }),
						Effect.timeout("5 seconds"),
					)
					yield* sessions.import(sessionId, [testNotice("Live after catchup")], {
						commandId: "test-notice-live",
						expectedVersion: lastReceipt?.version ?? 1,
					})

					const allFrames = yield* Effect.promise(() => readerPromise)

					const expectedTotal = extraErrors + 1
					expect(allFrames.length).toBe(expectedTotal)
					for (let i = 0; i < allFrames.length; i++) {
						expect(allFrames[i]?.id).toBe(String(i + 1))
					}

					expect(listCalls.length).toBeGreaterThanOrEqual(2)
					for (const call of listCalls) {
						expect(call.take).toBeLessThanOrEqual(SSE_CATCHUP_PAGE_SIZE)
					}
					expect(eventsCalls).toEqual([{ after: extraErrors }])

					expect(listCalls.at(-1)).toMatchObject({ after: extraErrors, returned: 0 })
				}).pipe(Effect.scoped, Effect.provide(spiedLayer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("sends SSE keepalive comments while idle and ends the stream once the session is archived", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)

					const idle = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					const reader = idle.body?.getReader()
					if (reader === undefined) {
						throw new Error("Expected SSE response body stream")
					}
					const first = yield* Effect.promise(() => reader.read())
					expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")
					yield* Effect.promise(() => reader.cancel())

					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/archive`,
						headers: AUTH_HEADERS,
					})
					const archived = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					const text = yield* Effect.promise(() => archived.text())
					const eventNames = text
						.split("\n")
						.filter((line) => line.startsWith("event: "))
						.map((line) => line.slice(7))
					expect(eventNames.at(-1)).toBe("session.archived")

					const lastId = text
						.split("\n")
						.filter((line) => line.startsWith("id: "))
						.at(-1)
						?.slice(4)
					const caughtUp = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: { ...AUTH_HEADERS, "last-event-id": lastId ?? "" },
					})
					expect(caughtUp.status).toBe(204)

					const futureSession = yield* createIdleSession(apiFetch)
					const futureStream = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${futureSession.id}/events/stream?after=9999`,
						headers: AUTH_HEADERS,
					})
					expect(futureStream.status).toBe(200)
					const futureStreamDone = futureStream.text()
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${futureSession.id}/archive`,
						headers: AUTH_HEADERS,
					})
					const futureBody = yield* Effect.promise(() => futureStreamDone)
					expect(futureBody).not.toContain("event: session.archived")
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.succeed(SseKeepaliveInterval, "20 millis").pipe(Layer.provideMerge(layer)),
					),
				),
			)
		} finally {
			await closeAll()
		}
	})

	it("ends an idle event stream at the connection cap so clients reconnect", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
						},
					})
					const stream = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					expect(stream.status).toBe(200)
					const text = yield* Effect.promise(() => stream.text())
					expect(text).toContain("event: user.message")
					expect(text).not.toContain("event: session.archived")
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.succeed(SseMaxConnectionDuration, "400 millis").pipe(Layer.provideMerge(layer)),
					),
				),
			)
		} finally {
			await closeAll()
		}
	})

	it("distinguishes pending sessions from missing sessions across get, events, and SSE stream", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realSessionViews = yield* SessionView
					let lagMode: "off" | "timeout" | "recover" = "off"
					let waitCalls = 0
					let snapshotLagged = false
					const laggingSessionViews = {
						...realSessionViews,
						get: (
							ref: Parameters<typeof realSessionViews.get>[0],
							options?: Parameters<typeof realSessionViews.get>[1],
						) => (lagMode !== "off" ? Effect.succeedNone : realSessionViews.get(ref, options)),

						snapshot: (
							ref: Parameters<typeof realSessionViews.snapshot>[0],
							options?: Parameters<typeof realSessionViews.snapshot>[1],
						) => {
							const lagging = lagMode === "timeout" || (lagMode === "recover" && !snapshotLagged)
							snapshotLagged = lagMode === "recover" && lagging
							return realSessionViews
								.snapshot(ref, options)
								.pipe(Effect.map((real) => (lagging ? { ...real, state: null, cursor: 0 } : real)))
						},
						waitFor: (
							ref: Parameters<typeof realSessionViews.waitFor>[0],
							filter: Parameters<typeof realSessionViews.waitFor>[1],
							options: Parameters<typeof realSessionViews.waitFor>[2],
						) => {
							waitCalls += 1
							if (lagMode === "timeout") {
								return Effect.fail(
									new Domain.WaitTimeout({
										view: "SessionView",
										key: ref.id,
									}),
								)
							}
							return realSessionViews.waitFor(ref, filter, options)
						},
					} as unknown as typeof realSessionViews

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(SessionView, laggingSessionViews),
					)
					const session = yield* createIdleSession(apiFetch)
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }],
						},
					})

					lagMode = "timeout"
					for (const path of [
						`/v1/sessions/${session.id}`,
						`/v1/sessions/${session.id}/events`,
						`/v1/sessions/${session.id}/events/stream`,
					]) {
						const res = yield* sendRequest(apiFetch, {
							method: "GET",
							path,
							headers: AUTH_HEADERS,
						})
						expect(res.status).toBe(503)
						expect(yield* Effect.promise(() => res.json())).toMatchObject({
							type: "error",
							error: { type: "service_unavailable" },
						})
					}
					expect(waitCalls).toBe(3)

					const missingRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/sessions/sess_does_not_exist_404",
						headers: AUTH_HEADERS,
					})
					expect(missingRes.status).toBe(404)
					expect(waitCalls).toBe(3)

					lagMode = "recover"
					const getRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}`,
						headers: AUTH_HEADERS,
					})
					expect(getRes.status).toBe(200)
					expect(yield* Effect.promise(() => getRes.json())).toMatchObject({ id: session.id })

					const listRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
					})
					expect(listRes.status).toBe(200)

					const streamRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					expect(streamRes.status).toBe(200)
					const sseText = yield* Effect.promise(() => streamRes.text())
					expect(sseText).toContain("event: user.message")
					expect(waitCalls).toBe(6)
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.mergeAll(
							Layer.succeed(SessionReadWaitTimeout, "50 millis"),
							Layer.succeed(SseMaxConnectionDuration, "400 millis"),
						).pipe(Layer.provideMerge(layer)),
					),
				),
			)
		} finally {
			await closeAll()
		}
	})

	it("atomically rejects session creation on concurrent archive or delete even when the version view lags", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const agents = yield* Agent
					const environments = yield* Environment
					const realAdmit = yield* AdmitSessionDecision
					const realVersionsByNumber = yield* AgentVersionByNumberView
					const realSessionViews = yield* SessionView

					let beforeAdmit: (() => Effect.Effect<void>) | null = null
					let alwaysLagVersions = false
					const racingAdmit = {
						...realAdmit,
						send: (
							command: Parameters<typeof realAdmit.send>[0],
							options?: Parameters<typeof realAdmit.send>[1],
						) =>
							Effect.gen(function* () {
								const action = beforeAdmit
								beforeAdmit = null
								if (action !== null) {
									yield* action()
								}
								return yield* realAdmit.send(command, options)
							}),
					} as unknown as typeof realAdmit

					const laggingVersionsByNumber = {
						...realVersionsByNumber,
						get: (
							key: Parameters<typeof realVersionsByNumber.get>[0],
							options?: Parameters<typeof realVersionsByNumber.get>[1],
						) => (alwaysLagVersions ? Effect.succeedNone : realVersionsByNumber.get(key, options)),
						waitFor: (
							key: Parameters<typeof realVersionsByNumber.waitFor>[0],
							filter: Parameters<typeof realVersionsByNumber.waitFor>[1],
							options: Parameters<typeof realVersionsByNumber.waitFor>[2],
						) =>
							alwaysLagVersions
								? Effect.fail(
										new Domain.WaitTimeout({
											view: "AgentVersionByNumberView",
											key: String(key),
										}),
									)
								: realVersionsByNumber.waitFor(key, filter, options),
					} as unknown as typeof realVersionsByNumber

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AdmitSessionDecision, racingAdmit),
						Effect.provideService(AgentVersionByNumberView, laggingVersionsByNumber),
					)

					const createAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Race Agent", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => createAgentRes.json())) as { id: string }

					const createEnvRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Race Env" },
					})
					const env = (yield* Effect.promise(() => createEnvRes.json())) as { id: string }

					alwaysLagVersions = true
					beforeAdmit = () =>
						environments
							.send(new DeleteEnvironment({ environment_id: EnvironmentId.make(env.id) }))
							.pipe(Effect.asVoid, Effect.orDie)
					const envDeletedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					expect(envDeletedRes.status).toBe(404)

					alwaysLagVersions = false
					const createEnv2Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Race Env 2" },
					})
					const env2 = (yield* Effect.promise(() => createEnv2Res.json())) as { id: string }

					alwaysLagVersions = true
					const pendingValidRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env2.id },
					})
					expect(pendingValidRes.status).toBe(202)
					const pendingValid = (yield* Effect.promise(() => pendingValidRes.json())) as {
						id: string
						type: string
						pending: boolean
					}
					expect(pendingValid).toEqual({
						id: pendingValid.id,
						type: "session",
						pending: true,
					})

					beforeAdmit = () =>
						agents
							.send(new ArchiveAgent({ agent_id: AgentId.make(agent.id) }))
							.pipe(Effect.asVoid, Effect.orDie)
					const agentArchivedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env2.id },
					})
					expect(agentArchivedRes.status).toBe(409)

					expect(yield* realSessionViews.get(Session.ref(SessionId.make("sess_none")))).toEqual(
						Option.none(),
					)
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.succeed(AgentVersionWaitTimeout, "50 millis").pipe(Layer.provideMerge(layer)),
					),
				),
			)
		} finally {
			await closeAll()
		}
	})

	it("checks readiness for the pinned version after admission and keeps polling pending until that version projects", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const updateAgent = yield* UpdateAgentDecision
					const realAdmit = yield* AdmitSessionDecision
					const realVersionsByNumber = yield* AgentVersionByNumberView
					const realSessionViews = yield* SessionView
					let raceUpdateFrom: number | null = null
					let lagVersion2Mode: "off" | "timeout" | "recover" = "off"
					let version2Waits = 0

					const updateTo = (agentId: string, from: number) =>
						updateAgent.send(
							new UpdateAgent({
								agent_id: AgentId.make(agentId),
								expected_version: from,
								next_version_id: AgentVersionId.make(`aver_race_v${from + 1}`),
								changes: {
									name: `Agent v${from + 1}`,
									model: { id: "gpt-4o-mini" },
									system: "Updated system",
									description: null,
								},
							}),
						)

					const racingAdmit = {
						...realAdmit,
						send: (
							command: Parameters<typeof realAdmit.send>[0],
							options?: Parameters<typeof realAdmit.send>[1],
						) =>
							Effect.gen(function* () {
								if (raceUpdateFrom !== null) {
									const from = raceUpdateFrom
									raceUpdateFrom = null
									yield* updateTo(command.agent_id, from)
								}
								return yield* realAdmit.send(command, options)
							}),
					} as unknown as typeof realAdmit

					const racingVersionsByNumber = {
						...realVersionsByNumber,
						get: (
							key: Parameters<typeof realVersionsByNumber.get>[0],
							options?: Parameters<typeof realVersionsByNumber.get>[1],
						) =>
							lagVersion2Mode !== "off" && String(key).endsWith("@2")
								? Effect.succeedNone
								: realVersionsByNumber.get(key, options),
						waitFor: (
							key: Parameters<typeof realVersionsByNumber.waitFor>[0],
							filter: Parameters<typeof realVersionsByNumber.waitFor>[1],
							options: Parameters<typeof realVersionsByNumber.waitFor>[2],
						) => {
							if (String(key).endsWith("@2")) {
								version2Waits += 1
								if (lagVersion2Mode === "timeout") {
									return Effect.fail(
										new Domain.WaitTimeout({
											view: "AgentVersionByNumberView",
											key: String(key),
										}),
									)
								}
							}
							return realVersionsByNumber.waitFor(key, filter, options)
						},
					} as unknown as typeof realVersionsByNumber

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AdmitSessionDecision, racingAdmit),
						Effect.provideService(AgentVersionByNumberView, racingVersionsByNumber),
					)
					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Agent v1", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					yield* updateTo(agent.id, 1)
					lagVersion2Mode = "timeout"
					const pendingRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					expect(pendingRes.status).toBe(202)
					expect(version2Waits).toBe(1)
					const pendingBody = (yield* Effect.promise(() => pendingRes.json())) as {
						id: string
						type: string
						pending: boolean
					}
					expect(pendingBody).toEqual({ id: pendingBody.id, type: "session", pending: true })

					const pendingSessionId = SessionId.make(pendingBody.id)
					const projectedSession = yield* realSessionViews.waitFor(
						Session.ref(pendingSessionId),
						{ id: pendingSessionId },
						{ timeout: "1 second" },
					)
					expect(projectedSession?.agent_version).toBe(2)

					const stillPendingPoll = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${pendingBody.id}`,
						headers: AUTH_HEADERS,
					})
					expect(stillPendingPoll.status).toBe(503)
					expect(version2Waits).toBe(2)

					lagVersion2Mode = "recover"
					const recoveredPoll = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${pendingBody.id}`,
						headers: AUTH_HEADERS,
					})
					expect(recoveredPoll.status).toBe(200)
					expect(yield* Effect.promise(() => recoveredPoll.json())).toMatchObject({
						id: pendingBody.id,
						agent: { id: agent.id, version: 2 },
					})

					lagVersion2Mode = "recover"
					const readyRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					expect(readyRes.status).toBe(201)
					expect(yield* Effect.promise(() => readyRes.json())).toMatchObject({
						agent: { id: agent.id, version: 2 },
					})

					raceUpdateFrom = 2
					const plannedRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					expect(plannedRes.status).toBe(201)
					expect(yield* Effect.promise(() => plannedRes.json())).toMatchObject({
						agent: { id: agent.id, version: 2 },
					})
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.mergeAll(
							Layer.succeed(AgentVersionWaitTimeout, "50 millis"),
							Layer.succeed(SessionReadWaitTimeout, "50 millis"),
						).pipe(Layer.provideMerge(layer)),
					),
				),
			)
		} finally {
			await closeAll()
		}
	})

	it("replays a committed event under a fresh Idempotency-Key after the session has ended", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model, context) =>
			makeAssistantReply(model, null, `ok:${extractLastUserText(context)}`, 4, 2),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const session = yield* createIdleSession(apiFetch)
					const send = (key: string, id: string, text: string) =>
						sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/sessions/${session.id}/events`,
							headers: { ...AUTH_HEADERS, "idempotency-key": key },
							body: { events: [{ id, type: "user.message", content: [{ type: "text", text }] }] },
						})

					const first = yield* send("batch-1", "evt-1", "hello")
					expect(first.status).toBe(200)
					const accepted = (yield* Effect.promise(() => first.json())) as unknown
					const archived = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(archived.status).toBe(200)

					const replay = yield* send("batch-2", "evt-1", "hello")
					expect(replay.status).toBe(200)
					expect(yield* Effect.promise(() => replay.json())).toEqual(accepted)

					const fresh = yield* send("batch-3", "evt-2", "again")
					expect(fresh.status).toBe(409)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("deduplicates retried user.message and user.interrupt events via client event id or Idempotency-Key after an unconfirmed send", async () => {
		const seenPrompts: Array<string> = []
		let markInterruptibleStarted: () => void = () => undefined
		const interruptibleStarted = new Promise<void>((resolve) => {
			markInterruptibleStarted = resolve
		})

		const { layer, closeAll } = makePiDurableTestLayer(async (model, context, signal) => {
			const prompt = extractLastUserText(context)
			seenPrompts.push(prompt)
			if (prompt === "hold-for-interrupt") {
				markInterruptibleStarted()
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve(), { once: true })
				})
				return { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" as const }
			}
			return makeAssistantReply(model, null, `ok:${prompt}`, 4, 2)
		})

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const real = yield* Session
					let dropReceiptOnSend = Number.POSITIVE_INFINITY
					let sends = 0
					const dropAfterCommit: typeof real = {
						...real,
						send: ((
							command: Parameters<typeof real.send>[0],
							options?: Parameters<typeof real.send>[1],
						) => {
							const sendNumber = ++sends
							if (sendNumber === dropReceiptOnSend) {
								return real
									.send(command, options)
									.pipe(Effect.andThen(Effect.die(new Error("receipt lost after commit"))))
							}
							return real.send(command, options)
						}) as typeof real.send,
					}
					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(Session, dropAfterCommit),
					)
					const waitIdle = (sessionId: string, expectedTurn: number) =>
						Effect.gen(function* () {
							for (let attempt = 0; attempt < 400; attempt++) {
								const res = yield* sendRequest(apiFetch, {
									method: "GET",
									path: `/v1/sessions/${sessionId}`,
									headers: AUTH_HEADERS,
								})
								const body = (yield* Effect.promise(() => res.json())) as {
									status: string
									turn: number
								}
								if (body.status === "idle" && body.turn >= expectedTurn) {
									return body
								}
								yield* Effect.sleep("5 millis")
							}
							throw new Error(`Session ${sessionId} did not settle to turn ${expectedTurn}`)
						})

					const sessA = yield* createIdleSession(apiFetch)
					dropReceiptOnSend = sends + 2
					const firstBatchRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessA.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									id: "evt-a1",
									type: "user.message",
									content: [{ type: "text", text: "msg-a1" }],
								},
								{
									id: "evt-a2",
									type: "user.message",
									content: [{ type: "text", text: "msg-a2" }],
								},
							],
						},
					})
					expect(firstBatchRes.status).toBe(500)
					const firstBatchBody = (yield* Effect.promise(() => firstBatchRes.json())) as {
						accepted: ReadonlyArray<{ id?: string; turn?: number }>
						unconfirmed_index?: number
					}
					expect(firstBatchBody.accepted).toHaveLength(1)
					expect(firstBatchBody.accepted[0]).toMatchObject({
						id: expect.stringContaining(`sevt_${sessA.id}_input_`),
						processed_at: null,
						turn: 1,
					})
					expect(firstBatchBody.unconfirmed_index).toBe(1)

					const suffixRetryRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessA.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									id: "evt-a2",
									type: "user.message",
									content: [{ type: "text", text: "msg-a2" }],
								},
							],
						},
					})
					expect(suffixRetryRes.status).toBe(200)
					const suffixRetryBody = (yield* Effect.promise(() => suffixRetryRes.json())) as {
						data: ReadonlyArray<{
							id?: string
							type: string
							turn: number
							queued: boolean
							content: ReadonlyArray<{ type: string; text: string }>
						}>
					}
					expect(suffixRetryBody).toEqual({
						data: [
							{
								id: expect.stringContaining(`sevt_${sessA.id}_input_`),
								processed_at: null,
								type: "user.message",
								turn: 2,
								queued: expect.any(Boolean),
								content: [{ type: "text", text: "msg-a2" }],
							},
						],
					})
					const evtA2Queued = suffixRetryBody.data[0]?.queued

					const fullRetryRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessA.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									id: "evt-a1",
									type: "user.message",
									content: [{ type: "text", text: "msg-a1" }],
								},
								{
									id: "evt-a2",
									type: "user.message",
									content: [{ type: "text", text: "msg-a2" }],
								},
							],
						},
					})
					expect(fullRetryRes.status).toBe(200)
					expect(yield* Effect.promise(() => fullRetryRes.json())).toEqual({
						data: [
							{
								id: firstBatchBody.accepted[0]?.id,
								processed_at: null,
								type: "user.message",
								turn: 1,
								queued: false,
								content: [{ type: "text", text: "msg-a1" }],
							},
							{
								id: suffixRetryBody.data[0]?.id,
								processed_at: null,
								type: "user.message",
								turn: 2,
								queued: evtA2Queued,
								content: [{ type: "text", text: "msg-a2" }],
							},
						],
					})

					const settledA = yield* waitIdle(sessA.id, 2)
					expect(settledA.turn).toBe(2)
					const eventsARes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessA.id}/events`,
						headers: AUTH_HEADERS,
					})
					const eventsA = (
						(yield* Effect.promise(() => eventsARes.json())) as {
							data: ReadonlyArray<{
								id: string
								type: string
								content?: ReadonlyArray<{ text: string }>
							}>
						}
					).data
					const userMessagesA = eventsA
						.filter((e) => e.type === "user.message")
						.map((e) => e.content?.[0]?.text)
					expect(userMessagesA).toEqual(["msg-a1", "msg-a2"])
					expect(eventsA.filter((e) => e.type === "user.message").map(({ id }) => id)).toEqual([
						firstBatchBody.accepted[0]?.id,
						suffixRetryBody.data[0]?.id,
					])
					expect(seenPrompts).toEqual(["msg-a1", "msg-a2"])

					const conflictTextRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessA.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									id: "evt-a1",
									type: "user.message",
									content: [{ type: "text", text: "different-text" }],
								},
							],
						},
					})
					expect(conflictTextRes.status).toBe(409)

					const conflictTypeRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessA.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [{ id: "evt-a1", type: "user.interrupt" }] },
					})
					expect(conflictTypeRes.status).toBe(409)

					const dupInBatchRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessA.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{ id: "dup-1", type: "user.message", content: [{ type: "text", text: "x" }] },
								{ id: "dup-1", type: "user.message", content: [{ type: "text", text: "y" }] },
							],
						},
					})
					expect(dupInBatchRes.status).toBe(400)

					const sessB = yield* createIdleSession(apiFetch)
					const batchPayloadB = {
						events: [
							{ type: "user.message", content: [{ type: "text", text: "msg-b1" }] },
							{ type: "user.message", content: [{ type: "text", text: "msg-b2" }] },
						],
					}
					dropReceiptOnSend = sends + 3
					const keyFirstRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessB.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "batch-key-b" },
						body: batchPayloadB,
					})
					expect(keyFirstRes.status).toBe(500)
					const keyFirstBody = (yield* Effect.promise(() => keyFirstRes.json())) as {
						unconfirmed_index?: number
					}
					expect(keyFirstBody.unconfirmed_index).toBe(1)

					const keyRetryRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessB.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "batch-key-b" },
						body: batchPayloadB,
					})
					expect(keyRetryRes.status).toBe(200)
					expect(yield* Effect.promise(() => keyRetryRes.json())).toEqual({
						data: [
							{
								id: expect.stringContaining(`sevt_${sessB.id}_input_`),
								processed_at: null,
								type: "user.message",
								turn: 1,
								queued: false,
								content: [{ type: "text", text: "msg-b1" }],
							},
							{
								id: expect.stringContaining(`sevt_${sessB.id}_input_`),
								processed_at: null,
								type: "user.message",
								turn: 2,
								queued: expect.any(Boolean),
								content: [{ type: "text", text: "msg-b2" }],
							},
						],
					})
					const settledB = yield* waitIdle(sessB.id, 2)
					expect(settledB.turn).toBe(2)
					const eventsBRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessB.id}/events`,
						headers: AUTH_HEADERS,
					})
					const eventsB = (
						(yield* Effect.promise(() => eventsBRes.json())) as {
							data: ReadonlyArray<{ type: string; content?: ReadonlyArray<{ text: string }> }>
						}
					).data
					expect(
						eventsB.filter((e) => e.type === "user.message").map((e) => e.content?.[0]?.text),
					).toEqual(["msg-b1", "msg-b2"])
					expect(seenPrompts).toEqual(["msg-a1", "msg-a2", "msg-b1", "msg-b2"])

					const sessC = yield* createIdleSession(apiFetch)
					yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessC.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									id: "evt-c1",
									type: "user.message",
									content: [{ type: "text", text: "hold-for-interrupt" }],
								},
							],
						},
					})
					yield* Effect.promise(() => interruptibleStarted)

					dropReceiptOnSend = sends + 1
					const interruptLostRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessC.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [{ id: "int-c1", type: "user.interrupt" }] },
					})
					expect(interruptLostRes.status).toBe(500)
					expect(yield* Effect.promise(() => interruptLostRes.json())).toMatchObject({
						unconfirmed_index: 0,
					})

					yield* waitIdle(sessC.id, 1)

					const interruptRetryRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessC.id}/events`,
						headers: AUTH_HEADERS,
						body: { events: [{ id: "int-c1", type: "user.interrupt" }] },
					})
					expect(interruptRetryRes.status).toBe(200)
					expect(yield* Effect.promise(() => interruptRetryRes.json())).toEqual({
						data: [
							{
								id: expect.stringContaining(`sevt_${sessC.id}_input_`),
								type: "user.interrupt",
								processed_at: null,
							},
						],
					})

					const interruptConflictRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessC.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									id: "int-c1",
									type: "user.message",
									content: [{ type: "text", text: "should-conflict" }],
								},
							],
						},
					})
					expect(interruptConflictRes.status).toBe(409)

					const eventsCRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessC.id}/events`,
						headers: AUTH_HEADERS,
					})
					const eventsC = (
						(yield* Effect.promise(() => eventsCRes.json())) as {
							data: ReadonlyArray<{ type: string }>
						}
					).data
					expect(eventsC.filter((e) => e.type === "user.interrupt")).toHaveLength(1)

					const sessD = yield* createIdleSession(apiFetch)
					const batchD1 = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessD.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "bind-key-d1" },
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "only-a" }] }],
						},
					})
					expect(batchD1.status).toBe(200)

					const batchD1Extended = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessD.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "bind-key-d1" },
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "only-a" }] },
								{ type: "user.message", content: [{ type: "text", text: "extra-b" }] },
							],
						},
					})
					expect(batchD1Extended.status).toBe(409)
					yield* waitIdle(sessD.id, 1)

					const batchD2 = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessD.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "bind-key-d2" },
						body: {
							events: [
								{
									id: "exp-1",
									type: "user.message",
									content: [{ type: "text", text: "explicit-1" }],
								},
							],
						},
					})
					expect(batchD2.status).toBe(200)

					const batchD2Bypass = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessD.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "bind-key-d2" },
						body: {
							events: [
								{
									id: "exp-1",
									type: "user.message",
									content: [{ type: "text", text: "explicit-1" }],
								},
								{
									id: "exp-2",
									type: "user.message",
									content: [{ type: "text", text: "explicit-2-must-not-commit" }],
								},
							],
						},
					})
					expect(batchD2Bypass.status).toBe(409)
					yield* waitIdle(sessD.id, 2)

					const batchD3Payload = {
						events: [
							{
								id: "exp-3a",
								type: "user.message",
								content: [{ type: "text", text: "resume-a" }],
							},
							{
								id: "exp-3b",
								type: "user.message",
								content: [{ type: "text", text: "resume-b" }],
							},
						],
					}
					dropReceiptOnSend = sends + 3
					const batchD3Fail = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessD.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "bind-key-d3" },
						body: batchD3Payload,
					})
					expect(batchD3Fail.status).toBe(500)

					const batchD3Short = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessD.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "bind-key-d3" },
						body: { events: [batchD3Payload.events[1]] },
					})
					expect(batchD3Short.status).toBe(409)

					const batchD3Identical = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessD.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "bind-key-d3" },
						body: batchD3Payload,
					})
					expect(batchD3Identical.status).toBe(200)

					yield* waitIdle(sessD.id, 4)
					const eventsDRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessD.id}/events`,
						headers: AUTH_HEADERS,
					})
					const eventsD = (
						(yield* Effect.promise(() => eventsDRes.json())) as {
							data: ReadonlyArray<{ type: string; content?: ReadonlyArray<{ text: string }> }>
						}
					).data
					expect(
						eventsD.filter((e) => e.type === "user.message").map((e) => e.content?.[0]?.text),
					).toEqual(["only-a", "explicit-1", "resume-a", "resume-b"])

					const sessE = yield* createIdleSession(apiFetch)
					const batchE = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessE.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "bind-key-d1" },
						body: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "different-session" }] },
							],
						},
					})
					expect(batchE.status).toBe(200)

					const missingSessionRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions/sess_does_not_exist/events",
						headers: { ...AUTH_HEADERS, "idempotency-key": "missing-key" },
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "nope" }] }],
						},
					})
					expect(missingSessionRes.status).toBe(404)

					const sessG = yield* createIdleSession(apiFetch)
					const batchG = {
						events: [{ type: "user.message", content: [{ type: "text", text: "claim-lost" }] }],
					}
					dropReceiptOnSend = sends + 1
					const claimLostRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessG.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "claim-lost-key" },
						body: batchG,
					})
					expect(claimLostRes.status).toBe(500)
					const claimRetryRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sessG.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "claim-lost-key" },
						body: batchG,
					})
					expect(claimRetryRes.status).toBe(200)
					yield* waitIdle(sessG.id, 1)

					const racing = (key: string, text: string) =>
						sendRequest(apiFetch, {
							method: "POST",
							path: `/v1/sessions/${sessG.id}/events`,
							headers: { ...AUTH_HEADERS, "idempotency-key": key },
							body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
						})
					const sameBody = yield* Effect.all(
						[racing("race-same", "race-same"), racing("race-same", "race-same")],
						{ concurrency: "unbounded" },
					)
					expect(sameBody.map((res) => res.status)).toEqual([200, 200])
					yield* waitIdle(sessG.id, 2)
					const differentBody = yield* Effect.all(
						[racing("race-diff", "race-diff-a"), racing("race-diff", "race-diff-b")],
						{ concurrency: "unbounded" },
					)
					expect(differentBody.map((res) => res.status).toSorted((a, b) => a - b)).toEqual([
						200, 409,
					])
					yield* waitIdle(sessG.id, 3)
					const eventsGRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessG.id}/events`,
						headers: AUTH_HEADERS,
					})
					const eventsG = (
						(yield* Effect.promise(() => eventsGRes.json())) as {
							data: ReadonlyArray<{ type: string; content?: ReadonlyArray<{ text: string }> }>
						}
					).data
					const committedG = eventsG
						.filter((e) => e.type === "user.message")
						.map((e) => e.content?.[0]?.text)
					expect(committedG.slice(0, 2)).toEqual(["claim-lost", "race-same"])
					expect(committedG).toHaveLength(3)
					expect(["race-diff-a", "race-diff-b"]).toContain(committedG[2])

					const sessF = yield* createIdleSession(apiFetch)
					const schemaFailure = yield* Effect.flip(
						Schema.decodeUnknownEffect(Schema.Finite)("not-a-number"),
					)
					let failWithSchemaErrorOnce = true
					const corruptReceiptSession: typeof real = {
						...real,
						send: ((
							command: Parameters<typeof real.send>[0],
							options?: Parameters<typeof real.send>[1],
						) => {
							if (failWithSchemaErrorOnce) {
								failWithSchemaErrorOnce = false
								return real.send(command, options).pipe(Effect.andThen(Effect.die(schemaFailure)))
							}
							return real.send(command, options)
						}) as typeof real.send,
					}
					const { fetch: corruptFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(Session, corruptReceiptSession),
					)
					const corruptRes = yield* sendRequest(corruptFetch, {
						method: "POST",
						path: `/v1/sessions/${sessF.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									id: "evt-f1",
									type: "user.message",
									content: [{ type: "text", text: "commit-then-schema-error" }],
								},
							],
						},
					})
					expect(corruptRes.status).toBe(500)
					expect(yield* Effect.promise(() => corruptRes.json())).toMatchObject({
						unconfirmed_index: 0,
					})

					const recoveredFRes = yield* sendRequest(corruptFetch, {
						method: "POST",
						path: `/v1/sessions/${sessF.id}/events`,
						headers: AUTH_HEADERS,
						body: {
							events: [
								{
									id: "evt-f1",
									type: "user.message",
									content: [{ type: "text", text: "commit-then-schema-error" }],
								},
							],
						},
					})
					expect(recoveredFRes.status).toBe(200)
					yield* waitIdle(sessF.id, 1)
					const eventsFRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessF.id}/events`,
						headers: AUTH_HEADERS,
					})
					const eventsF = (
						(yield* Effect.promise(() => eventsFRes.json())) as {
							data: ReadonlyArray<{ type: string }>
						}
					).data
					expect(eventsF.filter((e) => e.type === "user.message")).toHaveLength(1)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("enforces ResourceId length limits on AdmitSession command inputs matching SessionCreated", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const overLimit = "a".repeat(257)
					const atLimitAgent = AgentId.make("a".repeat(256))
					const atLimitEnv = EnvironmentId.make("e".repeat(256))

					const badAgent = yield* Effect.result(
						Schema.decodeEffect(AdmitSession)({
							_tag: "AdmitSession",
							session_id: "sess_1",
							agent_id: overLimit,
							agent_version: null,
							environment_id: "env_1",
							title: null,
							mcp_server_credentials: "[]",
							resources: [],
						}),
					)
					expect(badAgent._tag).toBe("Failure")

					const badEnv = yield* Effect.result(
						Schema.decodeEffect(AdmitSession)({
							_tag: "AdmitSession",
							session_id: "sess_1",
							agent_id: "agent_1",
							agent_version: null,
							environment_id: overLimit,
							title: null,
							mcp_server_credentials: "[]",
							resources: [],
						}),
					)
					expect(badEnv._tag).toBe("Failure")

					expect(
						() =>
							new AdmitSession({
								session_id: SessionId.make("sess_1"),
								agent_id: AgentId.make(overLimit),
								agent_version: null,
								environment_id: EnvironmentId.make("env_1"),
								title: null,
								mcp_server_credentials: "[]",
							}),
					).toThrow(/Schema validation failed/)

					expect(
						() =>
							new AdmitSession({
								session_id: SessionId.make("sess_1"),
								agent_id: AgentId.make("agent_1"),
								agent_version: null,
								environment_id: EnvironmentId.make(overLimit),
								title: null,
								mcp_server_credentials: "[]",
							}),
					).toThrow(/Schema validation failed/)

					const createAgent = yield* CreateAgentDecision
					yield* createAgent.send(
						new CreateAgent({
							agent_id: atLimitAgent,
							version_id: AgentVersionId.make("aver_max_1"),
							name: "Max Len Agent",
							model: { id: "gpt-4o-mini" },
							system: null,
							description: null,
						}),
					)
					const environments = yield* Environment
					const { CreateEnvironment } = yield* Effect.promise(
						() => import("@checkfu/domain/Environment/CreateEnvironment.command"),
					)
					yield* environments.send(
						new CreateEnvironment({
							environment_id: atLimitEnv,
							name: "Max Len Env",
							description: null,
							config: { type: "cloud", networking: { type: "unrestricted" } },
						}),
					)
					const admitSession = yield* AdmitSessionDecision
					const receipt = yield* admitSession.send(
						new AdmitSession({
							session_id: SessionId.make("sess_max_len"),
							agent_id: atLimitAgent,
							agent_version: null,
							environment_id: atLimitEnv,
							title: null,
							mcp_server_credentials: "[]",
						}),
					)
					expect(receipt.reply.agent_version).toBe(1)
				}).pipe(Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("reads nothing from SessionView while an SSE stream is idle, and closes on archive", async () => {
		let snapshotCalls = 0
		let listCalls = 0
		let getCalls = 0
		let liveReads = 0

		const { layer: baseLayer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		const spySessionViewLayer = Layer.effect(
			SessionView,
			Effect.map(SessionView, (real) => ({
				...real,
				snapshot: (ref, opts) => {
					snapshotCalls += 1
					return real.snapshot(ref, opts)
				},
				list: (ref, opts) => {
					listCalls += 1
					return real.list(ref, opts)
				},
				get: (ref, opts) => {
					getCalls += 1
					return real.get(ref, opts)
				},
				events: (ref, opts) => {
					liveReads += 1
					return real.events(ref, opts)
				},
			})),
		)
		const spiedLayer = spySessionViewLayer.pipe(Layer.provideMerge(baseLayer))

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const sessions = yield* Session
					const session = yield* createIdleSession(apiFetch)
					const sessionId = SessionId.make(session.id)

					snapshotCalls = 0
					getCalls = 0
					const streamRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream`,
						headers: AUTH_HEADERS,
					})
					expect(streamRes.status).toBe(200)
					expect([snapshotCalls, getCalls]).toEqual([1, 0])

					const readerPromise = readSseUntil(
						streamRes,
						(evt) =>
							evt.type === "session.error" &&
							(evt.error as { message?: string } | undefined)?.message === "Wake idle stream",
					)

					yield* Effect.sleep("5 millis").pipe(
						Effect.repeat({ until: () => liveReads > 0 }),
						Effect.timeout("5 seconds"),
					)
					snapshotCalls = 0
					listCalls = 0
					getCalls = 0
					yield* Effect.sleep("420 millis")
					expect(snapshotCalls).toBe(0)
					expect(listCalls).toBe(0)
					expect(getCalls).toBe(0)

					yield* sessions.import(sessionId, [testNotice("Wake idle stream")], {
						commandId: "test-notice-wake",
						expectedVersion: 1,
					})
					const frames = yield* Effect.promise(() => readerPromise)
					expect(frames).toHaveLength(1)
					expect(snapshotCalls).toBe(0)
					expect(listCalls).toBe(0)
					expect(getCalls).toBe(0)

					const futureStream = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events/stream?after=9999`,
						headers: AUTH_HEADERS,
					})
					expect(futureStream.status).toBe(200)
					snapshotCalls = 0
					listCalls = 0
					getCalls = 0
					const futureDone = futureStream.text()
					yield* Effect.sleep("50 millis")
					expect(listCalls).toBe(0)
					expect(getCalls).toBe(0)

					const archiveRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${session.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(archiveRes.status).toBe(200)
					const body = yield* Effect.promise(() => futureDone)
					expect(body).not.toContain("event: session.archived")
					expect(snapshotCalls).toBe(0)
					expect(listCalls).toBe(0)
				}).pipe(Effect.scoped, Effect.provide(spiedLayer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("maps every emitted session event type to the exact public JSON on list and SSE endpoints", async () => {
		const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
		const sessionId = SessionId.make("sess_capture")
		const samples: ReadonlyArray<{
			readonly event: DomainSessionEvent
			readonly expectedJson: object
		}> = [
			{
				event: new UserMessage({ content: [{ type: "text", text: "Hello" }] }),
				expectedJson: {
					id: `sevt_${sessionId}_1`,
					seq: 1,
					type: "user.message",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: null,
					content: [{ type: "text", text: "Hello" }],
				},
			},
			{
				event: new UserInterrupt({ turn: 1 }),
				expectedJson: {
					id: `sevt_${sessionId}_2`,
					seq: 2,
					type: "user.interrupt",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: null,
				},
			},
			{
				event: new SessionStatusRunning({ turn: 1 }),
				expectedJson: {
					id: `sevt_${sessionId}_3`,
					seq: 3,
					type: "session.status_running",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					turn: 1,
				},
			},
			{
				event: new SpanModelRequestStart({ model_request_start_id: "sess_1:turn:1:req:1" }),
				expectedJson: {
					id: `sevt_${sessionId}_4`,
					seq: 4,
					type: "span.model_request_start",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					model_request_start_id: "sess_1:turn:1:req:1",
				},
			},
			{
				event: new AgentToolUse({
					tool_use_id: "call_1",
					name: "read",
					input: { path: "/workspace/notes.md", lines: [1, 20] },
				}),
				expectedJson: {
					id: `sevt_${sessionId}_tool_call_1`,
					seq: 5,
					type: "agent.tool_use",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					tool_use_id: `sevt_${sessionId}_tool_call_1`,
					name: "read",
					input: { path: "/workspace/notes.md", lines: [1, 20] },
				},
			},
			{
				event: new AgentToolResult({
					tool_use_id: "call_1",
					content: [{ type: "text", text: "# Notes" }],
					is_error: false,
					truncated: true,
				}),
				expectedJson: {
					id: `sevt_${sessionId}_6`,
					seq: 6,
					type: "agent.tool_result",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					tool_use_id: `sevt_${sessionId}_tool_call_1`,
					content: [{ type: "text", text: "# Notes" }],
					is_error: false,
					truncated: true,
				},
			},
			{
				event: new AgentThinking({ thinking: "Let me think" }),
				expectedJson: {
					id: `sevt_${sessionId}_7`,
					seq: 7,
					type: "agent.thinking",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
				},
			},
			{
				event: new AgentMessage({ content: [{ type: "text", text: "Hi there" }] }),
				expectedJson: {
					id: `sevt_${sessionId}_8`,
					seq: 8,
					type: "agent.message",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					content: [{ type: "text", text: "Hi there" }],
				},
			},
			{
				event: new AgentMessage({
					content: [{ type: "text", text: "Hi..." }],
					truncated: true,
				}),
				expectedJson: {
					id: `sevt_${sessionId}_9`,
					seq: 9,
					type: "agent.message",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					content: [{ type: "text", text: "Hi..." }],
					truncated: true,
				},
			},
			{
				event: new SpanModelRequestEnd({
					model_request_start_id: "sess_1:turn:1:req:1",
					model_usage: { input_tokens: 10, output_tokens: 5 },
					is_error: false,
				}),
				expectedJson: {
					id: `sevt_${sessionId}_10`,
					seq: 10,
					type: "span.model_request_end",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					model_request_start_id: "sess_1:turn:1:req:1",
					model_usage: { input_tokens: 10, output_tokens: 5 },
					is_error: false,
				},
			},
			{
				event: new SpanModelRequestEnd({
					model_request_start_id: "sess_1:turn:1:req:1",
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: null,
				}),
				expectedJson: {
					id: `sevt_${sessionId}_11`,
					seq: 11,
					type: "span.model_request_end",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					model_request_start_id: "sess_1:turn:1:req:1",
					model_usage: { input_tokens: 0, output_tokens: 0 },
					is_error: null,
				},
			},
			{
				event: new SessionStatusIdle({
					stop_reason: { type: "end_turn" },
					turn: 1,
					event_ids: "[]",
				}),
				expectedJson: {
					id: `sevt_${sessionId}_12`,
					seq: 12,
					type: "session.status_idle",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					stop_reason: { type: "end_turn" },
					turn: 1,
				},
			},
			{
				event: new SessionErrorEvent({
					error: {
						type: "provider_error",
						message: "boom",
						retry_status: { type: "exhausted" },
					},
				}),
				expectedJson: {
					id: `sevt_${sessionId}_13`,
					seq: 13,
					type: "session.error",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					error: {
						type: "provider_error",
						message: "boom",
						retry_status: { type: "exhausted" },
					},
				},
			},
			{
				event: new AgentMcpToolUse({
					tool_use_id: "tu_9",
					mcp_server_name: "docs",
					name: "search",
					input: { query: "rate limits" },
				}),
				expectedJson: {
					id: `sevt_${sessionId}_tool_tu_9`,
					seq: 14,
					type: "agent.mcp_tool_use",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					tool_use_id: `sevt_${sessionId}_tool_tu_9`,
					mcp_server_name: "docs",
					name: "search",
					input: { query: "rate limits" },
				},
			},
			{
				event: new AgentMcpToolResult({
					tool_use_id: "tu_9",
					content: [{ type: "text", text: "60 per minute" }],
					is_error: false,
				}),
				expectedJson: {
					id: `sevt_${sessionId}_15`,
					seq: 15,
					type: "agent.mcp_tool_result",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					tool_use_id: `sevt_${sessionId}_tool_tu_9`,
					content: [{ type: "text", text: "60 per minute" }],
					is_error: false,
				},
			},
			{
				event: new AgentCustomToolUse({
					tool_use_id: "tu_20",
					name: "lookup_order",
					input: { order: 42 },
				}),
				expectedJson: {
					id: `sevt_${sessionId}_tool_tu_20`,
					seq: 16,
					type: "agent.custom_tool_use",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					tool_use_id: `sevt_${sessionId}_tool_tu_20`,
					name: "lookup_order",
					input: { order: 42 },
				},
			},
			{
				event: new SessionStatusIdle({
					stop_reason: { type: "requires_action" },
					event_ids: encodeToolUseIds(["tu_20", "tu_21"]),
					turn: 1,
				}),
				expectedJson: {
					id: `sevt_${sessionId}_17`,
					seq: 17,
					type: "session.status_idle",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
					stop_reason: {
						type: "requires_action",
						event_ids: [`sevt_${sessionId}_tool_tu_20`, `sevt_${sessionId}_tool_tu_21`],
					},
					turn: 1,
				},
			},
			{
				event: new UserToolConfirmation({
					tool_use_id: "tu_21",
					result: "deny",
					deny_message: "No",
				}),
				expectedJson: {
					id: `sevt_${sessionId}_18`,
					seq: 18,
					type: "user.tool_confirmation",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: null,
					tool_use_id: `sevt_${sessionId}_tool_tu_21`,
					result: "deny",
					deny_message: "No",
				},
			},
			{
				event: new UserCustomToolResult({
					custom_tool_use_id: "tu_20",
					content: [{ type: "text", text: "shipped" }],
					is_error: true,
				}),
				expectedJson: {
					id: `sevt_${sessionId}_19`,
					seq: 19,
					type: "user.custom_tool_result",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: null,
					custom_tool_use_id: `sevt_${sessionId}_tool_tu_20`,
					content: [{ type: "text", text: "shipped" }],
					is_error: true,
				},
			},
			{
				event: new SessionStatusTerminated({ running_turn: null, event_ids: "[]" }),
				expectedJson: {
					id: `sevt_${sessionId}_20`,
					seq: 20,
					type: "session.status_terminated",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
				},
			},
			{
				event: new SessionArchived(),
				expectedJson: {
					id: `sevt_${sessionId}_21`,
					seq: 21,
					type: "session.archived",
					created_at: "2026-01-01T00:00:00.000Z",
					processed_at: "2026-01-01T00:00:00.000Z",
				},
			},
		]

		const viewTags = (SessionView.definition.events ?? []).map((event) => event.tag).toSorted()
		expect([...new Set(samples.map((sample) => sample.event._tag))].toSorted()).toEqual(viewTags)

		const encodeEvent = Schema.encodeSync(Schema.toCodecJson(SessionEvent))
		const entries = samples.map((sample, index) => ({
			event: sample.event,
			state: null,
			envelope: {
				id: sessionId,
				stream: `SessionView/${sessionId}`,
				seq: index + 1,
				at,
				commandId: `cmd_${index + 1}`,
				correlationId: `corr_${index + 1}`,
			},
		}))

		for (const [index, entry] of entries.entries()) {
			const expected = samples[index]!.expectedJson
			const encoded = encodeEvent(serializeSessionEvent(entry))
			expect(encoded).toEqual(expected)
			expect(JSON.stringify(encoded)).toBe(JSON.stringify(expected))
		}

		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "unused", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const real = yield* SessionView
					const snapshot = {
						id: sessionId,
						type: "session" as const,
						mcp_server_credentials: [],
						status: "terminated" as const,
						agent_id: "agent_1",
						agent_version: 1,
						environment_id: "env_1",
						title: null,
						resources: [],
						turn: 1,
						usage: { input_tokens: 10, output_tokens: 5 },
						created_at: at,
						updated_at: at,
						archived_at: at,
					}
					const stubbed: typeof real = {
						...real,
						get: () => Effect.succeedSome(snapshot),
						snapshot: () => Effect.succeed({ state: snapshot, cursor: entries.length }),
						list: () => Effect.succeed({ entries, cursor: null }),
					}
					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(SessionView, stubbed),
					)

					const listRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessionId}/events`,
						headers: AUTH_HEADERS,
					})
					expect(listRes.status).toBe(200)
					const listText = yield* Effect.promise(() => listRes.text())
					expect(listText).toBe(
						JSON.stringify({
							data: samples.map((sample) => sample.expectedJson),
							has_more: false,
							next_cursor: null,
						}),
					)

					const sseRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${sessionId}/events/stream`,
						headers: AUTH_HEADERS,
					})
					expect(sseRes.status).toBe(200)
					const sseText = yield* Effect.promise(() => sseRes.text())
					const expectedSse = samples
						.map(
							(sample, index) =>
								`id: ${index + 1}\nevent: ${sample.event._tag}\ndata: ${JSON.stringify(sample.expectedJson)}\n\n`,
						)
						.join("")
					expect(sseText).toBe(expectedSse)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("maps every event declared by SessionView.definition.events", async () => {
		const viewEvents = SessionView.definition.events ?? []
		expect(viewEvents.length).toBeGreaterThan(0)
		expect(SessionEvent.members).toHaveLength(viewEvents.length)

		const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
		const eventCodec = Schema.toCodecJson(SessionEvent)
		const encodeEvent = Schema.encodeSync(eventCodec)
		const decodeEvent = Schema.decodeUnknownSync(eventCodec)

		await Effect.runPromise(
			Effect.forEach(viewEvents, (eventSchema, index) =>
				Effect.gen(function* () {
					const [generated] = yield* Arbitrary.sampleEffect(Arbitrary.schema(eventSchema), {
						count: 1,
						seed: eventSchema.tag,
					})
					const seq = index + 1
					const mapped = serializeSessionEvent({
						envelope: { id: "sess_generated", commandId: "cmd", seq, at },
						event: generated as DomainSessionEvent,
					})
					const encoded = encodeEvent(mapped)
					const expectedId =
						mapped.type === "agent.tool_use" ||
						mapped.type === "agent.mcp_tool_use" ||
						mapped.type === "agent.custom_tool_use"
							? mapped.tool_use_id
							: `sevt_sess_generated_${seq}`
					expect(encoded).toMatchObject({
						id: expectedId,
						seq,
						type: eventSchema.tag,
						created_at: "2026-01-01T00:00:00.000Z",
					})
					expect(decodeEvent(encoded)).toEqual(mapped)
				}),
			),
		)
	})

	it("creates a session and its initial events together and replays the same create", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const base = yield* createIdleSession(apiFetch)
					const previous = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${base.id}`,
						headers: AUTH_HEADERS,
					})
					const { agent } = (yield* Effect.promise(() => previous.json())) as {
						agent: { id: string }
					}
					const create = (messages: ReadonlyArray<string>) =>
						sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/sessions",
							headers: { ...AUTH_HEADERS, "idempotency-key": "create-with-initial-events" },
							body: {
								agent: agent.id,
								environment_id: base.environment_id,
								initial_events: messages.map((text) => ({
									type: "user.message",
									content: [{ type: "text", text }],
								})),
							},
						})

					const created = yield* create(["first"])
					expect(created.status).toBe(201)
					const session = (yield* Effect.promise(() => created.json())) as { id: string }
					expect(session).toMatchObject({ status: "running", turn: 1 })

					const replay = yield* create(["first"])
					expect(replay.status).toBe(201)
					expect(yield* Effect.promise(() => replay.json())).toEqual(session)
					const conflict = yield* create(["different"])
					expect(conflict.status).toBe(409)

					const listed = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events`,
						headers: AUTH_HEADERS,
					})
					const { data } = (yield* Effect.promise(() => listed.json())) as {
						data: ReadonlyArray<{ type: string; content: ReadonlyArray<{ text: string }> }>
					}
					expect(data.slice(0, 2).map(({ type }) => type)).toEqual([
						"user.message",
						"session.status_running",
					])
					expect(
						data
							.filter(({ type }) => type === "user.message")
							.map(({ content }) => content[0]?.text),
					).toEqual(["first"])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("enforces Idempotency-Key deduplication and payload conflict checks on session creates", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const realAdmit = yield* AdmitSessionDecision
					const realSessions = yield* Session
					const sessionViews = yield* SessionView

					const admittedSessionIds: Array<string> = []
					const sentUserMessages: Array<string> = []
					let lastUserMessageCommit:
						| { readonly stream: string; readonly version: number }
						| undefined
					let dropNextAdmitReceipt = false
					let dropNextUserMessageReceipt = false

					const wrappedAdmit: typeof realAdmit = {
						...realAdmit,
						send: (
							command: Parameters<typeof realAdmit.send>[0],
							options?: Parameters<typeof realAdmit.send>[1],
						) => {
							admittedSessionIds.push(command.session_id)
							const call = realAdmit.send(command, options)
							if (dropNextAdmitReceipt) {
								dropNextAdmitReceipt = false
								return call.pipe(Effect.andThen(Effect.die(new Error("receipt lost"))))
							}
							return call
						},
					}

					const wrappedSessions: typeof realSessions = {
						...realSessions,
						send: ((
							command: Parameters<typeof realSessions.send>[0],
							options?: Parameters<typeof realSessions.send>[1],
						) => {
							const call = realSessions.send(command, options).pipe(
								Effect.tap((receipt) =>
									Effect.sync(() => {
										if (command._tag === "SendUserMessage") {
											sentUserMessages.push(command.text)
											lastUserMessageCommit = receipt.commits[0]
										}
									}),
								),
							)
							if (command._tag === "SendUserMessage" && dropNextUserMessageReceipt) {
								dropNextUserMessageReceipt = false
								return call.pipe(Effect.andThen(Effect.die(new Error("message receipt lost"))))
							}
							return call
						}) as typeof realSessions.send,
					}

					const { fetch: apiFetch } = yield* makeApiHandler.pipe(
						Effect.provideService(AdmitSessionDecision, wrappedAdmit),
						Effect.provideService(Session, wrappedSessions),
					)

					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Session Agent", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Session Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const invalidRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: { ...AUTH_HEADERS, "idempotency-key": "sess-key-1" },
						body: { agent: agent.id, agent_id: "agent_other", environment_id: env.id },
					})
					expect(invalidRes.status).toBe(400)
					expect(admittedSessionIds).toHaveLength(0)

					const sessionPayload = {
						agent: agent.id,
						environment_id: env.id,
						title: "Idempotent Session",
					}
					dropNextAdmitReceipt = true
					const lostSessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: { ...AUTH_HEADERS, "idempotency-key": "sess-key-1" },
						body: sessionPayload,
					})
					expect(lostSessRes.status).toBe(500)

					const retrySessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: { ...AUTH_HEADERS, "idempotency-key": "sess-key-1" },
						body: sessionPayload,
					})
					expect(retrySessRes.status).toBe(201)
					const sess1 = (yield* Effect.promise(() => retrySessRes.json())) as {
						id: string
						agent: { id: string; version: number }
						created_at: string
					}
					expect(sess1.id).toMatch(/^sess_/)
					expect(sess1.agent).toMatchObject({ type: "agent", id: agent.id, version: 1 })

					const updateAgentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/agents/${agent.id}`,
						headers: AUTH_HEADERS,
						body: { version: 1, name: "Session Agent v2" },
					})
					expect(updateAgentRes.status).toBe(200)

					const repeatSessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: { ...AUTH_HEADERS, "idempotency-key": "sess-key-1" },
						body: sessionPayload,
					})
					expect(repeatSessRes.status).toBe(201)
					expect(yield* Effect.promise(() => repeatSessRes.json())).toEqual(sess1)
					expect(new Set(admittedSessionIds)).toEqual(new Set([sess1.id]))
					expect((yield* realSessions.get(SessionId.make(sess1.id)))._tag).toBe("Idle")

					const eventsWithSameKeyRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sess1.id}/events`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "sess-key-1" },
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
						},
					})
					expect(eventsWithSameKeyRes.status).toBe(200)
					for (let attempt = 0; attempt < 400; attempt++) {
						const res = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/sessions/${sess1.id}`,
							headers: AUTH_HEADERS,
						})
						const current = (yield* Effect.promise(() => res.json())) as {
							status: string
							turn: number
						}
						if (current.status === "idle" && current.turn === 1) {
							break
						}
						yield* Effect.sleep("5 millis")
					}
					const archiveSessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/sessions/${sess1.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(archiveSessRes.status).toBe(200)
					const archivedSess = (yield* Effect.promise(() => archiveSessRes.json())) as {
						status: string
						turn: number
						usage: { input_tokens: number; output_tokens: number }
						archived_at: string | null
					}
					expect(archivedSess.status).toBe("terminated")
					expect(archivedSess.turn).toBe(1)
					expect(archivedSess.usage).toEqual({ input_tokens: 1, output_tokens: 1 })
					expect(archivedSess.archived_at).not.toBeNull()

					const retryAfterArchiveRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: { ...AUTH_HEADERS, "idempotency-key": "sess-key-1" },
						body: sessionPayload,
					})
					expect(retryAfterArchiveRes.status).toBe(201)
					expect(yield* Effect.promise(() => retryAfterArchiveRes.json())).toEqual(sess1)
					expect(new Set(admittedSessionIds)).toEqual(new Set([sess1.id]))

					const sessionBeforeConflict = yield* realSessions.get(SessionId.make(sess1.id))
					const conflictSessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: { ...AUTH_HEADERS, "idempotency-key": "sess-key-1" },
						body: { ...sessionPayload, title: "Different Title" },
					})
					expect(conflictSessRes.status).toBe(409)
					expect(yield* Effect.promise(() => conflictSessRes.json())).toMatchObject({
						type: "error",
						error: { type: "conflict_error" },
					})
					expect(new Set(admittedSessionIds)).toEqual(new Set([sess1.id]))
					expect(yield* realSessions.get(SessionId.make(sess1.id))).toEqual(sessionBeforeConflict)

					const unkeyed1Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: sessionPayload,
					})
					const unkeyed2Res = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: sessionPayload,
					})
					expect(unkeyed1Res.status).toBe(201)
					expect(unkeyed2Res.status).toBe(201)
					const unkeyed1 = (yield* Effect.promise(() => unkeyed1Res.json())) as { id: string }
					const unkeyed2 = (yield* Effect.promise(() => unkeyed2Res.json())) as { id: string }
					expect(unkeyed1.id).not.toBe(unkeyed2.id)
					expect(unkeyed1.id).not.toBe(sess1.id)

					const generatedClient = yield* makeApiTestClient(apiFetch)
					const clientUnkeyedSess = yield* generatedClient.sessions.create({
						headers: {},
						payload: { agent: agent.id, environment_id: env.id, title: "Client Unkeyed Session" },
					})
					expect("pending" in clientUnkeyedSess).toBe(false)
					expect(clientUnkeyedSess.id).toMatch(/^sess_/)

					const sessCountBeforeClientKey = new Set(admittedSessionIds).size
					dropNextAdmitReceipt = true
					const lostClientSess = yield* generatedClient.sessions
						.create({
							headers: { "idempotency-key": "client-sess-key-1" },
							payload: { agent: agent.id, environment_id: env.id, title: "Client Keyed Session" },
						})
						.pipe(Effect.flip)
					expect(lostClientSess).toMatchObject({
						type: "error",
						error: { type: "internal_error" },
					})
					const clientKeyedSess1 = yield* generatedClient.sessions.create({
						headers: { "idempotency-key": "client-sess-key-1" },
						payload: { agent: agent.id, environment_id: env.id, title: "Client Keyed Session" },
					})
					const clientKeyedSess2 = yield* generatedClient.sessions.create({
						headers: { "idempotency-key": "client-sess-key-1" },
						payload: { agent: agent.id, environment_id: env.id, title: "Client Keyed Session" },
					})
					expect(clientKeyedSess2).toEqual(clientKeyedSess1)
					expect(new Set(admittedSessionIds).size).toBe(sessCountBeforeClientKey + 1)
					const clientKeyedSessConflict = yield* generatedClient.sessions
						.create({
							headers: { "idempotency-key": "client-sess-key-1" },
							payload: {
								agent: agent.id,
								environment_id: env.id,
								title: "Different Client Keyed Session",
							},
						})
						.pipe(Effect.flip)
					expect(clientKeyedSessConflict).toMatchObject({
						type: "error",
						error: { type: "conflict_error" },
					})

					const eventsSessionId = SessionId.make(clientKeyedSess1.id)
					dropNextUserMessageReceipt = true
					const lostKeyedBatch = yield* generatedClient.sessions
						.sendEvents({
							params: { session_id: eventsSessionId },
							headers: { "idempotency-key": "client-events-key-1" },
							payload: {
								events: [
									{ type: "user.message", content: [{ type: "text", text: "keyed batch" }] },
								],
							},
						})
						.pipe(Effect.flip)
					expect(lostKeyedBatch).toMatchObject({
						type: "error",
						error: { type: "internal_error" },
					})
					const retriedKeyedBatch = yield* generatedClient.sessions.sendEvents({
						params: { session_id: eventsSessionId },
						headers: { "idempotency-key": "client-events-key-1" },
						payload: {
							events: [{ type: "user.message", content: [{ type: "text", text: "keyed batch" }] }],
						},
					})
					expect(retriedKeyedBatch.data).toHaveLength(1)
					const keyedBatchConflict = yield* generatedClient.sessions
						.sendEvents({
							params: { session_id: eventsSessionId },
							headers: { "idempotency-key": "client-events-key-1" },
							payload: {
								events: [
									{ type: "user.message", content: [{ type: "text", text: "different batch" }] },
								],
							},
						})
						.pipe(Effect.flip)
					expect(keyedBatchConflict).toMatchObject({
						type: "error",
						error: { type: "conflict_error" },
					})

					const explicitBatch = yield* generatedClient.sessions.sendEvents({
						params: { session_id: eventsSessionId },
						headers: { "idempotency-key": "client-events-explicit-key-1" },
						payload: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "explicit batch" }] },
							],
						},
					})
					expect(explicitBatch.data).toHaveLength(1)
					const explicitRetry = yield* generatedClient.sessions.sendEvents({
						params: { session_id: eventsSessionId },
						headers: { "idempotency-key": "client-events-explicit-key-1" },
						payload: {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "explicit batch" }] },
							],
						},
					})
					expect(explicitRetry).toEqual(explicitBatch)

					if (lastUserMessageCommit !== undefined) {
						yield* sessionViews.get(Session.ref(eventsSessionId), {
							atLeast: lastUserMessageCommit,
						})
					}
					const listedEvents = yield* generatedClient.sessions.listEvents({
						params: { session_id: eventsSessionId },
						query: {},
					})
					const userMessages = listedEvents.data.filter((event) => event.type === "user.message")
					expect(userMessages.map((event) => event.content[0]?.text)).toEqual([
						"keyed batch",
						"explicit batch",
					])
					expect(sentUserMessages).toContain("keyed batch")
					expect(sentUserMessages).toContain("explicit batch")
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})
})
