import { statusOf } from "@checkfu/api/Http/Api"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HttpClientError from "effect/http/HttpClientError"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as Terminal from "effect/Terminal"
import type { CheckfuClient, SessionStreamEvent } from "../Client.ts"
import {
	CliFailure,
	formatClientError,
	isApiErrorEnvelope,
	isTransientHttpError,
	networkFailure,
	usageError,
} from "../Errors.ts"
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

interface LocalSentMessage {
	readonly id: string
	readonly text: string
	readonly minSeq: number
}

interface ConnectState {
	readonly status: "idle" | "running" | "terminated"
	readonly liveStatus: "idle" | "running" | "terminated"
	readonly liveTurn: number
	readonly connectHeadSeq: number
	readonly lastObservedSeq: number
	readonly observedTurn: number
	readonly settledTurn: number
	readonly latestSettledStopReason: string | undefined
	readonly targetTurn: number
	readonly submittedTurns: ReadonlySet<number>
	readonly latestTurnError: { readonly turn: number; readonly message: string } | undefined
	readonly failedTurnErrors: ReadonlyMap<number, string>
	readonly ended: boolean
	readonly localSentMessages: ReadonlyArray<LocalSentMessage>
}

const MAX_SESSION_STATUS_LOOKUP_RETRIES = 2
const SESSION_STATUS_LOOKUP_RETRY_BASE_MS = 100
const MAX_CONNECT_SEND_RETRIES = 2
const CONNECT_SEND_RETRY_BASE_MS = 100

const isAmbiguousResponseStatus = (status: number): boolean =>
	status < 400 || status === 408 || status === 429 || status >= 500

const isRetryableLookupError = (err: Parameters<typeof formatClientError>[0]): boolean => {
	if (HttpClientError.isHttpClientError(err)) {
		if (isTransientHttpError(err)) return true
		const reason = err.reason
		if (reason._tag === "DecodeError" || reason._tag === "EmptyBodyError") {
			return isAmbiguousResponseStatus(reason.response.status)
		}
		return false
	}
	if (isApiErrorEnvelope(err)) {
		const status = statusOf(err)
		return status === 429 || status >= 500
	}
	return false
}

const isUnconfirmedSendError = (err: Parameters<typeof formatClientError>[0]): boolean => {
	if (HttpClientError.isHttpClientError(err)) {
		if (isTransientHttpError(err)) return true
		const reason = err.reason
		if (reason._tag === "DecodeError" || reason._tag === "EmptyBodyError") {
			return isAmbiguousResponseStatus(reason.response.status)
		}
		return false
	}
	if (isApiErrorEnvelope(err)) {
		const status = statusOf(err)
		return err.unconfirmed_index !== undefined || status === 429 || status >= 500
	}
	return Schema.isSchemaError(err)
}

const formatUnconfirmedSendError = (
	err: Parameters<typeof formatClientError>[0],
	idempotencyKey: string,
): CliFailure => {
	const formatted = formatClientError(err)
	if (!isUnconfirmedSendError(err)) return formatted
	return new CliFailure({
		message: `${formatted.message} (delivery unconfirmed; retry safely with Idempotency-Key: ${idempotencyKey})`,
		exitCode: formatted.exitCode,
	})
}

const sendConnectEventsWithRetry = <A>(
	send: Effect.Effect<A, Parameters<typeof formatClientError>[0]>,
	idempotencyKey: string,
): Effect.Effect<A, CliFailure> =>
	Effect.gen(function* () {
		for (let attempt = 0; ; attempt++) {
			const res = yield* Effect.result(send)
			if (res._tag === "Success") {
				return res.success
			}
			const err = res.failure
			if (isUnconfirmedSendError(err) && attempt < MAX_CONNECT_SEND_RETRIES) {
				yield* Effect.sleep(Duration.millis(CONNECT_SEND_RETRY_BASE_MS * 2 ** attempt))
				continue
			}
			return yield* formatUnconfirmedSendError(err, idempotencyKey)
		}
	})

const fetchSessionStatusWithRetry = (client: CheckfuClient, sessionId: SessionId) =>
	Effect.gen(function* () {
		for (let attempt = 0; ; attempt++) {
			const res = yield* Effect.result(
				client.api.sessions.get({ params: { session_id: sessionId } }),
			)
			if (res._tag === "Success") {
				return res.success
			}
			const err = res.failure
			if (isRetryableLookupError(err) && attempt < MAX_SESSION_STATUS_LOOKUP_RETRIES) {
				yield* Effect.sleep(Duration.millis(SESSION_STATUS_LOOKUP_RETRY_BASE_MS * 2 ** attempt))
				continue
			}
			return yield* formatClientError(err)
		}
	})

const findFirstSendablePipedLine = (
	stdio: Stdio.Stdio,
): Effect.Effect<Option.Option<string>, CliFailure> =>
	Effect.gen(function* () {
		let firstSendable: Option.Option<string> = Option.none()
		yield* stdio.stdin.pipe(
			Stream.mapError((err) => usageError(`Failed to read stdin: ${err.message}`)),
			Stream.decodeText(),
			Stream.splitLines,
			Stream.takeUntil((line) => {
				const trimmed = line.trim()
				return trimmed.length > 0
			}),
			Stream.runForEach((line) =>
				Effect.sync(() => {
					const trimmed = line.trim()
					if (trimmed.length > 0 && trimmed !== "/exit" && trimmed !== "/quit") {
						firstSendable = Option.some(trimmed)
					}
				}),
			),
		)
		return firstSendable
	})

const isQueueHaltingStopReason = (stopReason: string | undefined): boolean =>
	stopReason !== undefined &&
	stopReason !== "end_turn" &&
	stopReason !== "interrupted" &&
	stopReason !== "retries_exhausted"

const renderConnectEvent = (
	client: CheckfuClient,
	sessionId: SessionId,
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
		const eventSeq = event.seq

		if (eventSeq !== undefined) {
			yield* Ref.update(stateRef, (state) =>
				eventSeq > state.lastObservedSeq ? { ...state, lastObservedSeq: eventSeq } : state,
			)
		}

		if (rawStructuredMode) {
			yield* renderOutput(data, { streaming: true })
		}

		switch (eventType) {
			case "user.message": {
				const text = extractContentText(data)
				const wasLocal = yield* Ref.modify(stateRef, (state) => {
					const idx = state.localSentMessages.findIndex(
						(entry) => entry.text === text && (eventSeq === undefined || eventSeq > entry.minSeq),
					)
					if (idx === -1) return [false, state] as const
					const next = [
						...state.localSentMessages.slice(0, idx),
						...state.localSentMessages.slice(idx + 1),
					]
					return [true, { ...state, localSentMessages: next }] as const
				})
				if (!rawStructuredMode && !wasLocal && text.length > 0) {
					yield* writeStdoutLine(`[you] ${escapeTerminalControlCharacters(text)}`)
				}
				break
			}
			case "session.status_running": {
				yield* Ref.update(stateRef, (state) => {
					const nextObserved = state.observedTurn + 1
					const reachedLive = nextObserved > state.liveTurn
					return {
						...state,
						status: "running" as const,
						observedTurn: nextObserved,
						liveStatus: reachedLive ? ("running" as const) : state.liveStatus,
						liveTurn: reachedLive ? nextObserved : state.liveTurn,
					}
				})
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
				yield* Ref.update(stateRef, (state) => ({
					...state,
					latestTurnError: { turn: state.observedTurn, message: formattedError },
				}))
				if (!rawStructuredMode) {
					yield* writeStderrLine(`[error] ${formattedError}`)
				}
				break
			}
			case "session.status_idle": {
				const rawStopReason =
					typeof data["stop_reason"] === "object" && data["stop_reason"] !== null
						? (data["stop_reason"] as Record<string, unknown>)["type"]
						: undefined
				const stopReason = typeof rawStopReason === "string" ? rawStopReason : undefined
				const next = yield* Ref.updateAndGet(stateRef, (state) => {
					const turn = state.observedTurn
					const latestSettledStopReason =
						turn >= state.settledTurn ? stopReason : state.latestSettledStopReason
					let failedTurnErrors = state.failedTurnErrors
					if (stopReason === "retries_exhausted") {
						const turnError =
							state.latestTurnError?.turn === turn ? state.latestTurnError.message : undefined
						const nextFailed = new Map(state.failedTurnErrors)
						nextFailed.set(turn, turnError ?? "Model retries exhausted.")
						failedTurnErrors = nextFailed
					}
					return {
						...state,
						status: "idle" as const,
						liveStatus: turn >= state.liveTurn ? ("idle" as const) : state.liveStatus,
						settledTurn: Math.max(state.settledTurn, turn),
						latestSettledStopReason,
						failedTurnErrors,
					}
				})
				if (!rawStructuredMode && stopReason !== undefined && stopReason !== "end_turn") {
					yield* writeStderrLine(`[status: idle (${stopReason})]`)
				}
				if (
					(next.targetTurn > 0 && next.settledTurn >= next.targetTurn) ||
					(next.targetTurn > next.settledTurn && isQueueHaltingStopReason(stopReason))
				) {
					yield* Deferred.succeed(settleDeferred, undefined)
				}
				break
			}
			case "session.status_terminated":
			case "session.archived": {
				yield* Ref.update(stateRef, (state) => {
					let failedTurnErrors = state.failedTurnErrors
					if (
						eventType === "session.status_terminated" &&
						state.latestTurnError?.turn === state.observedTurn
					) {
						const nextFailed = new Map(state.failedTurnErrors)
						nextFailed.set(state.observedTurn, state.latestTurnError.message)
						failedTurnErrors = nextFailed
					}
					return {
						...state,
						status: "terminated" as const,
						liveStatus: "terminated" as const,
						failedTurnErrors,
					}
				})
				if (!rawStructuredMode) {
					yield* writeStderrLine(
						eventType === "session.archived" ? "[session archived]" : "[session terminated]",
					)
				}

				let isLiveArchive = false
				if (eventType === "session.status_terminated") {
					if (expectArchivedEvent) {
						isLiveArchive = true
					} else {
						const latest = yield* fetchSessionStatusWithRetry(client, sessionId)
						isLiveArchive = latest.archived_at !== null
					}
				}
				const shouldStopNow = eventType === "session.archived" || !isLiveArchive

				if (shouldStopNow) {
					yield* Ref.update(stateRef, (state) => ({ ...state, ended: true }))
					yield* Deferred.succeed(settleDeferred, undefined)
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
	options?: { readonly failOnInterruptError?: boolean },
): Effect.Effect<"continue" | "exit", CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const trimmed = line.trim()
		if (trimmed.length === 0) return "continue" as const
		if (trimmed === "/exit" || trimmed === "/quit") return "exit" as const

		if (trimmed === "/interrupt") {
			const key = yield* client.generateIdempotencyKey()
			const res = yield* Effect.result(
				sendConnectEventsWithRetry(
					client.api.sessions.sendEvents({
						params: { session_id: sessionId },
						headers: { "idempotency-key": key },
						payload: { events: [{ type: "user.interrupt" }] },
					}),
					key,
				),
			)
			if (res._tag === "Failure") {
				if (options?.failOnInterruptError === true) {
					return yield* res.failure
				}
				yield* writeStderrLine(`Interrupt failed: ${res.failure.message}`)
			} else {
				yield* writeStderrLine("Interrupt requested.")
			}
			return "continue" as const
		}

		const key = yield* client.generateIdempotencyKey()
		yield* Ref.update(stateRef, (state) => ({
			...state,
			localSentMessages: [
				...state.localSentMessages,
				{
					id: key,
					text: line,
					minSeq: Math.max(state.connectHeadSeq, state.lastObservedSeq),
				},
			],
		}))
		const res = yield* Effect.result(
			sendConnectEventsWithRetry(
				client.api.sessions.sendEvents({
					params: { session_id: sessionId },
					headers: { "idempotency-key": key },
					payload: {
						events: [{ type: "user.message", content: [{ type: "text", text: line }] }],
					},
				}),
				key,
			),
		)
		if (res._tag === "Failure") {
			yield* Ref.update(stateRef, (state) => ({
				...state,
				localSentMessages: state.localSentMessages.filter((entry) => entry.id !== key),
			}))
			return yield* res.failure
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
				const startedFromIdle = state.liveStatus === "idle" && turn > state.liveTurn
				return {
					...state,
					targetTurn: Math.max(state.targetTurn, turn),
					submittedTurns: nextSubmitted,
					liveStatus: startedFromIdle ? ("running" as const) : state.liveStatus,
					liveTurn: startedFromIdle ? state.liveTurn + 1 : state.liveTurn,
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
			const initiallyEnded = session.status === "terminated" || session.archived_at !== null
			const isInteractiveTty = yield* stdio.stdinIsTerminal

			if (initiallyEnded && !isInteractiveTty) {
				const unsentLine = yield* findFirstSendablePipedLine(stdio)
				if (Option.isSome(unsentLine)) {
					return yield* networkFailure(
						`Cannot send input: session ${session.id} is already ${session.archived_at !== null ? "archived" : "terminated"}.`,
					)
				}
			}

			let connectHeadSeq = after ?? 0
			if (!initiallyEnded) {
				const latestPage = yield* client.api.sessions
					.listEvents({
						params: { session_id: sessionId },
						query: { limit: "1", order: "desc" },
					})
					.pipe(Effect.mapError(formatClientError))
				const latestEntry = latestPage.data[0]
				if (latestEntry !== undefined && typeof latestEntry["seq"] === "number") {
					connectHeadSeq = Math.max(connectHeadSeq, latestEntry["seq"])
				}
			}

			yield* writeStderrLine(
				`Connected to ${session.id} (agent ${session.agent.id}@v${session.agent.version}, status: ${session.status}). Type a message, /interrupt, or /exit.`,
			)

			const stateRef = yield* Ref.make<ConnectState>({
				status: baseline.status,
				liveStatus: session.status,
				liveTurn: session.turn,
				connectHeadSeq,
				lastObservedSeq: after ?? 0,
				observedTurn: baseline.observedTurn,
				settledTurn: baseline.settledTurn,
				latestSettledStopReason: undefined,
				targetTurn: 0,
				submittedTurns: new Set<number>(),
				latestTurnError: undefined,
				failedTurnErrors: new Map<number, string>(),
				ended: initiallyEnded,
				localSentMessages: [],
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
								client,
								sessionId,
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

				if (isInteractiveTty) {
					let interruptRequestedOnce = false
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
						if (current.liveStatus === "running" && !interruptRequestedOnce) {
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
							const trimmed = line.trim()
							if (trimmed.length === 0) return
							if (trimmed === "/exit" || trimmed === "/quit") {
								explicitExit = true
								return
							}
							const state = yield* Ref.get(stateRef)
							if (state.ended) {
								return yield* networkFailure(
									`Cannot send input: session ${session.id} has already ended.`,
								)
							}
							const nextDeferred = yield* Deferred.make<void>()
							yield* Ref.set(settleDeferredRef, nextDeferred)
							const action = yield* dispatchUserLine(client, sessionId, line, stateRef, {
								failOnInterruptError: true,
							})
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
						const lastStopReason = state.latestSettledStopReason
						if (
							state.status === "idle" &&
							state.targetTurn > state.settledTurn &&
							isQueueHaltingStopReason(lastStopReason)
						) {
							const latestRes = yield* Effect.result(fetchSessionStatusWithRetry(client, sessionId))
							if (latestRes._tag === "Failure") {
								yield* Ref.set(incompleteTurnRef, latestRes.failure)
								break
							}
							if (
								latestRes.success.status !== "running" &&
								latestRes.success.turn < state.targetTurn
							) {
								yield* Ref.set(
									incompleteTurnRef,
									networkFailure(
										`Queued turn ${state.targetTurn} did not start because turn ${state.settledTurn} stopped with ${lastStopReason}.`,
									),
								)
								break
							}
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
						if (finalState.settledTurn < turn) {
							yield* Ref.set(
								failedTurnRef,
								networkFailure(
									finalState.ended
										? `Session terminated before turn ${turn} completed.`
										: `Turn ${turn} did not complete.`,
								),
							)
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
