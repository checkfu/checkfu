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

interface LocalSentMessage {
	readonly id: string
	readonly text: string
	readonly minSeq: number
}

interface ConnectState {
	readonly status: "idle" | "running" | "terminated"
	readonly liveStatus: "idle" | "running" | "terminated"
	readonly liveTurn: number
	readonly liveStateVersion: number
	readonly connectHeadSeq: number
	readonly lastObservedSeq: number
	readonly observedTurn: number
	readonly settledTurn: number
	readonly latestSettledStopReason: string | undefined
	readonly targetTurn: number
	readonly submittedTurns: ReadonlySet<number>
	readonly queuedTurns: ReadonlySet<number>
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
	(status >= 200 && status < 300) || isTransientHttpStatus(status)

const extractSubmittedTurn = (data: ReadonlyArray<unknown>): number | undefined => {
	const first = data[0]
	if (typeof first !== "object" || first === null) return undefined
	const record = first as Record<string, unknown>
	if (record["type"] !== undefined && record["type"] !== "user.message") return undefined
	const turn = record["turn"]
	return typeof turn === "number" && Number.isInteger(turn) && turn >= 1 ? turn : undefined
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
		return err.unconfirmed_index !== undefined || status === 429 || status >= 500
	}
	return Schema.isSchemaError(err)
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

const sendConnectEventsWithRetry = <A>(
	send: Effect.Effect<A, Parameters<typeof formatClientError>[0]>,
	idempotencyKey: string,
): Effect.Effect<A, CliFailure> =>
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
				if (attempt < MAX_CONNECT_SEND_RETRIES) {
					yield* Effect.sleep(Duration.millis(CONNECT_SEND_RETRY_BASE_MS * 2 ** attempt))
					continue
				}
			}
			return yield* formatUnconfirmedSendError(err, idempotencyKey, hadUnconfirmedAttempt)
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

const splitBoundedLines = (
	stdin: Stdio.Stdio["stdin"],
	maxLineChars: number,
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
					const emitted =
						lines.length > 0 ? Stream.fromIterable(lines).pipe(Stream.rechunk(1)) : Stream.empty
					return overflowed ? Stream.concat(emitted, Stream.fail(lineTooLongError())) : emitted
				}),
			)

		const body = stdin.pipe(
			Stream.mapError((err) => usageError(`Failed to read stdin: ${err.message}`)),
			Stream.decodeText(),
			Stream.flatMap(processChunk),
		)

		const flushTrailing = Stream.unwrap(
			Effect.sync(() => {
				if (pending.length === 0) return Stream.empty
				const last = pending
				pending = ""
				return Stream.make(last)
			}),
		)

		return Stream.concat(body, flushTrailing)
	})

const findFirstSendablePipedLine = (
	stdio: Stdio.Stdio,
): Effect.Effect<Option.Option<string>, CliFailure> =>
	Effect.gen(function* () {
		let firstSendable: Option.Option<string> = Option.none()
		yield* splitBoundedLines(stdio.stdin, MAX_MESSAGE_TEXT_LENGTH).pipe(
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
					const reachedLiveIdle =
						turn > state.liveTurn || (turn === state.liveTurn && state.liveStatus === "running")
					return {
						...state,
						status: "idle" as const,
						liveStatus: turn >= state.liveTurn ? ("idle" as const) : state.liveStatus,
						liveTurn: Math.max(state.liveTurn, turn),
						liveStateVersion: reachedLiveIdle ? state.liveStateVersion + 1 : state.liveStateVersion,
						settledTurn: Math.max(state.settledTurn, turn),
						latestSettledStopReason,
						latestTurnError:
							state.latestTurnError?.turn === turn ? undefined : state.latestTurnError,
						failedTurnErrors,
					}
				})
				if (!rawStructuredMode && stopReason !== undefined && stopReason !== "end_turn") {
					yield* writeStderrLine(`[status: idle (${stopReason})]`)
				}
				if (
					(next.targetTurn > 0 && next.settledTurn >= next.targetTurn) ||
					(next.queuedTurns.has(next.targetTurn) &&
						next.settledTurn === next.targetTurn - 1 &&
						isQueueHaltingStopReason(stopReason))
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
						state.observedTurn > state.settledTurn &&
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
						liveStateVersion: state.liveStateVersion + 1,
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
	options?: {
		readonly failOnInterruptError?: boolean
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
		const sendSnapshot = yield* Ref.modify(
			stateRef,
			(state) =>
				[
					{
						liveStatus: state.liveStatus,
						liveTurn: state.liveTurn,
						liveStateVersion: state.liveStateVersion,
					},
					{
						...state,
						localSentMessages: [
							...state.localSentMessages,
							{
								id: key,
								text: line,
								minSeq: Math.max(state.connectHeadSeq, state.lastObservedSeq),
							},
						],
					},
				] as const,
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
						Ref.update(stateRef, (state) => ({
							...state,
							localSentMessages: state.localSentMessages.filter((entry) => entry.id !== key),
						})),
						writeStderrLine(msg).pipe(Effect.ignore),
						options?.onInterruptedSend !== undefined
							? options.onInterruptedSend(networkFailure(msg))
							: Effect.void,
					])
				}),
			),
		)
		if (res._tag === "Failure") {
			yield* Ref.update(stateRef, (state) => ({
				...state,
				localSentMessages: state.localSentMessages.filter((entry) => entry.id !== key),
			}))
			return yield* res.failure
		}
		const turn = extractSubmittedTurn(res.success.data)
		if (turn === undefined) {
			yield* Ref.update(stateRef, (state) => ({
				...state,
				localSentMessages: state.localSentMessages.filter((entry) => entry.id !== key),
			}))
			return yield* networkFailure(
				`Message response did not confirm a valid turn (delivery unconfirmed; retry safely with Idempotency-Key: ${key})`,
			)
		}
		yield* Ref.update(stateRef, (state) => {
			const nextSubmitted = new Set(state.submittedTurns)
			nextSubmitted.add(turn)
			const initiatedFromIdle =
				sendSnapshot.liveStatus === "idle" && turn === sendSnapshot.liveTurn + 1
			const nextQueued = new Set(state.queuedTurns)
			if (!initiatedFromIdle) {
				nextQueued.add(turn)
			}
			const startedFromIdle =
				initiatedFromIdle &&
				state.liveStateVersion === sendSnapshot.liveStateVersion &&
				state.liveStatus === "idle"
			return {
				...state,
				targetTurn: Math.max(state.targetTurn, turn),
				submittedTurns: nextSubmitted,
				queuedTurns: nextQueued,
				liveStatus: startedFromIdle ? ("running" as const) : state.liveStatus,
				liveTurn: startedFromIdle ? turn : state.liveTurn,
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
		readonly connectHeadSeq: number
	},
	CliFailure
> => {
	if (after === undefined || after === 0) {
		return Effect.succeed({
			status: "idle" as const,
			observedTurn: 0,
			settledTurn: 0,
			latestSession: initialSession,
			connectHeadSeq: headSeq,
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
		// scan only the suffix (after, head] and reconcile against a consistent head snapshot.
		if (headSeq - after <= after) {
			let before = initialSession
			let latestHeadSeq = headSeq
			for (let attempt = 0; attempt < MAX_SUFFIX_CONSISTENCY_ATTEMPTS; attempt++) {
				let pageCursor = after
				let runningAfter = 0
				let firstStatusAfter:
					| "session.status_running"
					| "session.status_idle"
					| "session.status_terminated"
					| "session.archived"
					| undefined

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
					for (const entry of page.data) {
						const seq = typeof entry["seq"] === "number" ? entry["seq"] : undefined
						if (seq !== undefined) {
							latestHeadSeq = Math.max(latestHeadSeq, seq)
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
					if (!page.has_more || page.next_cursor === null) {
						break
					}
					pageCursor = page.next_cursor
				}

				const afterSnap = yield* fetchSessionStatusWithRetry(client, sessionId)
				const consistent =
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
						connectHeadSeq: latestHeadSeq,
					}
				}
				before = afterSnap
			}
		}

		const prefix = yield* resolveCursorBaselineFromPrefix(client, sessionId, after)
		return {
			...prefix,
			latestSession: initialSession,
			connectHeadSeq: headSeq,
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
			const initialEnded =
				initialSession.status === "terminated" || initialSession.archived_at !== null
			let headSeq = 0
			if ((after !== undefined && after > 0) || !initialEnded) {
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
			const connectHeadSeq = Math.max(after ?? 0, baseline.connectHeadSeq)
			const initiallyEnded = session.status === "terminated" || session.archived_at !== null
			const isInteractiveTty = yield* stdio.stdinIsTerminal

			yield* writeStderrLine(
				`Connected to ${session.id} (agent ${session.agent.id}@v${session.agent.version}, status: ${session.status}). Type a message, /interrupt, or /exit.`,
			)

			const stateRef = yield* Ref.make<ConnectState>({
				status: baseline.status,
				liveStatus: session.status,
				liveTurn: session.turn,
				liveStateVersion: 0,
				connectHeadSeq,
				lastObservedSeq: after ?? 0,
				observedTurn: baseline.observedTurn,
				settledTurn: baseline.settledTurn,
				latestSettledStopReason: undefined,
				targetTurn: 0,
				submittedTurns: new Set<number>(),
				queuedTurns: new Set<number>(),
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

			const stdinCheckFiber =
				initiallyEnded && !isInteractiveTty
					? yield* Effect.result(findFirstSendablePipedLine(stdio)).pipe(Effect.forkChild)
					: undefined

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
					const replayDone =
						session.archived_at !== null
							? Deferred.await(streamEndedDeferred)
							: baseline.status !== "terminated"
								? Deferred.await(stopConnectDeferred)
								: Effect.void

					if (stdinCheckFiber === undefined) {
						yield* replayDone
						return
					}

					const unsentInputError = networkFailure(
						`Cannot send input: session ${session.id} is already ${session.archived_at !== null ? "archived" : "terminated"}.`,
					)
					const handleStdinOutcome = (
						outcome:
							| { readonly _tag: "Success"; readonly success: Option.Option<string> }
							| { readonly _tag: "Failure"; readonly failure: CliFailure },
					): Effect.Effect<void, CliFailure> =>
						outcome._tag === "Failure"
							? Effect.fail(outcome.failure)
							: Option.isSome(outcome.success)
								? Effect.fail(unsentInputError)
								: Effect.void

					yield* Effect.gen(function* () {
						const first = yield* Effect.race(
							Fiber.join(stdinCheckFiber).pipe(
								Effect.map((outcome) => ({ _tag: "stdin" as const, outcome })),
							),
							replayDone.pipe(Effect.as({ _tag: "replay_done" as const })),
						)
						if (first._tag === "stdin") {
							yield* handleStdinOutcome(first.outcome)
							yield* replayDone
						} else {
							const lateStdin = yield* Effect.race(
								Fiber.join(stdinCheckFiber).pipe(Effect.map(Option.some)),
								Effect.sleep("20 millis").pipe(Effect.as(Option.none())),
							)
							if (Option.isSome(lateStdin)) {
								yield* handleStdinOutcome(lateStdin.value)
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
				const pipedInputEffect = splitBoundedLines(stdio.stdin, MAX_MESSAGE_TEXT_LENGTH).pipe(
					Stream.takeUntil((line) => {
						const trimmed = line.trim()
						return trimmed === "/exit" || trimmed === "/quit"
					}),
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
								onInterruptedSend: (failure) => Ref.set(incompleteTurnRef, failure),
							})
							if (action === "exit") {
								explicitExit = true
							}
						}),
					),
				)
				yield* Effect.raceFirst(pipedInputEffect, Deferred.await(stopConnectDeferred))

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
							state.queuedTurns.has(state.targetTurn) &&
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
