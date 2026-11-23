/**
 * Pure turn-tracking state machine for `sessions connect`.
 *
 * Input proof rules preserved by every transition:
 * 1. Replayed SSE frames (`data.seq <= lastProcessedSeq`) prove nothing new and
 *    must never update turn counters, settle another turn, record errors, or wake waiters.
 * 2. A `user.message` receipt `{ turn, queued }` proves server acceptance for `turn`:
 *    - `queued === false`: server started `turn` from idle. Updates live status to
 *      `running` only if `liveTurn < turn` and session is not terminated; clears any
 *      stale queued marker for `turn`.
 *    - `queued === true`: server queued `turn` behind active predecessor `turn - 1`.
 *      Never claims `turn` itself is running; only infers predecessor `turn - 1` is
 *      running if `liveTurn < turn - 1` (so a delayed receipt arriving after SSE
 *      already delivered `idle` for `turn - 1` never flips `liveStatus` back to `running`).
 *    - `queued === undefined` (legacy receipt): infers started-from-idle only when
 *      the pre-send snapshot was idle and `turn === liveTurn + 1` with no intervening
 *      live state transition.
 * 3. SSE `session.status_running` / `session.status_idle` advance the replay cursor
 *    (`observedTurn` / `settledTurn`) and advance `(liveStatus, liveTurn)` only when
 *    catching up to or passing `liveTurn`.
 * 4. SSE `session.error` records turn error context without failing the turn until
 *    `session.status_idle(retries_exhausted)` or `session.status_terminated` with
 *    `retry_status === "terminal"`.
 * 5. A GET `/sessions/:id` snapshot may lag behind SSE; it can only confirm a queued
 *    turn did not start when `state` still shows that turn queued and unobserved,
 *    never overriding SSE progress or a `queued: false` receipt.
 */

export interface TurnFailure {
	readonly turn: number
	readonly message: string
}

export interface TurnErrorSnapshot {
	readonly turn: number
	readonly message: string
	readonly retryStatus: string | undefined
}

export interface ConnectState {
	readonly trackPipedTurns: boolean
	readonly status: "idle" | "running" | "terminated"
	readonly liveStatus: "idle" | "running" | "terminated"
	readonly liveTurn: number
	readonly liveStateVersion: number
	readonly lastProcessedSeq: number
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

export interface SendSnapshot {
	readonly liveStatus: ConnectState["liveStatus"]
	readonly liveTurn: number
	readonly liveStateVersion: number
}

export interface SubmittedMessageReceipt {
	readonly turn: number
	readonly queued: boolean | undefined
}

export interface SessionSnapshotSummary {
	readonly status: "idle" | "running" | "terminated"
	readonly turn: number
}

export interface ConnectSessionEvent {
	readonly seq: number | undefined
	readonly type: string
	readonly stopReason?: string | undefined
	readonly error?:
		| {
				readonly message: string
				readonly retryStatus: string | undefined
		  }
		| undefined
}

export interface EventTransitionResult {
	readonly state: ConnectState
	readonly duplicate: boolean
	readonly shouldWakeWaiter: boolean
}

export type PipedSettlementAction = "ended" | "settled" | "check_halted_queue" | "wait"

export type HaltedQueueSnapshotDecision =
	| { readonly action: "continue_waiting" }
	| { readonly action: "retry_snapshot" }
	| { readonly action: "fail"; readonly message: string }

export const createInitialConnectState = (init: {
	readonly trackPipedTurns: boolean
	readonly status: ConnectState["status"]
	readonly liveStatus: ConnectState["liveStatus"]
	readonly liveTurn: number
	readonly lastProcessedSeq: number
	readonly observedTurn: number
	readonly settledTurn: number
	readonly ended: boolean
}): ConnectState => ({
	trackPipedTurns: init.trackPipedTurns,
	status: init.status,
	liveStatus: init.liveStatus,
	liveTurn: init.liveTurn,
	liveStateVersion: 0,
	lastProcessedSeq: init.lastProcessedSeq,
	observedTurn: init.observedTurn,
	settledTurn: init.settledTurn,
	latestSettledStopReason: undefined,
	targetTurn: 0,
	unsettledSubmittedTurns: new Set<number>(),
	unsettledQueuedTurns: new Set<number>(),
	firstSubmittedTurnFailure: undefined,
	pendingTurnErrors: new Map<number, string>(),
	sendInFlight: false,
	latestTurnError: undefined,
	ended: init.ended,
})

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

export const extractSubmittedMessageReceipt = (
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

export const hasInterruptReceipt = (data: ReadonlyArray<unknown>): boolean => {
	const first = data[0]
	if (typeof first !== "object" || first === null) return false
	return (first as Record<string, unknown>)["type"] === "user.interrupt"
}

export const isQueueHaltingStopReason = (stopReason: string | undefined): boolean =>
	stopReason !== undefined &&
	stopReason !== "end_turn" &&
	stopReason !== "interrupted" &&
	stopReason !== "retries_exhausted"

export const beginMessageSend = (state: ConnectState): readonly [SendSnapshot, ConnectState] => [
	{
		liveStatus: state.liveStatus,
		liveTurn: state.liveTurn,
		liveStateVersion: state.liveStateVersion,
	},
	state.trackPipedTurns ? { ...state, sendInFlight: true } : state,
]

export const cancelMessageSend = (state: ConnectState): ConnectState =>
	state.trackPipedTurns
		? {
				...state,
				sendInFlight: false,
				pendingTurnErrors: pruneSettledErrors(state.pendingTurnErrors, state.settledTurn),
			}
		: state

export const applyMessageReceipt = (
	state: ConnectState,
	sendSnapshot: SendSnapshot,
	receipt: SubmittedMessageReceipt,
): ConnectState => {
	const { turn, queued } = receipt
	const initiatedFromIdle =
		queued !== undefined
			? !queued
			: sendSnapshot.liveStatus === "idle" && turn === sendSnapshot.liveTurn + 1
	const startedNow =
		state.liveStatus !== "terminated" &&
		(queued === false
			? state.liveTurn < turn
			: initiatedFromIdle &&
				state.liveStateVersion === sendSnapshot.liveStateVersion &&
				state.liveStatus === "idle")
	const predecessorRunning =
		!startedNow &&
		state.liveStatus !== "terminated" &&
		!initiatedFromIdle &&
		turn >= 2 &&
		state.liveTurn < turn - 1
	const liveChanged = startedNow || predecessorRunning
	const nextLiveStatus = liveChanged ? ("running" as const) : state.liveStatus
	const nextLiveTurn = startedNow ? turn : predecessorRunning ? turn - 1 : state.liveTurn
	const nextLiveStateVersion = liveChanged ? state.liveStateVersion + 1 : state.liveStateVersion

	if (!state.trackPipedTurns) {
		return liveChanged
			? {
					...state,
					liveStatus: nextLiveStatus,
					liveTurn: nextLiveTurn,
					liveStateVersion: nextLiveStateVersion,
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
	if (!initiatedFromIdle && turn > state.settledTurn) {
		if (!unsettledQueuedTurns.has(turn)) {
			const nextQueued = new Set(unsettledQueuedTurns)
			nextQueued.add(turn)
			unsettledQueuedTurns = nextQueued
		}
	} else if (initiatedFromIdle && unsettledQueuedTurns.has(turn)) {
		const nextQueued = new Set(unsettledQueuedTurns)
		nextQueued.delete(turn)
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
		liveStatus: nextLiveStatus,
		liveTurn: nextLiveTurn,
		liveStateVersion: nextLiveStateVersion,
	}
}

export const applySessionEvent = (
	state: ConnectState,
	event: ConnectSessionEvent,
): EventTransitionResult => {
	if (event.seq !== undefined && event.seq <= state.lastProcessedSeq) {
		return { state, duplicate: true, shouldWakeWaiter: false }
	}
	const baseState: ConnectState =
		event.seq !== undefined ? { ...state, lastProcessedSeq: event.seq } : state

	switch (event.type) {
		case "session.status_running": {
			const nextObserved = baseState.observedTurn + 1
			const reachedLive = nextObserved > baseState.liveTurn
			const next: ConnectState = {
				...baseState,
				status: "running",
				observedTurn: nextObserved,
				liveStatus: reachedLive ? "running" : baseState.liveStatus,
				liveTurn: reachedLive ? nextObserved : baseState.liveTurn,
				liveStateVersion: reachedLive ? baseState.liveStateVersion + 1 : baseState.liveStateVersion,
			}
			const shouldWakeWaiter =
				next.trackPipedTurns &&
				next.targetTurn > 0 &&
				next.observedTurn >= next.targetTurn &&
				next.unsettledQueuedTurns.has(next.targetTurn)
			return { state: next, duplicate: false, shouldWakeWaiter }
		}
		case "session.error": {
			if (!baseState.trackPipedTurns || event.error === undefined) {
				return { state: baseState, duplicate: false, shouldWakeWaiter: false }
			}
			return {
				state: {
					...baseState,
					latestTurnError: {
						turn: baseState.observedTurn,
						message: event.error.message,
						retryStatus: event.error.retryStatus,
					},
				},
				duplicate: false,
				shouldWakeWaiter: false,
			}
		}
		case "session.status_idle": {
			const stopReason = event.stopReason
			const turn = baseState.observedTurn
			const nextSettledTurn = Math.max(baseState.settledTurn, turn)
			const latestSettledStopReason =
				turn >= baseState.settledTurn ? stopReason : baseState.latestSettledStopReason
			const reachedLiveIdle =
				turn > baseState.liveTurn ||
				(turn === baseState.liveTurn && baseState.liveStatus === "running")

			if (!baseState.trackPipedTurns) {
				return {
					state: {
						...baseState,
						status: "idle",
						liveStatus: turn >= baseState.liveTurn ? "idle" : baseState.liveStatus,
						liveTurn: Math.max(baseState.liveTurn, turn),
						liveStateVersion: reachedLiveIdle
							? baseState.liveStateVersion + 1
							: baseState.liveStateVersion,
						settledTurn: nextSettledTurn,
						latestSettledStopReason,
					},
					duplicate: false,
					shouldWakeWaiter: false,
				}
			}

			let firstSubmittedTurnFailure = baseState.firstSubmittedTurnFailure
			let pendingTurnErrors = baseState.pendingTurnErrors
			if (stopReason === "retries_exhausted") {
				const turnError =
					(baseState.latestTurnError?.turn === turn
						? baseState.latestTurnError.message
						: undefined) ?? "Model retries exhausted."
				if (baseState.unsettledSubmittedTurns.has(turn)) {
					firstSubmittedTurnFailure = recordFirstFailure(firstSubmittedTurnFailure, turn, turnError)
				} else if (baseState.sendInFlight) {
					const nextPending = new Map(pendingTurnErrors)
					nextPending.set(turn, turnError)
					pendingTurnErrors = nextPending
				}
			}
			if (!baseState.sendInFlight) {
				pendingTurnErrors = pruneSettledErrors(pendingTurnErrors, nextSettledTurn)
			}

			const next: ConnectState = {
				...baseState,
				status: "idle",
				liveStatus: turn >= baseState.liveTurn ? "idle" : baseState.liveStatus,
				liveTurn: Math.max(baseState.liveTurn, turn),
				liveStateVersion: reachedLiveIdle
					? baseState.liveStateVersion + 1
					: baseState.liveStateVersion,
				settledTurn: nextSettledTurn,
				latestSettledStopReason,
				unsettledSubmittedTurns: pruneSettledTurns(
					baseState.unsettledSubmittedTurns,
					nextSettledTurn,
				),
				unsettledQueuedTurns: pruneSettledTurns(baseState.unsettledQueuedTurns, nextSettledTurn),
				firstSubmittedTurnFailure,
				pendingTurnErrors,
				latestTurnError:
					baseState.latestTurnError?.turn === turn ? undefined : baseState.latestTurnError,
			}
			const shouldWakeWaiter =
				(next.targetTurn > 0 && next.settledTurn >= next.targetTurn) ||
				(next.unsettledQueuedTurns.has(next.targetTurn) &&
					next.settledTurn === next.targetTurn - 1 &&
					isQueueHaltingStopReason(stopReason))
			return { state: next, duplicate: false, shouldWakeWaiter }
		}
		case "session.status_terminated":
		case "session.archived": {
			if (!baseState.trackPipedTurns) {
				return {
					state: {
						...baseState,
						status: "terminated",
						liveStatus: "terminated",
						liveStateVersion: baseState.liveStateVersion + 1,
					},
					duplicate: false,
					shouldWakeWaiter: false,
				}
			}
			let firstSubmittedTurnFailure = baseState.firstSubmittedTurnFailure
			let pendingTurnErrors = baseState.pendingTurnErrors
			if (
				event.type === "session.status_terminated" &&
				baseState.observedTurn > baseState.settledTurn &&
				baseState.latestTurnError?.turn === baseState.observedTurn &&
				baseState.latestTurnError.retryStatus === "terminal"
			) {
				const turn = baseState.observedTurn
				const turnError = baseState.latestTurnError.message
				if (baseState.unsettledSubmittedTurns.has(turn)) {
					firstSubmittedTurnFailure = recordFirstFailure(firstSubmittedTurnFailure, turn, turnError)
				} else if (baseState.sendInFlight) {
					const nextPending = new Map(pendingTurnErrors)
					nextPending.set(turn, turnError)
					pendingTurnErrors = nextPending
				}
			}
			return {
				state: {
					...baseState,
					status: "terminated",
					liveStatus: "terminated",
					liveStateVersion: baseState.liveStateVersion + 1,
					firstSubmittedTurnFailure,
					pendingTurnErrors,
				},
				duplicate: false,
				shouldWakeWaiter: false,
			}
		}
		default:
			return { state: baseState, duplicate: false, shouldWakeWaiter: false }
	}
}

export const markSessionEnded = (state: ConnectState): ConnectState =>
	state.ended ? state : { ...state, ended: true }

export const shouldInterruptOnCtrlC = (
	state: ConnectState,
	interruptRequestedOnce: boolean,
): boolean => state.liveStatus === "running" && !interruptRequestedOnce

export const evaluatePipedSettlement = (state: ConnectState): PipedSettlementAction => {
	if (state.ended) return "ended"
	if (state.targetTurn > 0 && state.settledTurn >= state.targetTurn) return "settled"
	if (
		state.status === "idle" &&
		state.unsettledQueuedTurns.has(state.targetTurn) &&
		state.settledTurn === state.targetTurn - 1 &&
		state.observedTurn < state.targetTurn &&
		isQueueHaltingStopReason(state.latestSettledStopReason)
	) {
		return "check_halted_queue"
	}
	return "wait"
}

export const evaluateHaltedQueueSnapshot = (
	checkedState: ConnectState,
	refreshedState: ConnectState,
	snapshot: SessionSnapshotSummary,
	retriesExhausted: boolean,
): HaltedQueueSnapshotDecision => {
	// Never let a stale GET snapshot override SSE progress or a newer queued:false receipt
	if (
		refreshedState.ended ||
		refreshedState.observedTurn >= checkedState.targetTurn ||
		refreshedState.settledTurn >= checkedState.targetTurn ||
		!refreshedState.unsettledQueuedTurns.has(checkedState.targetTurn)
	) {
		return { action: "continue_waiting" }
	}
	if (snapshot.turn >= checkedState.targetTurn) {
		return { action: "continue_waiting" }
	}
	const haltedMessage = `Queued turn ${checkedState.targetTurn} did not start because turn ${checkedState.settledTurn} stopped with ${checkedState.latestSettledStopReason}.`
	if (snapshot.status !== "running") {
		return { action: "fail", message: haltedMessage }
	}
	if (retriesExhausted) {
		return { action: "fail", message: haltedMessage }
	}
	return { action: "retry_snapshot" }
}

export const resolveFinalPipedError = (state: ConnectState): string | undefined => {
	let lowestUnsettled: number | undefined
	for (const turn of state.unsettledSubmittedTurns) {
		if (lowestUnsettled === undefined || turn < lowestUnsettled) {
			lowestUnsettled = turn
		}
	}
	if (
		state.firstSubmittedTurnFailure !== undefined &&
		(lowestUnsettled === undefined || state.firstSubmittedTurnFailure.turn <= lowestUnsettled)
	) {
		return `Turn ${state.firstSubmittedTurnFailure.turn} failed: ${state.firstSubmittedTurnFailure.message}`
	}
	if (lowestUnsettled !== undefined) {
		return state.ended
			? `Session terminated before turn ${lowestUnsettled} completed.`
			: `Turn ${lowestUnsettled} did not complete.`
	}
	return undefined
}
