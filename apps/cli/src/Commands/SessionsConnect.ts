import { SessionId } from "@checkfu/sessions/Session/Session.id"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as Terminal from "effect/Terminal"
import type { CheckfuClient, SessionStreamEvent } from "../Client.ts"
import { type CliFailure, formatClientError, networkFailure, usageError } from "../Errors.ts"
import { decodePayload } from "../Input.ts"
import { RootCommand, getClient, renderOutput } from "../RootCommand.ts"
import { withSigintHandler } from "../Signals.ts"
import {
	escapeTerminalControlCharacters,
	writeStderrLine,
	writeStdoutLine,
} from "../TerminalOutput.ts"

const extractContentText = (data: Record<string, unknown>): string => {
	const content = data["content"]
	if (!Array.isArray(content)) return ""
	const parts: Array<string> = []
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as Record<string, unknown>)["type"] === "text" &&
			typeof (block as Record<string, unknown>)["text"] === "string"
		) {
			parts.push((block as Record<string, unknown>)["text"] as string)
		}
	}
	return parts.join("\n")
}

interface ConnectState {
	readonly status: "idle" | "running" | "terminated"
	readonly observedTurn: number
	readonly settledTurn: number
	readonly targetTurn: number
	readonly submittedTurns: ReadonlySet<number>
	readonly turnErrors: ReadonlyMap<number, string>
	readonly failedTurnErrors: ReadonlyMap<number, string>
	readonly ended: boolean
	readonly localSentTexts: ReadonlyArray<string>
}

const renderConnectEvent = (
	event: SessionStreamEvent,
	stateRef: Ref.Ref<ConnectState>,
	settleDeferred: Deferred.Deferred<void>,
	stopConnectDeferred: Deferred.Deferred<void>,
	expectArchivedEvent: boolean,
	rawStructuredMode: boolean,
): Effect.Effect<void, CliFailure, Command.CommandContext<"checkfu"> | Stdio.Stdio> =>
	Effect.gen(function* () {
		const data = event.data
		const eventType = typeof data["type"] === "string" ? data["type"] : event.event

		if (rawStructuredMode) {
			yield* renderOutput(data, { streaming: true })
		}

		switch (eventType) {
			case "user.message": {
				const text = extractContentText(data)
				const wasLocal = yield* Ref.modify(stateRef, (state) => {
					const idx = state.localSentTexts.indexOf(text)
					if (idx === -1) return [false, state] as const
					const next = [
						...state.localSentTexts.slice(0, idx),
						...state.localSentTexts.slice(idx + 1),
					]
					return [true, { ...state, localSentTexts: next }] as const
				})
				if (!rawStructuredMode && !wasLocal && text.length > 0) {
					yield* writeStdoutLine(`[you] ${escapeTerminalControlCharacters(text)}`)
				}
				break
			}
			case "session.status_running": {
				yield* Ref.update(stateRef, (state) => ({
					...state,
					status: "running" as const,
					observedTurn: state.observedTurn + 1,
				}))
				break
			}
			case "agent.thinking": {
				const thinking = typeof data["thinking"] === "string" ? data["thinking"] : ""
				if (!rawStructuredMode && thinking.length > 0) {
					yield* writeStderrLine(`[thinking] ${thinking}`)
				}
				break
			}
			case "agent.message": {
				const text = extractContentText(data)
				if (!rawStructuredMode && text.length > 0) {
					yield* writeStdoutLine(escapeTerminalControlCharacters(text))
				}
				break
			}
			case "user.interrupt": {
				if (!rawStructuredMode) {
					yield* writeStderrLine("[interrupt]")
				}
				break
			}
			case "session.error": {
				const errObj =
					typeof data["error"] === "object" && data["error"] !== null
						? (data["error"] as Record<string, unknown>)
						: undefined
				const errType = typeof errObj?.["type"] === "string" ? errObj["type"] : "session_error"
				const errMsg = typeof errObj?.["message"] === "string" ? errObj["message"] : "Unknown error"
				const formattedError = `${errType}: ${errMsg}`
				yield* Ref.update(stateRef, (state) => {
					const nextErrors = new Map(state.turnErrors)
					nextErrors.set(state.observedTurn, formattedError)
					return { ...state, turnErrors: nextErrors }
				})
				if (!rawStructuredMode) {
					yield* writeStderrLine(`[error] ${formattedError}`)
				}
				break
			}
			case "session.status_idle": {
				const stopReason =
					typeof data["stop_reason"] === "object" && data["stop_reason"] !== null
						? (data["stop_reason"] as Record<string, unknown>)["type"]
						: undefined
				const next = yield* Ref.updateAndGet(stateRef, (state) => {
					const turn = state.observedTurn
					let failedTurnErrors = state.failedTurnErrors
					if (stopReason === "retries_exhausted") {
						const nextFailed = new Map(state.failedTurnErrors)
						nextFailed.set(turn, state.turnErrors.get(turn) ?? "Model retries exhausted.")
						failedTurnErrors = nextFailed
					}
					return {
						...state,
						status: "idle" as const,
						settledTurn: Math.max(state.settledTurn, turn),
						failedTurnErrors,
					}
				})
				if (!rawStructuredMode && typeof stopReason === "string" && stopReason !== "end_turn") {
					yield* writeStderrLine(`[status: idle (${stopReason})]`)
				}
				if (next.targetTurn > 0 && next.settledTurn >= next.targetTurn) {
					yield* Deferred.succeed(settleDeferred, undefined)
				}
				break
			}
			case "session.status_terminated":
			case "session.archived": {
				yield* Ref.update(stateRef, (state) => {
					let failedTurnErrors = state.failedTurnErrors
					if (eventType === "session.status_terminated") {
						const turnError = state.turnErrors.get(state.observedTurn)
						if (turnError !== undefined) {
							const nextFailed = new Map(state.failedTurnErrors)
							nextFailed.set(state.observedTurn, turnError)
							failedTurnErrors = nextFailed
						}
					}
					return {
						...state,
						status: "terminated" as const,
						ended: true,
						failedTurnErrors,
					}
				})
				if (!rawStructuredMode) {
					yield* writeStderrLine(
						eventType === "session.archived" ? "[session archived]" : "[session terminated]",
					)
				}
				yield* Deferred.succeed(settleDeferred, undefined)
				if (eventType === "session.archived" || !expectArchivedEvent) {
					yield* Deferred.succeed(stopConnectDeferred, undefined)
				}
				break
			}
			default:
				break
		}
	})

const dispatchUserLine = (
	client: CheckfuClient,
	sessionId: SessionId,
	line: string,
	stateRef: Ref.Ref<ConnectState>,
): Effect.Effect<"continue" | "exit", CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const trimmed = line.trim()
		if (trimmed.length === 0) return "continue" as const
		if (trimmed === "/exit" || trimmed === "/quit") return "exit" as const

		if (trimmed === "/interrupt") {
			const key = yield* client.generateIdempotencyKey()
			const res = yield* Effect.result(
				client.api.sessions.sendEvents({
					params: { session_id: sessionId },
					headers: { "idempotency-key": key },
					payload: { events: [{ type: "user.interrupt" }] },
				}),
			)
			if (res._tag === "Failure") {
				yield* writeStderrLine(`Interrupt failed: ${formatClientError(res.failure).message}`)
			} else {
				yield* writeStderrLine("Interrupt requested.")
			}
			return "continue" as const
		}

		const key = yield* client.generateIdempotencyKey()
		yield* Ref.update(stateRef, (state) => ({
			...state,
			localSentTexts: [...state.localSentTexts, trimmed],
		}))
		const res = yield* Effect.result(
			client.api.sessions.sendEvents({
				params: { session_id: sessionId },
				headers: { "idempotency-key": key },
				payload: {
					events: [{ type: "user.message", content: [{ type: "text", text: trimmed }] }],
				},
			}),
		)
		if (res._tag === "Failure") {
			yield* Ref.update(stateRef, (state) => {
				const idx = state.localSentTexts.indexOf(trimmed)
				if (idx === -1) return state
				return {
					...state,
					localSentTexts: [
						...state.localSentTexts.slice(0, idx),
						...state.localSentTexts.slice(idx + 1),
					],
				}
			})
			return yield* formatClientError(res.failure)
		}
		const first = res.success.data[0]
		const turn =
			typeof first === "object" &&
			first !== null &&
			typeof (first as Record<string, unknown>)["turn"] === "number"
				? ((first as Record<string, unknown>)["turn"] as number)
				: undefined
		if (turn !== undefined) {
			yield* Ref.update(stateRef, (state) => {
				const nextSubmitted = new Set(state.submittedTurns)
				nextSubmitted.add(turn)
				return {
					...state,
					targetTurn: Math.max(state.targetTurn, turn),
					submittedTurns: nextSubmitted,
				}
			})
		}
		return "continue" as const
	})

const resolveCursorBaseline = (
	client: CheckfuClient,
	sessionId: SessionId,
	after: number | undefined,
): Effect.Effect<
	{
		readonly status: ConnectState["status"]
		readonly observedTurn: number
		readonly settledTurn: number
	},
	CliFailure
> => {
	if (after === undefined || after === 0) {
		return Effect.succeed({
			status: "idle" as const,
			observedTurn: 0,
			settledTurn: 0,
		})
	}
	return Effect.gen(function* () {
		let pageCursor = 0
		let lastSeenSeq = 0
		let observedTurn = 0
		let settledTurn = 0
		let status: ConnectState["status"] = "idle"
		while (true) {
			const page = yield* client.api.sessions
				.listEvents({
					params: { session_id: sessionId },
					query: {
						...(pageCursor > 0 ? { after: String(pageCursor) } : {}),
						limit: "100",
						order: "asc",
					},
				})
				.pipe(Effect.mapError(formatClientError))
			let reachedCursor = false
			for (const entry of page.data) {
				const seq = typeof entry["seq"] === "number" ? entry["seq"] : undefined
				if (seq !== undefined) {
					lastSeenSeq = Math.max(lastSeenSeq, seq)
				}
				if (seq !== undefined && seq > after) {
					reachedCursor = true
					break
				}
				const eventType = typeof entry["type"] === "string" ? entry["type"] : undefined
				if (eventType === "session.status_running") {
					observedTurn += 1
					status = "running"
				} else if (eventType === "session.status_idle") {
					settledTurn = Math.max(settledTurn, observedTurn)
					status = "idle"
				} else if (eventType === "session.status_terminated" || eventType === "session.archived") {
					status = "terminated"
				}
			}
			if (
				reachedCursor ||
				!page.has_more ||
				page.next_cursor === null ||
				page.next_cursor >= after
			) {
				break
			}
			pageCursor = page.next_cursor
		}
		if (after > lastSeenSeq) {
			return yield* usageError(
				`--after cursor ${after} is beyond the latest session event sequence (${lastSeenSeq}).`,
			)
		}
		return { status, observedTurn, settledTurn }
	})
}

export const sessionsConnectCommand = Command.make(
	"connect",
	{
		sessionIdFlag: Flag.String("session-id").pipe(
			Flag.withMetavar("ID"),
			Flag.withDescription("Session ID to connect to"),
			Flag.optional,
		),
		after: Flag.Int("after").pipe(
			Flag.withMetavar("SEQ"),
			Flag.withDescription("Replay events after this sequence number"),
			Flag.optional,
		),
		sessionIdArg: Argument.String("session-id").pipe(
			Argument.withDescription("Session ID to connect to (alternative to --session-id)"),
			Argument.optional,
		),
	},
	(input) =>
		Effect.gen(function* () {
			let rawSessionId: string
			if (Option.isSome(input.sessionIdFlag) && Option.isSome(input.sessionIdArg)) {
				if (input.sessionIdFlag.value !== input.sessionIdArg.value) {
					return yield* usageError(
						"Conflicting session IDs supplied via --session-id and positional argument.",
					)
				}
				rawSessionId = input.sessionIdFlag.value
			} else if (Option.isSome(input.sessionIdFlag)) {
				rawSessionId = input.sessionIdFlag.value
			} else if (Option.isSome(input.sessionIdArg)) {
				rawSessionId = input.sessionIdArg.value
			} else {
				return yield* usageError("Missing required --session-id (or positional <session-id>).")
			}

			if (Option.isSome(input.after) && input.after.value < 0) {
				return yield* usageError("--after must be a non-negative integer.")
			}

			const sessionId = yield* decodePayload(SessionId, rawSessionId, "--session-id")
			const root = yield* RootCommand
			const stdio = yield* Stdio.Stdio
			const terminal = yield* Terminal.Terminal
			const client = yield* getClient()

			const session = yield* client.api.sessions
				.get({ params: { session_id: sessionId } })
				.pipe(Effect.mapError(formatClientError))

			const rawStructuredMode =
				root.format !== "auto" || Option.isSome(root.transform) || root.rawOutput

			const after = Option.getOrUndefined(input.after)
			const baseline = yield* resolveCursorBaseline(client, sessionId, after)

			yield* writeStderrLine(
				`Connected to ${session.id} (agent ${session.agent.id}@v${session.agent.version}, status: ${session.status}). Type a message, /interrupt, or /exit.`,
			)

			const stateRef = yield* Ref.make<ConnectState>({
				status: baseline.status,
				observedTurn: baseline.observedTurn,
				settledTurn: baseline.settledTurn,
				targetTurn: 0,
				submittedTurns: new Set<number>(),
				turnErrors: new Map<number, string>(),
				failedTurnErrors: new Map<number, string>(),
				ended: session.status === "terminated" || session.archived_at !== null,
				localSentTexts: [],
			})

			const settleDeferredRef = yield* Ref.make(yield* Deferred.make<void>())
			const streamFailedRef = yield* Ref.make<CliFailure | null>(null)
			const incompleteTurnRef = yield* Ref.make<CliFailure | null>(null)
			const failedTurnRef = yield* Ref.make<CliFailure | null>(null)
			const streamEndedDeferred = yield* Deferred.make<void>()
			const stopConnectDeferred = yield* Deferred.make<void>()
			const expectArchivedEvent = session.archived_at !== null

			const streamFiber = yield* client
				.streamSessionEvents(sessionId, after === undefined ? undefined : { after })
				.pipe(
					Stream.runForEach((event) =>
						Effect.gen(function* () {
							const settleDeferred = yield* Ref.get(settleDeferredRef)
							yield* renderConnectEvent(
								event,
								stateRef,
								settleDeferred,
								stopConnectDeferred,
								expectArchivedEvent,
								rawStructuredMode,
							)
						}),
					),
					Effect.catch((err) =>
						Effect.gen(function* () {
							yield* Ref.set(streamFailedRef, err)
							const settleDeferred = yield* Ref.get(settleDeferredRef)
							yield* Deferred.succeed(settleDeferred, undefined)
						}),
					),
					Effect.ensuring(
						Effect.all([
							Deferred.succeed(streamEndedDeferred, undefined),
							Deferred.succeed(stopConnectDeferred, undefined),
						]),
					),
					Effect.forkChild,
				)

			const runInputLoop = Effect.gen(function* () {
				const initialState = yield* Ref.get(stateRef)
				if (initialState.ended) {
					if (session.archived_at !== null) {
						yield* Deferred.await(streamEndedDeferred)
					} else if (baseline.status !== "terminated") {
						yield* Deferred.await(stopConnectDeferred)
					}
					return
				}

				const isInteractiveTty = yield* stdio.stdinIsTerminal
				if (isInteractiveTty) {
					let interruptRequestedOnce = false
					let cachedStatus: ConnectState["status"] = session.status
					const interruptQueue = yield* Queue.unbounded<void>()

					const interruptWorker = yield* Effect.forever(
						Queue.take(interruptQueue).pipe(
							Effect.andThen(dispatchUserLine(client, sessionId, "/interrupt", stateRef)),
							Effect.andThen(writeStderrLine("Press Ctrl-C again to disconnect.")),
						),
					).pipe(Effect.forkChild)

					const ttyLoop = Effect.gen(function* () {
						while (true) {
							const state = yield* Ref.get(stateRef)
							cachedStatus = state.status
							if (state.ended) break
							const nextEvent = yield* Effect.race(
								Effect.result(terminal.readLine).pipe(
									Effect.map((outcome) => ({ _tag: "line" as const, outcome })),
								),
								Deferred.await(stopConnectDeferred).pipe(Effect.as({ _tag: "ended" as const })),
							)
							if (nextEvent._tag === "ended") break
							if (nextEvent.outcome._tag === "Failure") {
								break
							}
							interruptRequestedOnce = false
							const action = yield* dispatchUserLine(
								client,
								sessionId,
								nextEvent.outcome.success,
								stateRef,
							)
							if (action === "exit") break
						}
					})

					yield* withSigintHandler(() => {
						const current = Ref.getUnsafe(stateRef)
						cachedStatus = current.status
						if (cachedStatus === "running" && !interruptRequestedOnce) {
							interruptRequestedOnce = true
							Queue.offerUnsafe(interruptQueue, undefined)
							return true
						}
						return false
					}, ttyLoop).pipe(Effect.ensuring(Fiber.interrupt(interruptWorker)))
					return
				}

				let explicitExit = false
				yield* stdio.stdin.pipe(
					Stream.mapError((err) => usageError(`Failed to read stdin: ${err.message}`)),
					Stream.decodeText(),
					Stream.splitLines,
					Stream.takeUntil((line) => {
						const trimmed = line.trim()
						return trimmed === "/exit" || trimmed === "/quit"
					}),
					Stream.interruptWhen(Deferred.await(stopConnectDeferred)),
					Stream.runForEach((line) =>
						Effect.gen(function* () {
							if (explicitExit) return
							const state = yield* Ref.get(stateRef)
							if (state.ended) {
								explicitExit = true
								return
							}
							const nextDeferred = yield* Deferred.make<void>()
							yield* Ref.set(settleDeferredRef, nextDeferred)
							const action = yield* dispatchUserLine(client, sessionId, line, stateRef)
							if (action === "exit") {
								explicitExit = true
							}
						}),
					),
				)

				if (!explicitExit) {
					while (true) {
						const failed = yield* Ref.get(streamFailedRef)
						if (failed !== null) break
						const state = yield* Ref.get(stateRef)
						if (state.ended) {
							break
						}
						if (state.targetTurn > 0 && state.settledTurn >= state.targetTurn) {
							break
						}
						if (yield* Deferred.isDone(streamEndedDeferred)) {
							if (state.targetTurn > 0) {
								yield* Ref.set(
									incompleteTurnRef,
									networkFailure(`Event stream ended before turn ${state.targetTurn} completed.`),
								)
							} else {
								yield* Ref.set(
									incompleteTurnRef,
									networkFailure("Event stream ended unexpectedly."),
								)
							}
							break
						}
						if (state.targetTurn === 0) {
							break
						}
						const waiter = yield* Ref.get(settleDeferredRef)
						const outcome = yield* Effect.race(
							Deferred.await(waiter).pipe(Effect.as("settled" as const)),
							Deferred.await(stopConnectDeferred).pipe(Effect.as("stopped" as const)),
						)
						if (outcome === "stopped") {
							const afterStream = yield* Ref.get(stateRef)
							const failedAfter = yield* Ref.get(streamFailedRef)
							if (
								failedAfter === null &&
								!afterStream.ended &&
								afterStream.targetTurn > 0 &&
								afterStream.settledTurn < afterStream.targetTurn
							) {
								yield* Ref.set(
									incompleteTurnRef,
									networkFailure(
										`Event stream ended before turn ${afterStream.targetTurn} completed.`,
									),
								)
							}
							break
						}
						const fresh = yield* Deferred.make<void>()
						yield* Ref.set(settleDeferredRef, fresh)
					}

					const finalState = yield* Ref.get(stateRef)
					const submitted = [...finalState.submittedTurns].sort((a, b) => a - b)
					for (const turn of submitted) {
						const turnFailure = finalState.failedTurnErrors.get(turn)
						if (turnFailure !== undefined) {
							yield* Ref.set(failedTurnRef, networkFailure(`Turn ${turn} failed: ${turnFailure}`))
							break
						}
					}
				}
			})

			yield* runInputLoop.pipe(Effect.ensuring(Fiber.interrupt(streamFiber)))

			const streamError = yield* Ref.get(streamFailedRef)
			if (streamError !== null) {
				return yield* streamError
			}
			const incompleteError = yield* Ref.get(incompleteTurnRef)
			if (incompleteError !== null) {
				return yield* incompleteError
			}
			const failedTurnError = yield* Ref.get(failedTurnRef)
			if (failedTurnError !== null) {
				return yield* failedTurnError
			}
		}),
).pipe(
	Command.withDescription("Connect interactively to a session to stream events and send messages"),
	Command.withExamples([
		{
			command: "checkfu sessions connect --session-id sess_123",
			description: "Connect to a session interactively",
		},
		{
			command: 'echo "Hello Checkfu!" | checkfu sessions connect --session-id sess_123',
			description: "Send a message non-interactively and print the reply",
		},
	]),
)
