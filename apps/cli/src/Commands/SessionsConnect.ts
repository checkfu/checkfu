import { SessionId } from "@checkfu/domain/Session/Session.id"
import { MAX_MESSAGE_TEXT_LENGTH } from "@checkfu/domain/Session/SessionTypes"
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
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as Terminal from "effect/Terminal"
import type { CheckfuClient, SessionStreamEvent } from "../Client.ts"
import {
	CliFailure,
	apiErrorStatus,
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
import {
	applyMessageReceipt,
	applySessionEvent,
	beginMessageSend,
	cancelMessageSend,
	createInitialConnectState,
	evaluateHaltedQueueSnapshot,
	evaluatePipedSettlement,
	extractSubmittedMessageReceipt,
	hasInterruptReceipt,
	markSessionEnded,
	resolveFinalPipedError,
	resolveStreamEndedError,
	shouldInterruptOnCtrlC,
} from "./SessionsConnectState.ts"
import type { ConnectState } from "./SessionsConnectState.ts"

const isJsonObject = Schema.is(Schema.JsonObject)
const isJsonArray = (value: Schema.Json | undefined): value is ReadonlyArray<Schema.Json> =>
	Array.isArray(value)

const extractContentText = (data: Schema.JsonObject): string => {
	const content = data["content"]
	if (!isJsonArray(content)) {
		return ""
	}
	const parts: Array<string> = []
	for (const block of content) {
		if (isJsonObject(block) && block["type"] === "text" && typeof block["text"] === "string") {
			parts.push(block["text"])
		}
	}
	return parts.join("\n")
}

const MAX_SESSION_STATUS_LOOKUP_RETRIES = 2
const SESSION_STATUS_LOOKUP_RETRY_BASE_MS = 100
const MAX_CONNECT_SEND_RETRIES = 2
const CONNECT_SEND_RETRY_BASE_MS = 100
const MAX_QUEUED_TURN_PROJECTION_RETRIES = 5
const QUEUED_TURN_PROJECTION_RETRY_BASE_MS = 50

const isAmbiguousResponseStatus = (status: number): boolean =>
	(status >= 200 && status < 300) || isTransientHttpStatus(status)

const isRetryableLookupError = (err: Parameters<typeof formatClientError>[0]): boolean => {
	if (HttpClientError.isHttpClientError(err)) {
		if (isTransientHttpError(err)) {
			return true
		}
		const reason = err.reason
		if (reason._tag === "DecodeError" || reason._tag === "EmptyBodyError") {
			return isAmbiguousResponseStatus(reason.response.status)
		}
		return false
	}
	if (isApiErrorEnvelope(err)) {
		const status = apiErrorStatus(err)
		return status === 429 || status >= 500
	}
	return false
}

const isUnconfirmedSendError = (err: Parameters<typeof formatClientError>[0]): boolean => {
	if (HttpClientError.isHttpClientError(err)) {
		if (isTransientHttpError(err)) {
			return true
		}
		const reason = err.reason
		if (reason._tag === "DecodeError" || reason._tag === "EmptyBodyError") {
			return isAmbiguousResponseStatus(reason.response.status)
		}
		return false
	}
	if (isApiErrorEnvelope(err)) {
		const status = apiErrorStatus(err)
		return err.unconfirmed_index !== undefined || status >= 500
	}
	return Schema.isSchemaError(err)
}

const isRetryableSendError = (err: Parameters<typeof formatClientError>[0]): boolean =>
	isUnconfirmedSendError(err) || (isApiErrorEnvelope(err) && apiErrorStatus(err) === 429)

const isConfirmedPerMessageRejection = (err: Parameters<typeof formatClientError>[0]): boolean => {
	if (!isApiErrorEnvelope(err) || err.unconfirmed_index !== undefined) {
		return false
	}
	const status = apiErrorStatus(err)
	return status === 400 || status === 409 || status === 413 || status === 429
}

const formatUnconfirmedSendError = (
	err: Parameters<typeof formatClientError>[0],
	idempotencyKey: string,
	hadUnconfirmedAttempt: boolean,
): CliFailure => {
	const formatted = formatClientError(err)
	if (!hadUnconfirmedAttempt && !isUnconfirmedSendError(err)) {
		return formatted
	}
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
	client.api.sessions.get({ params: { session_id: sessionId } }).pipe(
		Effect.retry({
			while: isRetryableLookupError,
			schedule: Schedule.exponential(Duration.millis(SESSION_STATUS_LOOKUP_RETRY_BASE_MS)),
			times: MAX_SESSION_STATUS_LOOKUP_RETRIES,
		}),
		Effect.mapError(formatClientError),
	)

interface BoundedLineHooks {
	readonly onChunkParsed?: (lines: ReadonlyArray<string>, pending: string) => void
	readonly onPendingAfterLines?: (pending: string) => Effect.Effect<void>
	readonly onTrailingFlushed?: (line: string) => Effect.Effect<void>
}

const lineTooLongError = (maxLineChars: number) =>
	usageError(`Input line exceeds maximum message length of ${maxLineChars} characters.`)

const splitBoundedLines = (
	stdin: Stdio.Stdio["stdin"],
	maxLineChars: number,
	hooks?: BoundedLineHooks,
): Stream.Stream<string, CliFailure> =>
	Stream.suspend(() => {
		let pending = ""
		let discardLeadingLf = false

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
							if (code === 13 || code === 10) {
								break
							}
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
						return Stream.concat(emitted, Stream.fail(lineTooLongError(maxLineChars)))
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

		const decoder = new TextDecoder("utf-8", { fatal: true })

		const body = stdin.pipe(
			Stream.mapError((err) => usageError(`Failed to read stdin: ${err.message}`)),
			Stream.mapEffect((chunk) =>
				Effect.try({
					try: () => decoder.decode(chunk, { stream: true }),
					catch: () => usageError("stdin is not valid UTF-8."),
				}),
			),
			Stream.flatMap(processChunk),
		)

		const flushTrailing = Stream.unwrap(
			Effect.gen(function* () {
				const tail = yield* Effect.try({
					try: () => decoder.decode(),
					catch: () => usageError("stdin is not valid UTF-8."),
				})
				const tailStream = tail.length > 0 ? processChunk(tail) : Stream.empty
				const finalStream = Stream.unwrap(
					Effect.gen(function* () {
						if (pending.length === 0) {
							return Stream.empty
						}
						const last = pending
						pending = ""
						if (hooks?.onTrailingFlushed !== undefined) {
							yield* hooks.onTrailingFlushed(last)
						}
						return Stream.make(last)
					}),
				)
				return Stream.concat(tailStream, finalStream)
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

const inspectEndedPipedStdin = (stdio: Stdio.Stdio): Effect.Effect<EndedStdinSignal, CliFailure> =>
	Effect.gen(function* () {
		const earlyInput = yield* Deferred.make<EndedStdinSignal>()
		const readLines = Effect.gen(function* () {
			let signal: EndedStdinSignal = { _tag: "eof" }
			yield* splitBoundedLines(stdio.stdin, MAX_MESSAGE_TEXT_LENGTH, {
				onPendingAfterLines: (pending) => {
					const trimmed = pending.trim()
					if (trimmed.length > 0 && !isExitCommandPrefix(trimmed)) {
						return Deferred.succeed(earlyInput, { _tag: "input", line: trimmed }).pipe(
							Effect.asVoid,
						)
					}
					return Effect.void
				},
			}).pipe(
				Stream.takeUntil((line) => line.trim().length > 0),
				Stream.runForEach((line) =>
					Effect.sync(() => {
						const trimmed = line.trim()
						if (trimmed.length === 0) {
							return
						}
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
		const rawSeq = data["seq"]
		const eventSeq = typeof rawSeq === "number" && Number.isInteger(rawSeq) ? rawSeq : undefined
		const eventType = typeof data["type"] === "string" ? data["type"] : event.event

		let formattedError: string | undefined
		let errorRetryStatus: string | undefined
		if (eventType === "session.error") {
			const errObj = isJsonObject(data["error"]) ? data["error"] : undefined
			const errType = typeof errObj?.["type"] === "string" ? errObj["type"] : "session_error"
			const errMsg = typeof errObj?.["message"] === "string" ? errObj["message"] : "Unknown error"
			const retryStatusObj = isJsonObject(errObj?.["retry_status"])
				? errObj["retry_status"]
				: undefined
			errorRetryStatus =
				typeof retryStatusObj?.["type"] === "string" ? retryStatusObj["type"] : undefined
			formattedError = `${errType}: ${errMsg}`
		}

		let stopReason: string | undefined
		if (eventType === "session.status_idle") {
			const rawStopReason = isJsonObject(data["stop_reason"])
				? data["stop_reason"]["type"]
				: undefined
			stopReason = typeof rawStopReason === "string" ? rawStopReason : undefined
		}

		// Check duplicate before emitting output so replayed frames never render twice.
		if (eventSeq !== undefined) {
			const current = yield* Ref.get(stateRef)
			if (eventSeq <= current.lastProcessedSeq) {
				return
			}
		}

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
				if (!rawStructuredMode && formattedError !== undefined) {
					yield* writeStderrLine(`[error] ${formattedError}`)
				}
				break
			}
			case "session.status_idle": {
				if (!rawStructuredMode && stopReason !== undefined && stopReason !== "end_turn") {
					yield* writeStderrLine(`[status: idle (${stopReason})]`)
				}
				break
			}
			case "session.status_terminated":
			case "session.archived": {
				if (!rawStructuredMode) {
					yield* writeStderrLine(
						eventType === "session.archived" ? "[session archived]" : "[session terminated]",
					)
				}
				break
			}
			default:
				break
		}

		const transition = yield* Ref.modify(stateRef, (state) => {
			const res = applySessionEvent(state, {
				seq: eventSeq,
				type: eventType,
				...(stopReason !== undefined ? { stopReason } : {}),
				...(formattedError !== undefined
					? { error: { message: formattedError, retryStatus: errorRetryStatus } }
					: {}),
			})
			return [res, res.state] as const
		})
		if (transition.duplicate) {
			return
		}
		if (transition.shouldWakeWaiter) {
			const settleDeferred = yield* Ref.get(settleDeferredRef)
			yield* Deferred.succeed(settleDeferred, undefined)
		}

		if (eventType === "session.status_terminated" || eventType === "session.archived") {
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
				yield* Ref.update(stateRef, markSessionEnded)
				const settleDeferred = yield* Ref.get(settleDeferredRef)
				yield* Deferred.succeed(settleDeferred, undefined)
				yield* Deferred.succeed(stopConnectDeferred, undefined)
			}
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
		if (trimmed.length === 0) {
			return "continue" as const
		}
		if (trimmed === "/exit" || trimmed === "/quit") {
			return "exit" as const
		}

		if (trimmed === "/interrupt") {
			const key = yield* client.generateIdempotencyKey
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

		const key = yield* client.generateIdempotencyKey
		const sendSnapshot = yield* Ref.modify(stateRef, beginMessageSend)
		const clearSendInFlight = Ref.update(stateRef, cancelMessageSend)
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
		yield* Ref.update(stateRef, (state) => applyMessageReceipt(state, sendSnapshot, receipt))
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
						...(pageCursor > 0 ? { after: pageCursor } : {}),
						limit: 100,
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
								after: pageCursor,
								limit: 100,
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
							query: { limit: 1, order: "desc" },
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

export const connectToSession = (client: CheckfuClient, sessionId: SessionId, after?: number) =>
	Effect.gen(function* () {
		const root = yield* RootCommand
		const stdio = yield* Stdio.Stdio
		const terminal = yield* Terminal.Terminal

		const initialSession = yield* fetchSessionStatusWithRetry(client, sessionId)

		const rawStructuredMode =
			root.format !== "auto" || Option.isSome(root.transform) || root.rawOutput

		let headSeq = 0
		if (after !== undefined && after > 0) {
			const latestPage = yield* client.api.sessions
				.listEvents({
					params: { session_id: sessionId },
					query: { limit: 1, order: "desc" },
				})
				.pipe(Effect.mapError(formatClientError))
			const latestEntry = latestPage.data[0]
			if (latestEntry !== undefined && typeof latestEntry["seq"] === "number") {
				headSeq = latestEntry["seq"]
			}
		}

		const baseline = yield* resolveCursorBaseline(client, sessionId, initialSession, after, headSeq)
		const session = baseline.latestSession
		const initiallyEnded = session.status === "terminated" || session.archived_at !== null
		const isInteractiveTty = yield* stdio.stdinIsTerminal

		yield* writeStderrLine(
			`Connected to ${session.id} (agent ${session.agent.id}@v${session.agent.version}, status: ${session.status}). Type a message, /interrupt, or /exit.`,
		)

		const stateRef = yield* Ref.make<ConnectState>(
			createInitialConnectState({
				trackPipedTurns: !isInteractiveTty,
				status: baseline.status,
				liveStatus: session.status,
				liveTurn: session.turn,
				lastProcessedSeq: after ?? 0,
				observedTurn: baseline.observedTurn,
				settledTurn: baseline.settledTurn,
				ended: initiallyEnded,
			}),
		)

		const settleDeferredRef = yield* Ref.make(yield* Deferred.make<void>())
		const streamFailedRef = yield* Ref.make<CliFailure | null>(null)
		const streamFailedDeferred = yield* Deferred.make<void>()
		const incompleteTurnRef = yield* Ref.make<CliFailure | null>(null)
		const failedTurnRef = yield* Ref.make<CliFailure | null>(null)
		const streamEndedDeferred = yield* Deferred.make<void>()
		const stopConnectDeferred = yield* Deferred.make<void>()
		const expectArchivedEvent = session.archived_at !== null

		const stdinCheckFiber =
			initiallyEnded && !isInteractiveTty
				? yield* Effect.result(inspectEndedPipedStdin(stdio)).pipe(Effect.forkChild)
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
				Effect.catch((error) =>
					Effect.gen(function* () {
						yield* Ref.set(streamFailedRef, error)
						yield* Deferred.succeed(streamFailedDeferred, undefined)
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
						if (nextEvent._tag === "replay_done") {
							break
						}
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
						const streamErr = yield* Ref.get(streamFailedRef)
						if (streamErr !== null) {
							return
						}
						const afterReplay = yield* Effect.race(
							Fiber.join(stdinCheckFiber).pipe(
								Effect.map((outcome) => ({ _tag: "stdin" as const, outcome })),
							),
							Deferred.await(streamFailedDeferred).pipe(
								Effect.as({ _tag: "stream_failed" as const }),
							),
						)
						if (afterReplay._tag === "stdin") {
							yield* handleStdinOutcome(afterReplay.outcome)
						}
					}
				}).pipe(Effect.ensuring(Fiber.interrupt(stdinCheckFiber)))
				return
			}

			if (isInteractiveTty) {
				let interruptedLiveTurn: number | undefined
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
						if (state.ended) {
							break
						}
						const nextEvent = yield* Effect.race(
							Effect.result(terminal.readLine).pipe(
								Effect.map((outcome) => ({ _tag: "line" as const, outcome })),
							),
							Deferred.await(stopConnectDeferred).pipe(Effect.as({ _tag: "ended" as const })),
						)
						if (nextEvent._tag === "ended") {
							break
						}
						if (nextEvent.outcome._tag === "Failure") {
							break
						}
						const dispatchOutcome = yield* Effect.raceFirst(
							dispatchUserLine(client, sessionId, nextEvent.outcome.success, stateRef, {
								reportRecoverableSendErrors: true,
								onInterruptedSend: (failure) => Ref.set(incompleteTurnRef, failure),
							}).pipe(Effect.map((action) => ({ _tag: "action" as const, action }))),
							Deferred.await(stopConnectDeferred).pipe(Effect.as({ _tag: "ended" as const })),
						)
						if (dispatchOutcome._tag === "ended" || dispatchOutcome.action === "exit") {
							break
						}
					}
				})

				yield* withSigintHandler(() => {
					const current = Ref.getUnsafe(stateRef)
					if (shouldInterruptOnCtrlC(current, interruptedLiveTurn)) {
						interruptedLiveTurn = current.liveTurn
						Queue.offerUnsafe(interruptQueue, undefined)
						return true
					}
					return false
				}, ttyLoop).pipe(Effect.ensuring(Fiber.interrupt(interruptWorker)))
				return
			}

			type PipedStdinItem =
				| { readonly _tag: "line"; readonly line: string }
				| { readonly _tag: "eof" }
				| { readonly _tag: "error"; readonly failure: CliFailure }

			let explicitExit = false
			let stdinReachedEof = false
			let pendingPartial = ""
			let postStopPending: Deferred.Deferred<void> | undefined
			const stdinQueue = yield* Queue.bounded<PipedStdinItem>(64)

			const stdinReaderFiber = yield* splitBoundedLines(stdio.stdin, MAX_MESSAGE_TEXT_LENGTH, {
				onChunkParsed: (_lines, pending) => {
					pendingPartial = pending
				},
				onPendingAfterLines: (pending) => {
					pendingPartial = pending
					if (postStopPending !== undefined && pending.trim().length > 0) {
						return Deferred.succeed(postStopPending, undefined).pipe(Effect.asVoid)
					}
					return Effect.void
				},
				onTrailingFlushed: () =>
					Effect.sync(() => {
						pendingPartial = ""
					}),
			}).pipe(
				Stream.runForEach((line) => Queue.offer(stdinQueue, { _tag: "line", line })),
				Effect.andThen(
					Effect.sync(() => {
						stdinReachedEof = true
					}),
				),
				Effect.andThen(Queue.offer(stdinQueue, { _tag: "eof" })),
				Effect.catch((error) => Queue.offer(stdinQueue, { _tag: "error", failure: error })),
				Effect.forkChild,
			)

			const dispatchLoop = Effect.gen(function* () {
				while (true) {
					const item = yield* Queue.take(stdinQueue)
					if (item._tag === "eof") {
						return "stdin_eof" as const
					}
					if (item._tag === "error") {
						return yield* item.failure
					}
					if (explicitExit) {
						return "explicit_exit" as const
					}
					const trimmed = item.line.trim()
					if (trimmed.length === 0) {
						continue
					}
					if (isExitCommand(trimmed)) {
						explicitExit = true
						return "explicit_exit" as const
					}
					const state = yield* Ref.get(stateRef)
					if (state.ended) {
						return yield* networkFailure(
							`Cannot send input: session ${session.id} has already ended.`,
						)
					}
					const action = yield* dispatchUserLine(client, sessionId, item.line, stateRef, {
						failOnInterruptError: true,
						onInterruptedSend: (failure) => Ref.set(incompleteTurnRef, failure),
					})
					if (action === "exit") {
						explicitExit = true
						return "explicit_exit" as const
					}
				}
			})

			const failUnreadBufferedInput = Effect.gen(function* () {
				const currentState = yield* Ref.get(stateRef)
				return yield* networkFailure(
					currentState.ended
						? `Cannot send input: session ${session.id} ended before buffered input was submitted.`
						: "Event stream ended before buffered input was submitted.",
				)
			})

			const inspectPipedItemAfterStop = (
				item: PipedStdinItem,
			): Effect.Effect<"continue" | "done", CliFailure> => {
				if (item._tag === "error") {
					return Effect.fail(item.failure)
				}
				if (item._tag === "eof") {
					stdinReachedEof = true
					return Effect.succeed("done" as const)
				}
				const trimmed = item.line.trim()
				if (trimmed.length === 0) {
					return Effect.succeed("continue" as const)
				}
				if (isExitCommand(trimmed)) {
					explicitExit = true
					return Effect.succeed("done" as const)
				}
				return failUnreadBufferedInput
			}

			yield* Effect.gen(function* () {
				const inputRaceOutcome = yield* Effect.raceFirst(
					dispatchLoop,
					Deferred.await(stopConnectDeferred).pipe(Effect.as("stopped" as const)),
				)
				if (inputRaceOutcome !== "stopped" || explicitExit) {
					return
				}
				const streamErr = yield* Ref.get(streamFailedRef)
				const existingIncomplete = yield* Ref.get(incompleteTurnRef)
				if (streamErr !== null || existingIncomplete !== null) {
					return
				}

				// First inspect anything already pulled by the concurrent stdin reader.
				const bufferedItems = yield* Queue.clear(stdinQueue)
				for (const item of bufferedItems) {
					if ((yield* inspectPipedItemAfterStop(item)) === "done") {
						return
					}
				}
				const trimmedPending = pendingPartial.trim()
				if (trimmedPending.length > 0 && !isExitCommand(trimmedPending)) {
					return yield* failUnreadBufferedInput
				}
				if (stdinReachedEof) {
					return
				}

				// The dispatch loop was cancelled before stdin reached EOF; briefly probe the
				// still-attached stdin reader so unread input waiting in the next pipe chunk
				// is detected rather than silently dropped with exit code 0.
				const pendingSignal = yield* Deferred.make<void>()
				postStopPending = pendingSignal
				if (pendingPartial.trim().length > 0) {
					yield* Deferred.succeed(pendingSignal, undefined)
				}
				const probeDeadline = yield* Deferred.make<void>()
				const probeTimer = yield* Effect.sleep(Duration.millis(50)).pipe(
					Effect.andThen(Deferred.succeed(probeDeadline, undefined)),
					Effect.forkChild,
				)
				yield* Effect.gen(function* () {
					while (!stdinReachedEof) {
						const probed = yield* Effect.race(
							Queue.take(stdinQueue).pipe(Effect.map((item) => ({ _tag: "item" as const, item }))),
							Effect.race(
								Deferred.await(pendingSignal).pipe(Effect.as({ _tag: "pending" as const })),
								Deferred.await(probeDeadline).pipe(Effect.as({ _tag: "idle" as const })),
							),
						)
						if (probed._tag === "item") {
							if ((yield* inspectPipedItemAfterStop(probed.item)) === "done") {
								return
							}
							continue
						}
						const pendingNow = pendingPartial.trim()
						if (probed._tag === "pending") {
							if (pendingNow.length > 0 && !isExitCommandPrefix(pendingNow)) {
								return yield* failUnreadBufferedInput
							}
							// Wait for either the line/EOF to arrive or the probe window to finish
							const afterPrefix = yield* Effect.race(
								Queue.take(stdinQueue).pipe(
									Effect.map((item) => ({ _tag: "item" as const, item })),
								),
								Deferred.await(probeDeadline).pipe(Effect.as({ _tag: "idle" as const })),
							)
							if (afterPrefix._tag === "item") {
								if ((yield* inspectPipedItemAfterStop(afterPrefix.item)) === "done") {
									return
								}
								continue
							}
						}
						const finalPending = pendingPartial.trim()
						if (finalPending.length > 0 && !isExitCommand(finalPending)) {
							return yield* failUnreadBufferedInput
						}
						return
					}
				}).pipe(Effect.ensuring(Fiber.interrupt(probeTimer)))
			}).pipe(Effect.ensuring(Fiber.interrupt(stdinReaderFiber)))

			if (!explicitExit) {
				while (true) {
					const waiter = yield* Deferred.make<void>()
					yield* Ref.set(settleDeferredRef, waiter)

					const failed = yield* Ref.get(streamFailedRef)
					if (failed !== null) {
						break
					}
					let currentState = yield* Ref.get(stateRef)
					const settlementAction = evaluatePipedSettlement(currentState)
					if (settlementAction === "ended" || settlementAction === "settled") {
						break
					}
					if (settlementAction === "check_halted_queue") {
						let haltedQueuedTurn = false
						for (let checkAttempt = 0; ; checkAttempt++) {
							const lookupFiber = yield* Effect.result(
								fetchSessionStatusWithRetry(client, sessionId),
							).pipe(Effect.forkChild)
							const lookupRace = yield* Effect.race(
								Fiber.join(lookupFiber).pipe(
									Effect.map((result) => ({ _tag: "lookup" as const, result })),
								),
								Effect.race(
									Deferred.await(waiter).pipe(Effect.as({ _tag: "event" as const })),
									Deferred.await(stopConnectDeferred).pipe(Effect.as({ _tag: "event" as const })),
								),
							).pipe(Effect.ensuring(Fiber.interrupt(lookupFiber)))
							if (lookupRace._tag === "event") {
								break
							}
							const latestRes = lookupRace.result
							const refreshed = yield* Ref.get(stateRef)
							if (latestRes._tag === "Failure") {
								if (evaluatePipedSettlement(refreshed) !== "check_halted_queue") {
									break
								}
								yield* Ref.set(incompleteTurnRef, latestRes.failure)
								haltedQueuedTurn = true
								break
							}
							const decision = evaluateHaltedQueueSnapshot(
								currentState,
								refreshed,
								latestRes.success,
								checkAttempt >= MAX_QUEUED_TURN_PROJECTION_RETRIES,
							)
							if (decision.action === "continue_waiting") {
								break
							}
							if (decision.action === "fail") {
								yield* Ref.set(incompleteTurnRef, networkFailure(decision.message))
								haltedQueuedTurn = true
								break
							}
							const delayMs = QUEUED_TURN_PROJECTION_RETRY_BASE_MS * 2 ** checkAttempt
							const waitRace = yield* Effect.race(
								Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as("retry" as const)),
								Effect.race(
									Deferred.await(waiter).pipe(Effect.as("event" as const)),
									Deferred.await(stopConnectDeferred).pipe(Effect.as("event" as const)),
								),
							)
							if (waitRace === "event") {
								break
							}
						}
						if (haltedQueuedTurn) {
							break
						}
						const failedAfterLookup = yield* Ref.get(streamFailedRef)
						if (failedAfterLookup !== null) {
							break
						}
						currentState = yield* Ref.get(stateRef)
						const afterLookupAction = evaluatePipedSettlement(currentState)
						if (afterLookupAction === "ended" || afterLookupAction === "settled") {
							break
						}
					}
					if (yield* Deferred.isDone(streamEndedDeferred)) {
						const failedAtEnd = yield* Ref.get(streamFailedRef)
						if (failedAtEnd === null) {
							const stateAtEnd = yield* Ref.get(stateRef)
							const streamEndedError = resolveStreamEndedError(stateAtEnd)
							if (streamEndedError !== undefined) {
								yield* Ref.set(incompleteTurnRef, networkFailure(streamEndedError))
							}
						}
						break
					}
					if (currentState.targetTurn === 0) {
						break
					}
					const outcome = yield* Effect.race(
						Deferred.await(waiter).pipe(Effect.as("settled" as const)),
						Deferred.await(stopConnectDeferred).pipe(Effect.as("stopped" as const)),
					)
					if (outcome === "stopped") {
						const failedAfter = yield* Ref.get(streamFailedRef)
						if (failedAfter === null) {
							const afterStream = yield* Ref.get(stateRef)
							const streamEndedError = resolveStreamEndedError(afterStream)
							if (streamEndedError !== undefined) {
								yield* Ref.set(incompleteTurnRef, networkFailure(streamEndedError))
							}
						}
						break
					}
				}

				const finalState = yield* Ref.get(stateRef)
				const finalError = resolveFinalPipedError(finalState)
				if (finalError !== undefined) {
					yield* Ref.set(failedTurnRef, networkFailure(finalError))
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
	})

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
			return yield* connectToSession(
				yield* getClient,
				sessionId,
				Option.getOrUndefined(input.after),
			)
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
