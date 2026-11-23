import { statusOf } from "@checkfu/api/Http/Api"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { MAX_MESSAGE_TEXT_LENGTH } from "@checkfu/sessions/Session/SessionTypes"
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
	isTransientHttpStatus,
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

interface TurnFailure {
	readonly turn: number
	readonly message: string
}

interface TurnErrorSnapshot {
	readonly turn: number
	readonly message: string
	readonly retryStatus: string | undefined
}

interface ConnectState {
	readonly trackPipedTurns: boolean
	readonly status: "idle" | "running" | "terminated"
	readonly liveStatus: "idle" | "running" | "terminated"
	readonly liveTurn: number
	readonly liveStateVersion: number
	readonly observedTurn: number
	readonly settledTurn: number
	readonly latestSettledStopReason: string | undefined
	readonly targetTurn: number
	readonly unsettledSubmittedTurns: ReadonlySet<number>
	readonly unsettledQueuedTurns: ReadonlySet<number>
	readonly firstSubmittedTurnFailure: TurnFailure | undefined
	readonly pendingTurnErrors: ReadonlyMap<number, string>
	readonly sendInFlight: boolean
	readonly latestTurnError: TurnErrorSnapshot | undefined
	readonly ended: boolean
}

const recordFirstFailure = (
	current: TurnFailure | undefined,
	turn: number,
	message: string,
): TurnFailure => (current === undefined || turn < current.turn ? { turn, message } : current)

const pruneSettledTurns = (
	turns: ReadonlySet<number>,
	settledTurn: number,
): ReadonlySet<number> => {
	if (turns.size === 0) return turns
	let hasSettled = false
	for (const turn of turns) {
		if (turn <= settledTurn) {
			hasSettled = true
			break
		}
	}
	if (!hasSettled) return turns
	const next = new Set<number>()
	for (const turn of turns) {
		if (turn > settledTurn) next.add(turn)
	}
	return next
}

const pruneSettledErrors = (
	errors: ReadonlyMap<number, string>,
	settledTurn: number,
): ReadonlyMap<number, string> => {
	if (errors.size === 0) return errors
	let hasSettled = false
	for (const turn of errors.keys()) {
		if (turn <= settledTurn) {
			hasSettled = true
			break
		}
	}
	if (!hasSettled) return errors
	const next = new Map<number, string>()
	for (const [turn, message] of errors) {
		if (turn > settledTurn) next.set(turn, message)
	}
	return next
}

const MAX_SESSION_STATUS_LOOKUP_RETRIES = 2
const SESSION_STATUS_LOOKUP_RETRY_BASE_MS = 100
const MAX_CONNECT_SEND_RETRIES = 2
const CONNECT_SEND_RETRY_BASE_MS = 100

const isAmbiguousResponseStatus = (status: number): boolean =>
	(status >= 200 && status < 300) || isTransientHttpStatus(status)

interface SubmittedMessageReceipt {
	readonly turn: number
	readonly queued: boolean | undefined
}

const extractSubmittedMessageReceipt = (
	data: ReadonlyArray<unknown>,
): SubmittedMessageReceipt | undefined => {
	const first = data[0]
	if (typeof first !== "object" || first === null) return undefined
	const record = first as Record<string, unknown>
	if (record["type"] !== "user.message") return undefined
	const turn = record["turn"]
	if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1) return undefined
	const queued = typeof record["queued"] === "boolean" ? record["queued"] : undefined
	return { turn, queued }
}

const hasInterruptReceipt = (data: ReadonlyArray<unknown>): boolean => {
	const first = data[0]
	if (typeof first !== "object" || first === null) return false
	return (first as Record<string, unknown>)["type"] === "user.interrupt"
}

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
		return err.unconfirmed_index !== undefined || status >= 500
	}
	return Schema.isSchemaError(err)
}

const isRetryableSendError = (err: Parameters<typeof formatClientError>[0]): boolean =>
	isUnconfirmedSendError(err) || (isApiErrorEnvelope(err) && statusOf(err) === 429)

const isConfirmedPerMessageRejection = (err: Parameters<typeof formatClientError>[0]): boolean => {
	if (!isApiErrorEnvelope(err) || err.unconfirmed_index !== undefined) return false
	const status = statusOf(err)
	return status === 400 || status === 409 || status === 413 || status === 429
}

const formatUnconfirmedSendError = (
	err: Parameters<typeof formatClientError>[0],
	idempotencyKey: string,
	hadUnconfirmedAttempt: boolean,
): CliFailure => {
	const formatted = formatClientError(err)
	if (!hadUnconfirmedAttempt && !isUnconfirmedSendError(err)) return formatted
	return new CliFailure({
		message: `${formatted.message} (delivery unconfirmed; retry safely with Idempotency-Key: ${idempotencyKey})`,
		exitCode: formatted.exitCode,
	})
}

interface SendEventsFailure {
	readonly failure: CliFailure
	readonly confirmedPerMessageRejection: boolean
}

const sendConnectEventsWithRetry = <A>(
	send: Effect.Effect<A, Parameters<typeof formatClientError>[0]>,
	idempotencyKey: string,
): Effect.Effect<A, SendEventsFailure> =>
	Effect.gen(function* () {
		let hadUnconfirmedAttempt = false
		for (let attempt = 0; ; attempt++) {
			const res = yield* Effect.result(send)
			if (res._tag === "Success") {
				return res.success
			}
			const err = res.failure
			if (isUnconfirmedSendError(err)) {
				hadUnconfirmedAttempt = true
			}
			if (isRetryableSendError(err) && attempt < MAX_CONNECT_SEND_RETRIES) {
				yield* Effect.sleep(Duration.millis(CONNECT_SEND_RETRY_BASE_MS * 2 ** attempt))
				continue
			}
			return yield* Effect.fail({
				failure: formatUnconfirmedSendError(err, idempotencyKey, hadUnconfirmedAttempt),
				confirmedPerMessageRejection: !hadUnconfirmedAttempt && isConfirmedPerMessageRejection(err),
			})
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

interface BoundedLineHooks {
	readonly onChunkParsed?: (lines: ReadonlyArray<string>, pending: string) => void
	readonly onPendingAfterLines?: (pending: string) => Effect.Effect<void>
	readonly onTrailingFlushed?: (line: string) => Effect.Effect<void>
}

const splitBoundedLines = (
	stdin: Stdio.Stdio["stdin"],
	maxLineChars: number,
	hooks?: BoundedLineHooks,
): Stream.Stream<string, CliFailure> =>
	Stream.suspend(() => {
		let pending = ""
		let discardLeadingLf = false
		const lineTooLongError = () =>
			usageError(`Input line exceeds maximum message length of ${maxLineChars} characters.`)

		const processChunk = (chunk: string): Stream.Stream<string, CliFailure> =>
			Stream.unwrap(
				Effect.sync(() => {
					const lines: Array<string> = []
					let pos = 0
					const len = chunk.length
					let overflowed = false
					while (pos < len) {
						if (discardLeadingLf) {
							discardLeadingLf = false
							if (chunk.charCodeAt(pos) === 10) {
								pos += 1
								continue
							}
						}
						let lineEnd = pos
						while (lineEnd < len) {
							const code = chunk.charCodeAt(lineEnd)
							if (code === 13 || code === 10) break
							lineEnd += 1
						}
						const segLen = lineEnd - pos
						if (pending.length + segLen > maxLineChars) {
							overflowed = true
							break
						}
						if (lineEnd === len) {
							pending += chunk.slice(pos)
							break
						}
						discardLeadingLf = chunk.charCodeAt(lineEnd) === 13
						lines.push(
							pending.length > 0 ? pending + chunk.slice(pos, lineEnd) : chunk.slice(pos, lineEnd),
						)
						pending = ""
						pos = lineEnd + 1
					}
					hooks?.onChunkParsed?.(lines, pending)
					const emitted =
						lines.length > 0 ? Stream.fromIterable(lines).pipe(Stream.rechunk(1)) : Stream.empty
					if (overflowed) {
						return Stream.concat(emitted, Stream.fail(lineTooLongError()))
					}
					if (hooks?.onPendingAfterLines !== undefined) {
						const snapshot = pending
						return Stream.concat(
							emitted,
							Stream.unwrap(hooks.onPendingAfterLines(snapshot).pipe(Effect.as(Stream.empty))),
						)
					}
					return emitted
				}),
			)

		const body = stdin.pipe(
			Stream.mapError((err) => usageError(`Failed to read stdin: ${err.message}`)),
			Stream.decodeText(),
			Stream.flatMap(processChunk),
		)

		const flushTrailing = Stream.unwrap(
			Effect.gen(function* () {
				if (pending.length === 0) return Stream.empty
				const last = pending
				pending = ""
				if (hooks?.onTrailingFlushed !== undefined) {
					yield* hooks.onTrailingFlushed(last)
				}
				return Stream.make(last)
			}),
		)

		return Stream.concat(body, flushTrailing)
	})

type EndedStdinSignal =
	| { readonly _tag: "eof" }
	| { readonly _tag: "exit" }
	| { readonly _tag: "input"; readonly line: string }

const isExitCommand = (trimmed: string): boolean => trimmed === "/exit" || trimmed === "/quit"

const isExitCommandPrefix = (trimmed: string): boolean =>
	"/exit".startsWith(trimmed) || "/quit".startsWith(trimmed)

const inspectEndedPipedStdin = (
	stdio: Stdio.Stdio,
	bufferedLineRef: Ref.Ref<string>,
): Effect.Effect<EndedStdinSignal, CliFailure> =>
	Effect.gen(function* () {
		const earlyInput = yield* Deferred.make<EndedStdinSignal>()
		const readLines = Effect.gen(function* () {
			let signal: EndedStdinSignal = { _tag: "eof" }
			yield* splitBoundedLines(stdio.stdin, MAX_MESSAGE_TEXT_LENGTH, {
				onPendingAfterLines: (pending) =>
					Effect.gen(function* () {
						yield* Ref.set(bufferedLineRef, pending)
						const trimmed = pending.trim()
						if (trimmed.length > 0 && !isExitCommandPrefix(trimmed)) {
							yield* Deferred.succeed(earlyInput, { _tag: "input", line: trimmed })
						}
					}),
				onTrailingFlushed: () => Ref.set(bufferedLineRef, ""),
			}).pipe(
				Stream.takeUntil((line) => line.trim().length > 0),
				Stream.runForEach((line) =>
					Effect.sync(() => {
						const trimmed = line.trim()
						if (trimmed.length === 0) return
						if (isExitCommand(trimmed)) {
							signal = { _tag: "exit" }
						} else {
							signal = { _tag: "input", line: trimmed }
						}
					}),
				),
			)
			return signal
		})
		return yield* Effect.raceFirst(readLines, Deferred.await(earlyInput))
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
	settleDeferredRef: Ref.Ref<Deferred.Deferred<void>>,
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
				if (!rawStructuredMode && text.length > 0) {
					yield* writeStdoutLine(`[user] ${escapeTerminalControlCharacters(text)}`)
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
						liveStateVersion: reachedLive ? state.liveStateVersion + 1 : state.liveStateVersion,
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
				const retryStatusObj =
					typeof errObj?.["retry_status"] === "object" && errObj["retry_status"] !== null
						? (errObj["retry_status"] as Record<string, unknown>)
						: undefined
				const retryStatus =
					typeof retryStatusObj?.["type"] === "string" ? retryStatusObj["type"] : undefined
				const formattedError = `${errType}: ${errMsg}`
				yield* Ref.update(stateRef, (state) =>
					state.trackPipedTurns
						? {
								...state,
								latestTurnError: {
									turn: state.observedTurn,
									message: formattedError,
									retryStatus,
								},
							}
						: state,
				)
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
				if (!rawStructuredMode && stopReason !== undefined && stopReason !== "end_turn") {
					yield* writeStderrLine(`[status: idle (${stopReason})]`)
				}
				const next = yield* Ref.updateAndGet(stateRef, (state) => {
					const turn = state.observedTurn
					const nextSettledTurn = Math.max(state.settledTurn, turn)
					const latestSettledStopReason =
						turn >= state.settledTurn ? stopReason : state.latestSettledStopReason
					const reachedLiveIdle =
						turn > state.liveTurn || (turn === state.liveTurn && state.liveStatus === "running")
					if (!state.trackPipedTurns) {
						return {
							...state,
							status: "idle" as const,
							liveStatus: turn >= state.liveTurn ? ("idle" as const) : state.liveStatus,
							liveTurn: Math.max(state.liveTurn, turn),
							liveStateVersion: reachedLiveIdle
								? state.liveStateVersion + 1
								: state.liveStateVersion,
							settledTurn: nextSettledTurn,
							latestSettledStopReason,
						}
					}
					let firstSubmittedTurnFailure = state.firstSubmittedTurnFailure
					let pendingTurnErrors = state.pendingTurnErrors
					if (stopReason === "retries_exhausted") {
						const turnError =
							(state.latestTurnError?.turn === turn ? state.latestTurnError.message : undefined) ??
							"Model retries exhausted."
						if (state.unsettledSubmittedTurns.has(turn)) {
							firstSubmittedTurnFailure = recordFirstFailure(
								firstSubmittedTurnFailure,
								turn,
								turnError,
							)
						} else if (state.sendInFlight) {
							const nextPending = new Map(pendingTurnErrors)
							nextPending.set(turn, turnError)
							pendingTurnErrors = nextPending
						}
					}
					if (!state.sendInFlight) {
						pendingTurnErrors = pruneSettledErrors(pendingTurnErrors, nextSettledTurn)
					}
					return {
						...state,
						status: "idle" as const,
						liveStatus: turn >= state.liveTurn ? ("idle" as const) : state.liveStatus,
						liveTurn: Math.max(state.liveTurn, turn),
						liveStateVersion: reachedLiveIdle ? state.liveStateVersion + 1 : state.liveStateVersion,
						settledTurn: nextSettledTurn,
						latestSettledStopReason,
						unsettledSubmittedTurns: pruneSettledTurns(
							state.unsettledSubmittedTurns,
							nextSettledTurn,
						),
						unsettledQueuedTurns: pruneSettledTurns(state.unsettledQueuedTurns, nextSettledTurn),
						firstSubmittedTurnFailure,
						pendingTurnErrors,
						latestTurnError:
							state.latestTurnError?.turn === turn ? undefined : state.latestTurnError,
					}
				})
				if (
					next.trackPipedTurns &&
					((next.targetTurn > 0 && next.settledTurn >= next.targetTurn) ||
						(next.unsettledQueuedTurns.has(next.targetTurn) &&
							next.settledTurn === next.targetTurn - 1 &&
							isQueueHaltingStopReason(stopReason)))
				) {
					const settleDeferred = yield* Ref.get(settleDeferredRef)
					yield* Deferred.succeed(settleDeferred, undefined)
				}
				break
			}
			case "session.status_terminated":
			case "session.archived": {
				yield* Ref.update(stateRef, (state) => {
					if (!state.trackPipedTurns) {
						return {
							...state,
							status: "terminated" as const,
							liveStatus: "terminated" as const,
							liveStateVersion: state.liveStateVersion + 1,
						}
					}
					let firstSubmittedTurnFailure = state.firstSubmittedTurnFailure
					let pendingTurnErrors = state.pendingTurnErrors
					if (
						eventType === "session.status_terminated" &&
						state.observedTurn > state.settledTurn &&
						state.latestTurnError?.turn === state.observedTurn &&
						state.latestTurnError.retryStatus === "terminal"
					) {
						const turn = state.observedTurn
						const turnError = state.latestTurnError.message
						if (state.unsettledSubmittedTurns.has(turn)) {
							firstSubmittedTurnFailure = recordFirstFailure(
								firstSubmittedTurnFailure,
								turn,
								turnError,
							)
						} else if (state.sendInFlight) {
							const nextPending = new Map(pendingTurnErrors)
							nextPending.set(turn, turnError)
							pendingTurnErrors = nextPending
						}
					}
					return {
						...state,
						status: "terminated" as const,
						liveStatus: "terminated" as const,
						liveStateVersion: state.liveStateVersion + 1,
						firstSubmittedTurnFailure,
						pendingTurnErrors,
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
					const settleDeferred = yield* Ref.get(settleDeferredRef)
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
	options?: {
		readonly failOnInterruptError?: boolean
		readonly reportRecoverableSendErrors?: boolean
		readonly onInterruptedSend?: (failure: CliFailure) => Effect.Effect<void>
	},
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
				).pipe(
					Effect.onInterrupt(() => {
						const msg = `Interrupted while sending /interrupt (delivery unconfirmed; retry safely with Idempotency-Key: ${key}).`
						return Effect.all([
							writeStderrLine(msg).pipe(Effect.ignore),
							options?.onInterruptedSend !== undefined
								? options.onInterruptedSend(networkFailure(msg))
								: Effect.void,
						])
					}),
				),
			)
			const interruptFailure =
				res._tag === "Failure"
					? res.failure.failure
					: hasInterruptReceipt(res.success.data)
						? undefined
						: networkFailure(
								`Interrupt response did not confirm a user.interrupt receipt (delivery unconfirmed; retry safely with Idempotency-Key: ${key})`,
							)
			if (interruptFailure !== undefined) {
				if (options?.failOnInterruptError === true) {
					return yield* interruptFailure
				}
				yield* writeStderrLine(`Interrupt failed: ${interruptFailure.message}`)
			} else {
				yield* writeStderrLine("Interrupt requested.")
			}
			return "continue" as const
		}

		const key = yield* client.generateIdempotencyKey()
		const sendSnapshot = yield* Ref.modify(stateRef, (state) => [
			{
				liveStatus: state.liveStatus,
				liveTurn: state.liveTurn,
				liveStateVersion: state.liveStateVersion,
			},
			state.trackPipedTurns ? { ...state, sendInFlight: true } : state,
		])
		const clearSendInFlight = Ref.update(stateRef, (state) =>
			state.trackPipedTurns
				? {
						...state,
						sendInFlight: false,
						pendingTurnErrors: pruneSettledErrors(state.pendingTurnErrors, state.settledTurn),
					}
				: state,
		)
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
			).pipe(
				Effect.onInterrupt(() => {
					const msg = `Interrupted while sending message (delivery unconfirmed; retry safely with Idempotency-Key: ${key}).`
					return Effect.all([
						clearSendInFlight,
						writeStderrLine(msg).pipe(Effect.ignore),
						options?.onInterruptedSend !== undefined
							? options.onInterruptedSend(networkFailure(msg))
							: Effect.void,
					])
				}),
			),
		)
		if (res._tag === "Failure") {
			yield* clearSendInFlight
			if (
				options?.reportRecoverableSendErrors === true &&
				res.failure.confirmedPerMessageRejection
			) {
				yield* writeStderrLine(`Send failed: ${res.failure.failure.message}`)
				return "continue" as const
			}
			return yield* res.failure.failure
		}
		const receipt = extractSubmittedMessageReceipt(res.success.data)
		if (receipt === undefined) {
			yield* clearSendInFlight
			return yield* networkFailure(
				`Message response did not confirm a valid turn (delivery unconfirmed; retry safely with Idempotency-Key: ${key})`,
			)
		}
		const { turn, queued } = receipt
		yield* Ref.update(stateRef, (state) => {
			const initiatedFromIdle =
				queued !== undefined
					? !queued
					: sendSnapshot.liveStatus === "idle" && turn === sendSnapshot.liveTurn + 1
			const startedNow =
				queued === false
					? state.liveTurn < turn
					: initiatedFromIdle &&
						state.liveStateVersion === sendSnapshot.liveStateVersion &&
						state.liveStatus === "idle"
			if (!state.trackPipedTurns) {
				return startedNow
					? {
							...state,
							liveStatus: "running" as const,
							liveTurn: turn,
						}
					: state
			}
			const preRecordedError = state.pendingTurnErrors.get(turn)
			const firstSubmittedTurnFailure =
				preRecordedError !== undefined
					? recordFirstFailure(state.firstSubmittedTurnFailure, turn, preRecordedError)
					: state.firstSubmittedTurnFailure
			let unsettledSubmittedTurns = state.unsettledSubmittedTurns
			if (turn > state.settledTurn && !unsettledSubmittedTurns.has(turn)) {
				const nextSubmitted = new Set(unsettledSubmittedTurns)
				nextSubmitted.add(turn)
				unsettledSubmittedTurns = nextSubmitted
			}
			let unsettledQueuedTurns = state.unsettledQueuedTurns
			if (!initiatedFromIdle && turn > state.settledTurn && !unsettledQueuedTurns.has(turn)) {
				const nextQueued = new Set(unsettledQueuedTurns)
				nextQueued.add(turn)
				unsettledQueuedTurns = nextQueued
			}
			return {
				...state,
				targetTurn: Math.max(state.targetTurn, turn),
				unsettledSubmittedTurns,
				unsettledQueuedTurns,
				firstSubmittedTurnFailure,
				pendingTurnErrors: pruneSettledErrors(state.pendingTurnErrors, state.settledTurn),
				sendInFlight: false,
				liveStatus: startedNow ? ("running" as const) : state.liveStatus,
				liveTurn: startedNow ? turn : state.liveTurn,
			}
		})
		return "continue" as const
	})

type SessionSnapshotResponse = Effect.Success<ReturnType<typeof fetchSessionStatusWithRetry>>

const MAX_SUFFIX_CONSISTENCY_ATTEMPTS = 3

const resolveCursorBaselineFromPrefix = (
	client: CheckfuClient,
	sessionId: SessionId,
	after: number,
): Effect.Effect<
	{
		readonly status: ConnectState["status"]
		readonly observedTurn: number
		readonly settledTurn: number
	},
	CliFailure
> =>
	Effect.gen(function* () {
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
				page.next_cursor <= pageCursor ||
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

const resolveCursorBaseline = (
	client: CheckfuClient,
	sessionId: SessionId,
	initialSession: SessionSnapshotResponse,
	after: number | undefined,
	headSeq: number,
): Effect.Effect<
	{
		readonly status: ConnectState["status"]
		readonly observedTurn: number
		readonly settledTurn: number
		readonly latestSession: SessionSnapshotResponse
	},
	CliFailure
> => {
	if (after === undefined || after === 0) {
		return Effect.succeed({
			status: "idle" as const,
			observedTurn: 0,
			settledTurn: 0,
			latestSession: initialSession,
		})
	}
	if (after > headSeq) {
		return Effect.fail(
			usageError(
				`--after cursor ${after} is beyond the latest session event sequence (${headSeq}).`,
			),
		)
	}
	return Effect.gen(function* () {
		// Derive the cursor baseline from the shorter side: when resuming near the head,
		// scan only the bounded suffix (after, targetHeadSeq] and reconcile against a
		// consistent head snapshot, falling back to the fixed prefix scan if the head moves.
		if (headSeq - after <= after) {
			let before = initialSession
			let targetHeadSeq = headSeq
			for (let attempt = 0; attempt < MAX_SUFFIX_CONSISTENCY_ATTEMPTS; attempt++) {
				let pageCursor = after
				let runningAfter = 0
				let firstStatusAfter:
					| "session.status_running"
					| "session.status_idle"
					| "session.status_terminated"
					| "session.archived"
					| undefined
				let headMovedPastBoundary = false

				while (true) {
					const page = yield* client.api.sessions
						.listEvents({
							params: { session_id: sessionId },
							query: {
								after: String(pageCursor),
								limit: "100",
								order: "asc",
							},
						})
						.pipe(Effect.mapError(formatClientError))
					let reachedBoundary = false
					let lastPageSeq: number | undefined
					for (const entry of page.data) {
						const seq = typeof entry["seq"] === "number" ? entry["seq"] : undefined
						if (seq !== undefined) {
							lastPageSeq = seq
							if (seq > targetHeadSeq) {
								headMovedPastBoundary = true
								reachedBoundary = true
								break
							}
						}
						const eventType = typeof entry["type"] === "string" ? entry["type"] : undefined
						if (eventType === "session.status_running") {
							runningAfter += 1
							firstStatusAfter ??= eventType
						} else if (
							eventType === "session.status_idle" ||
							eventType === "session.status_terminated" ||
							eventType === "session.archived"
						) {
							firstStatusAfter ??= eventType
						}
					}
					if (
						!reachedBoundary &&
						page.has_more &&
						((lastPageSeq !== undefined && lastPageSeq >= targetHeadSeq) ||
							(page.next_cursor !== null && page.next_cursor >= targetHeadSeq))
					) {
						headMovedPastBoundary = true
						reachedBoundary = true
					}
					if (
						reachedBoundary ||
						!page.has_more ||
						page.next_cursor === null ||
						page.next_cursor <= pageCursor ||
						page.next_cursor >= targetHeadSeq ||
						(lastPageSeq !== undefined && lastPageSeq >= targetHeadSeq)
					) {
						break
					}
					pageCursor = page.next_cursor
				}

				const afterSnap = yield* fetchSessionStatusWithRetry(client, sessionId)
				const consistent =
					!headMovedPastBoundary &&
					before.turn === afterSnap.turn &&
					before.status === afterSnap.status &&
					(before.archived_at === null) === (afterSnap.archived_at === null)
				if (consistent) {
					const observedTurn = Math.max(0, afterSnap.turn - runningAfter)
					let status: ConnectState["status"]
					let settledTurn: number
					if (firstStatusAfter === "session.status_running") {
						status = "idle"
						settledTurn = observedTurn
					} else if (firstStatusAfter === "session.status_idle") {
						status = "running"
						settledTurn = Math.max(0, observedTurn - 1)
					} else if (firstStatusAfter === "session.archived") {
						status = "terminated"
						settledTurn = observedTurn
					} else if (firstStatusAfter === "session.status_terminated") {
						status = observedTurn > 0 ? "running" : "idle"
						settledTurn = observedTurn
					} else {
						status = afterSnap.status
						settledTurn =
							afterSnap.status === "running" ? Math.max(0, observedTurn - 1) : observedTurn
					}
					return {
						status,
						observedTurn,
						settledTurn,
						latestSession: afterSnap,
					}
				}
				if (attempt + 1 < MAX_SUFFIX_CONSISTENCY_ATTEMPTS) {
					const latestPage = yield* client.api.sessions
						.listEvents({
							params: { session_id: sessionId },
							query: { limit: "1", order: "desc" },
						})
						.pipe(Effect.mapError(formatClientError))
					const latestEntry = latestPage.data[0]
					if (latestEntry !== undefined && typeof latestEntry["seq"] === "number") {
						targetHeadSeq = Math.max(targetHeadSeq, latestEntry["seq"])
					}
					before = afterSnap
					if (targetHeadSeq - after > after) {
						break
					}
				}
			}
		}

		const prefix = yield* resolveCursorBaselineFromPrefix(client, sessionId, after)
		return {
			...prefix,
			latestSession: initialSession,
		}
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

			if (
				rawSessionId.length === 0 ||
				rawSessionId === "." ||
				rawSessionId === ".." ||
				rawSessionId.includes("/") ||
				rawSessionId.includes("\\")
			) {
				return yield* usageError(
					'Invalid --session-id: must be a single non-empty path segment (not "." or "..").',
				)
			}

			const sessionId = yield* decodePayload(SessionId, rawSessionId, "--session-id")
			const root = yield* RootCommand
			const stdio = yield* Stdio.Stdio
			const terminal = yield* Terminal.Terminal
			const client = yield* getClient()

			const initialSession = yield* client.api.sessions
				.get({ params: { session_id: sessionId } })
				.pipe(Effect.mapError(formatClientError))

			const rawStructuredMode =
				root.format !== "auto" || Option.isSome(root.transform) || root.rawOutput

			const after = Option.getOrUndefined(input.after)
			let headSeq = 0
			if (after !== undefined && after > 0) {
				const latestPage = yield* client.api.sessions
					.listEvents({
						params: { session_id: sessionId },
						query: { limit: "1", order: "desc" },
					})
					.pipe(Effect.mapError(formatClientError))
				const latestEntry = latestPage.data[0]
				if (latestEntry !== undefined && typeof latestEntry["seq"] === "number") {
					headSeq = latestEntry["seq"]
				}
			}

			const baseline = yield* resolveCursorBaseline(
				client,
				sessionId,
				initialSession,
				after,
				headSeq,
			)
			const session = baseline.latestSession
			const initiallyEnded = session.status === "terminated" || session.archived_at !== null
			const isInteractiveTty = yield* stdio.stdinIsTerminal

			yield* writeStderrLine(
				`Connected to ${session.id} (agent ${session.agent.id}@v${session.agent.version}, status: ${session.status}). Type a message, /interrupt, or /exit.`,
			)

			const stateRef = yield* Ref.make<ConnectState>({
				trackPipedTurns: !isInteractiveTty,
				status: baseline.status,
				liveStatus: session.status,
				liveTurn: session.turn,
				liveStateVersion: 0,
				observedTurn: baseline.observedTurn,
				settledTurn: baseline.settledTurn,
				latestSettledStopReason: undefined,
				targetTurn: 0,
				unsettledSubmittedTurns: new Set<number>(),
				unsettledQueuedTurns: new Set<number>(),
				firstSubmittedTurnFailure: undefined,
				pendingTurnErrors: new Map<number, string>(),
				sendInFlight: false,
				latestTurnError: undefined,
				ended: initiallyEnded,
			})

			const settleDeferredRef = yield* Ref.make(yield* Deferred.make<void>())
			const streamFailedRef = yield* Ref.make<CliFailure | null>(null)
			const incompleteTurnRef = yield* Ref.make<CliFailure | null>(null)
			const failedTurnRef = yield* Ref.make<CliFailure | null>(null)
			const streamEndedDeferred = yield* Deferred.make<void>()
			const stopConnectDeferred = yield* Deferred.make<void>()
			const expectArchivedEvent = session.archived_at !== null
			const endedBufferedLineRef = yield* Ref.make("")

			const stdinCheckFiber =
				initiallyEnded && !isInteractiveTty
					? yield* Effect.result(inspectEndedPipedStdin(stdio, endedBufferedLineRef)).pipe(
							Effect.forkChild,
						)
					: undefined

			const streamFiber = yield* client
				.streamSessionEvents(sessionId, after === undefined ? undefined : { after })
				.pipe(
					Stream.runForEach((event) =>
						renderConnectEvent(
							client,
							sessionId,
							event,
							stateRef,
							settleDeferredRef,
							stopConnectDeferred,
							expectArchivedEvent,
							rawStructuredMode,
						),
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
					const replayDone =
						session.archived_at !== null
							? Deferred.await(streamEndedDeferred)
							: baseline.status !== "terminated"
								? Deferred.await(stopConnectDeferred)
								: Effect.void

					if (stdinCheckFiber === undefined) {
						const endedStatusLabel = session.archived_at !== null ? "archived" : "terminated"
						while (true) {
							const nextEvent = yield* Effect.race(
								Effect.result(terminal.readLine).pipe(
									Effect.map((outcome) => ({ _tag: "line" as const, outcome })),
								),
								replayDone.pipe(Effect.as({ _tag: "replay_done" as const })),
							)
							if (nextEvent._tag === "replay_done") break
							if (nextEvent.outcome._tag === "Failure") {
								yield* replayDone
								break
							}
							const trimmed = nextEvent.outcome.success.trim()
							if (trimmed === "/exit" || trimmed === "/quit") {
								break
							}
							if (trimmed.length > 0) {
								yield* writeStderrLine(
									`Cannot send input: session ${session.id} is already ${endedStatusLabel}. Type /exit to disconnect.`,
								)
							}
						}
						return
					}

					const unsentInputError = networkFailure(
						`Cannot send input: session ${session.id} is already ${session.archived_at !== null ? "archived" : "terminated"}.`,
					)
					const handleStdinOutcome = (
						outcome:
							| { readonly _tag: "Success"; readonly success: EndedStdinSignal }
							| { readonly _tag: "Failure"; readonly failure: CliFailure },
					): Effect.Effect<"eof" | "exit", CliFailure> => {
						if (outcome._tag === "Failure") {
							return Effect.fail(outcome.failure)
						}
						if (outcome.success._tag === "input") {
							return Effect.fail(unsentInputError)
						}
						return Effect.succeed(outcome.success._tag)
					}

					yield* Effect.gen(function* () {
						const first = yield* Effect.race(
							Fiber.join(stdinCheckFiber).pipe(
								Effect.map((outcome) => ({ _tag: "stdin" as const, outcome })),
							),
							replayDone.pipe(Effect.as({ _tag: "replay_done" as const })),
						)
						if (first._tag === "stdin") {
							const kind = yield* handleStdinOutcome(first.outcome)
							if (kind === "eof") {
								yield* replayDone
							}
						} else {
							const lateStdin = yield* Effect.race(
								Fiber.join(stdinCheckFiber).pipe(Effect.map(Option.some)),
								Effect.sleep("20 millis").pipe(Effect.as(Option.none())),
							)
							if (Option.isSome(lateStdin)) {
								yield* handleStdinOutcome(lateStdin.value)
							} else {
								const buffered = (yield* Ref.get(endedBufferedLineRef)).trim()
								if (buffered.length > 0 && !isExitCommand(buffered)) {
									return yield* unsentInputError
								}
							}
						}
					}).pipe(Effect.ensuring(Fiber.interrupt(stdinCheckFiber)))
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
							const dispatchOutcome = yield* Effect.raceFirst(
								dispatchUserLine(client, sessionId, nextEvent.outcome.success, stateRef, {
									reportRecoverableSendErrors: true,
									onInterruptedSend: (failure) => Ref.set(incompleteTurnRef, failure),
								}).pipe(Effect.map((action) => ({ _tag: "action" as const, action }))),
								Deferred.await(stopConnectDeferred).pipe(Effect.as({ _tag: "ended" as const })),
							)
							if (dispatchOutcome._tag === "ended" || dispatchOutcome.action === "exit") break
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
				const queuedLines: Array<string> = []
				let pendingPartial = ""
				const pipedInputEffect = splitBoundedLines(stdio.stdin, MAX_MESSAGE_TEXT_LENGTH, {
					onChunkParsed: (lines, pending) => {
						queuedLines.push(...lines)
						pendingPartial = pending
					},
					onTrailingFlushed: (last) =>
						Effect.sync(() => {
							queuedLines.push(last)
							pendingPartial = ""
						}),
				}).pipe(
					Stream.takeUntil((line) => isExitCommand(line.trim())),
					Stream.runForEach((line) =>
						Effect.gen(function* () {
							queuedLines.shift()
							if (explicitExit) return
							const trimmed = line.trim()
							if (trimmed.length === 0) return
							if (isExitCommand(trimmed)) {
								explicitExit = true
								return
							}
							const state = yield* Ref.get(stateRef)
							if (state.ended) {
								return yield* networkFailure(
									`Cannot send input: session ${session.id} has already ended.`,
								)
							}
							const action = yield* dispatchUserLine(client, sessionId, line, stateRef, {
								failOnInterruptError: true,
								onInterruptedSend: (failure) => Ref.set(incompleteTurnRef, failure),
							})
							if (action === "exit") {
								explicitExit = true
							}
						}),
					),
				)
				const inputRaceOutcome = yield* Effect.raceFirst(
					pipedInputEffect.pipe(Effect.as("stdin_done" as const)),
					Deferred.await(stopConnectDeferred).pipe(Effect.as("stopped" as const)),
				)
				if (inputRaceOutcome === "stopped" && !explicitExit) {
					const streamErr = yield* Ref.get(streamFailedRef)
					const existingIncomplete = yield* Ref.get(incompleteTurnRef)
					if (streamErr === null && existingIncomplete === null) {
						const firstUnprocessed = [...queuedLines, pendingPartial]
							.map((entry) => entry.trim())
							.find((entry) => entry.length > 0)
						if (firstUnprocessed !== undefined && !isExitCommand(firstUnprocessed)) {
							const currentState = yield* Ref.get(stateRef)
							return yield* networkFailure(
								currentState.ended
									? `Cannot send input: session ${session.id} ended before buffered input was submitted.`
									: "Event stream ended before buffered input was submitted.",
							)
						}
					}
				}

				if (!explicitExit) {
					while (true) {
						const waiter = yield* Deferred.make<void>()
						yield* Ref.set(settleDeferredRef, waiter)

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
							state.unsettledQueuedTurns.has(state.targetTurn) &&
							state.settledTurn === state.targetTurn - 1 &&
							state.observedTurn < state.targetTurn &&
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
					}

					const finalState = yield* Ref.get(stateRef)
					let lowestUnsettled: number | undefined
					for (const turn of finalState.unsettledSubmittedTurns) {
						if (lowestUnsettled === undefined || turn < lowestUnsettled) {
							lowestUnsettled = turn
						}
					}
					if (
						finalState.firstSubmittedTurnFailure !== undefined &&
						(lowestUnsettled === undefined ||
							finalState.firstSubmittedTurnFailure.turn <= lowestUnsettled)
					) {
						yield* Ref.set(
							failedTurnRef,
							networkFailure(
								`Turn ${finalState.firstSubmittedTurnFailure.turn} failed: ${finalState.firstSubmittedTurnFailure.message}`,
							),
						)
					} else if (lowestUnsettled !== undefined) {
						yield* Ref.set(
							failedTurnRef,
							networkFailure(
								finalState.ended
									? `Session terminated before turn ${lowestUnsettled} completed.`
									: `Turn ${lowestUnsettled} did not complete.`,
							),
						)
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
