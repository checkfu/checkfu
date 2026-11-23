import { describe, expect, it } from "@effect/vitest"
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
} from "../src/Commands/SessionsConnectState.ts"
import type {
	ConnectSessionEvent,
	ConnectState,
	SendSnapshot,
	SessionSnapshotSummary,
	SubmittedMessageReceipt,
} from "../src/Commands/SessionsConnectState.ts"

type Step =
	| { readonly _tag: "begin_send"; readonly label: string }
	| { readonly _tag: "receipt"; readonly label: string; readonly receipt: SubmittedMessageReceipt }
	| { readonly _tag: "cancel_send" }
	| { readonly _tag: "event"; readonly event: ConnectSessionEvent }
	| { readonly _tag: "mark_ended" }

interface SequenceRunResult {
	readonly state: ConnectState
	readonly duplicates: ReadonlyArray<number | undefined>
	readonly wokeAtEvents: ReadonlyArray<number | undefined>
}

const runSequence = (initial: ConnectState, steps: ReadonlyArray<Step>): SequenceRunResult => {
	let state = initial
	const snapshots = new Map<string, SendSnapshot>()
	const duplicates: Array<number | undefined> = []
	const wokeAtEvents: Array<number | undefined> = []
	for (const step of steps) {
		switch (step._tag) {
			case "begin_send": {
				const [snap, next] = beginMessageSend(state)
				snapshots.set(step.label, snap)
				state = next
				break
			}
			case "receipt": {
				const snap = snapshots.get(step.label)
				if (snap === undefined) {
					throw new Error(`Missing begin_send snapshot for label "${step.label}"`)
				}
				state = applyMessageReceipt(state, snap, step.receipt)
				break
			}
			case "cancel_send": {
				state = cancelMessageSend(state)
				break
			}
			case "event": {
				const res = applySessionEvent(state, step.event)
				state = res.state
				if (res.duplicate) {
					duplicates.push(step.event.seq)
				}
				if (res.shouldWakeWaiter) {
					wokeAtEvents.push(step.event.seq)
				}
				break
			}
			case "mark_ended": {
				state = markSessionEnded(state)
				break
			}
		}
	}
	return { state, duplicates, wokeAtEvents }
}

const pipedIdleInitial = (after = 0): ConnectState =>
	createInitialConnectState({
		trackPipedTurns: true,
		status: "idle",
		liveStatus: "idle",
		liveTurn: 0,
		lastProcessedSeq: after,
		observedTurn: 0,
		settledTurn: 0,
		ended: false,
	})

const ttyIdleInitial = (liveTurn = 0): ConnectState =>
	createInitialConnectState({
		trackPipedTurns: false,
		status: "idle",
		liveStatus: "idle",
		liveTurn,
		lastProcessedSeq: 0,
		observedTurn: liveTurn,
		settledTurn: liveTurn,
		ended: false,
	})

describe("SessionsConnectState pure turn-tracking transitions", () => {
	it("validates message and interrupt receipts strictly", () => {
		expect(extractSubmittedMessageReceipt([{ type: "user.message", turn: 1 }])).toEqual({
			turn: 1,
			queued: undefined,
		})
		expect(
			extractSubmittedMessageReceipt([{ type: "user.message", turn: 2, queued: true }]),
		).toEqual({ turn: 2, queued: true })
		expect(
			extractSubmittedMessageReceipt([{ type: "user.message", turn: 2, queued: false }]),
		).toEqual({ turn: 2, queued: false })
		expect(
			extractSubmittedMessageReceipt([{ type: "user.message", turn: 2, queued: "yes" }]),
		).toBeUndefined()
		expect(extractSubmittedMessageReceipt([{ turn: 7 }])).toBeUndefined()
		expect(extractSubmittedMessageReceipt([{ type: "user.message", turn: 0 }])).toBeUndefined()
		expect(extractSubmittedMessageReceipt([{ type: "user.interrupt", turn: 1 }])).toBeUndefined()
		expect(extractSubmittedMessageReceipt([])).toBeUndefined()

		expect(hasInterruptReceipt([{ type: "user.interrupt" }])).toBe(true)
		expect(hasInterruptReceipt([{ type: "user.message", turn: 1 }])).toBe(false)
		expect(hasInterruptReceipt([])).toBe(false)
	})

	it("settles two ordinary messages regardless of receipt vs SSE arrival order", () => {
		const orders: ReadonlyArray<{ readonly name: string; readonly steps: ReadonlyArray<Step> }> = [
			{
				name: "receipts arrive before SSE running/idle events",
				steps: [
					{ _tag: "begin_send", label: "m1" },
					{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
					{ _tag: "begin_send", label: "m2" },
					{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
					{ _tag: "event", event: { seq: 2, type: "session.status_running" } },
					{ _tag: "event", event: { seq: 4, type: "session.status_idle", stopReason: "end_turn" } },
					{ _tag: "event", event: { seq: 5, type: "session.status_running" } },
					{ _tag: "event", event: { seq: 7, type: "session.status_idle", stopReason: "end_turn" } },
				],
			},
			{
				name: "SSE running arrives before receipt 1, and SSE idle arrives before receipt 2",
				steps: [
					{ _tag: "begin_send", label: "m1" },
					{ _tag: "event", event: { seq: 2, type: "session.status_running" } },
					{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
					{ _tag: "event", event: { seq: 4, type: "session.status_idle", stopReason: "end_turn" } },
					{ _tag: "begin_send", label: "m2" },
					{ _tag: "event", event: { seq: 5, type: "session.status_running" } },
					{ _tag: "event", event: { seq: 7, type: "session.status_idle", stopReason: "end_turn" } },
					{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: false } },
				],
			},
			{
				name: "reconnect replays already-processed running/idle frames mid-stream",
				steps: [
					{ _tag: "begin_send", label: "m1" },
					{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
					{ _tag: "begin_send", label: "m2" },
					{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
					{ _tag: "event", event: { seq: 2, type: "session.status_running" } },
					// Replayed running frame with duplicate seq 2 must NOT increment observedTurn to 2
					{ _tag: "event", event: { seq: 2, type: "session.status_running" } },
					{ _tag: "event", event: { seq: 4, type: "session.status_idle", stopReason: "end_turn" } },
					// Replayed idle frame with duplicate seq 4 must NOT settle turn 2
					{ _tag: "event", event: { seq: 4, type: "session.status_idle", stopReason: "end_turn" } },
					{ _tag: "event", event: { seq: 5, type: "session.status_running" } },
					{ _tag: "event", event: { seq: 7, type: "session.status_idle", stopReason: "end_turn" } },
				],
			},
		]

		for (const scenario of orders) {
			const { state } = runSequence(pipedIdleInitial(), scenario.steps)
			expect({
				scenario: scenario.name,
				observedTurn: state.observedTurn,
				settledTurn: state.settledTurn,
				targetTurn: state.targetTurn,
				settlement: evaluatePipedSettlement(state),
				finalError: resolveFinalPipedError(state),
				interruptOnCtrlC: shouldInterruptOnCtrlC(state, undefined),
			}).toEqual({
				scenario: scenario.name,
				observedTurn: 2,
				settledTurn: 2,
				targetTurn: 2,
				settlement: "settled",
				finalError: undefined,
				interruptOnCtrlC: false,
			})
		}
	})

	it("never lets replayed seq <= lastProcessedSeq prematurely settle turn 2", () => {
		const { state, duplicates, wokeAtEvents } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "begin_send", label: "m2" },
			{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
			{ _tag: "event", event: { seq: 2, type: "session.status_running" } },
			{ _tag: "event", event: { seq: 2, type: "session.status_running" } },
			{ _tag: "event", event: { seq: 4, type: "session.status_idle", stopReason: "end_turn" } },
		])
		expect(duplicates).toEqual([2])
		expect(wokeAtEvents).toEqual([])
		expect(state.observedTurn).toBe(1)
		expect(state.settledTurn).toBe(1)
		expect(evaluatePipedSettlement(state)).toBe("wait")
	})

	it("handles Ctrl-C interrupt eligibility accurately across receipt and SSE arrival orders", () => {
		const cases: ReadonlyArray<{
			readonly name: string
			readonly initial: ConnectState
			readonly steps: ReadonlyArray<Step>
			readonly expectInterrupt: boolean
			readonly expectLiveStatus: ConnectState["liveStatus"]
			readonly expectLiveTurn: number
		}> = [
			{
				name: "receipt queued:false before SSE running -> Ctrl-C interrupts turn 1",
				initial: ttyIdleInitial(0),
				steps: [
					{ _tag: "begin_send", label: "m1" },
					{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
				],
				expectInterrupt: true,
				expectLiveStatus: "running",
				expectLiveTurn: 1,
			},
			{
				name: "receipt queued:true for turn 2 before SSE running -> infers predecessor turn 1 running",
				initial: ttyIdleInitial(0),
				steps: [
					{ _tag: "begin_send", label: "m2" },
					{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
				],
				expectInterrupt: true,
				expectLiveStatus: "running",
				expectLiveTurn: 1,
			},
			{
				name: "delayed receipt queued:true arriving AFTER SSE idle(refusal) for turn 1 -> stays idle",
				initial: ttyIdleInitial(0),
				steps: [
					{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
					{ _tag: "begin_send", label: "m2" },
					{ _tag: "event", event: { seq: 2, type: "session.status_idle", stopReason: "refusal" } },
					{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
				],
				expectInterrupt: false,
				expectLiveStatus: "idle",
				expectLiveTurn: 1,
			},
			{
				name: "receipt queued:false arriving AFTER SSE already settled turn 1 -> stays idle",
				initial: ttyIdleInitial(0),
				steps: [
					{ _tag: "begin_send", label: "m1" },
					{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
					{ _tag: "event", event: { seq: 2, type: "session.status_idle", stopReason: "end_turn" } },
					{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
				],
				expectInterrupt: false,
				expectLiveStatus: "idle",
				expectLiveTurn: 1,
			},
			{
				name: "receipt arriving AFTER session terminated -> stays terminated",
				initial: ttyIdleInitial(0),
				steps: [
					{ _tag: "begin_send", label: "m1" },
					{ _tag: "event", event: { seq: 1, type: "session.status_terminated" } },
					{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
				],
				expectInterrupt: false,
				expectLiveStatus: "terminated",
				expectLiveTurn: 0,
			},
		]

		for (const tc of cases) {
			const { state } = runSequence(tc.initial, tc.steps)
			expect({
				case: tc.name,
				liveStatus: state.liveStatus,
				liveTurn: state.liveTurn,
				firstCtrlC: shouldInterruptOnCtrlC(state, undefined),
				secondCtrlC: shouldInterruptOnCtrlC(state, state.liveTurn),
			}).toEqual({
				case: tc.name,
				liveStatus: tc.expectLiveStatus,
				liveTurn: tc.expectLiveTurn,
				firstCtrlC: tc.expectInterrupt,
				secondCtrlC: false,
			})
		}

		// Interrupt latch is scoped to liveTurn: interrupting turn 1 still lets Ctrl-C interrupt turn 2
		const { state: turn1Running } = runSequence(ttyIdleInitial(0), [
			{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
		])
		expect(shouldInterruptOnCtrlC(turn1Running, undefined)).toBe(true)
		expect(shouldInterruptOnCtrlC(turn1Running, turn1Running.liveTurn)).toBe(false)

		const { state: turn2Running } = runSequence(turn1Running, [
			{ _tag: "event", event: { seq: 2, type: "session.status_idle", stopReason: "interrupted" } },
			{ _tag: "event", event: { seq: 3, type: "session.status_running" } },
		])
		expect(turn2Running.liveTurn).toBe(2)
		expect(shouldInterruptOnCtrlC(turn2Running, turn1Running.liveTurn)).toBe(true)
		expect(shouldInterruptOnCtrlC(turn2Running, turn2Running.liveTurn)).toBe(false)
	})

	it("evaluates halted queued turns and lagging GET snapshots without false failures or hangs", () => {
		// Message 2 queued behind turn 1, turn 1 stops with refusal
		const { state: afterRefusal, wokeAtEvents } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
			{ _tag: "begin_send", label: "m2" },
			{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
			{ _tag: "event", event: { seq: 2, type: "session.status_idle", stopReason: "refusal" } },
		])
		expect(wokeAtEvents).toEqual([2])
		expect(evaluatePipedSettlement(afterRefusal)).toBe("check_halted_queue")

		// 1) Lagging snapshot still says running@turn 1 -> retries until exhausted, then fails
		const lagRunning: SessionSnapshotSummary = { status: "running", turn: 1 }
		expect(evaluateHaltedQueueSnapshot(afterRefusal, afterRefusal, lagRunning, false)).toEqual({
			action: "retry_snapshot",
		})
		expect(evaluateHaltedQueueSnapshot(afterRefusal, afterRefusal, lagRunning, true)).toEqual({
			action: "fail",
			message: "Queued turn 2 did not start because turn 1 stopped with refusal.",
		})

		// 2) Current snapshot says idle@turn 1 -> fails immediately
		const idleTurn1: SessionSnapshotSummary = { status: "idle", turn: 1 }
		expect(evaluateHaltedQueueSnapshot(afterRefusal, afterRefusal, idleTurn1, false)).toEqual({
			action: "fail",
			message: "Queued turn 2 did not start because turn 1 stopped with refusal.",
		})

		// 3) Snapshot shows turn 2 started -> continue waiting
		expect(
			evaluateHaltedQueueSnapshot(
				afterRefusal,
				afterRefusal,
				{ status: "running", turn: 2 },
				false,
			),
		).toEqual({ action: "continue_waiting" })

		// 4) Stale idle@turn 1 GET returning AFTER SSE already observed turn 2 starting -> continue waiting
		const turn2RunningTransition = applySessionEvent(afterRefusal, {
			seq: 3,
			type: "session.status_running",
		})
		expect(turn2RunningTransition.shouldWakeWaiter).toBe(true)
		expect(
			evaluateHaltedQueueSnapshot(afterRefusal, turn2RunningTransition.state, idleTurn1, false),
		).toEqual({
			action: "continue_waiting",
		})

		// 5) Later message starts turn 2 from idle (queued: false) -> clears queued marker; never checks halted queue
		const { state: restartedTurn2 } = runSequence(afterRefusal, [
			{ _tag: "begin_send", label: "m3" },
			{ _tag: "receipt", label: "m3", receipt: { turn: 2, queued: false } },
		])
		expect(restartedTurn2.unsettledQueuedTurns.has(2)).toBe(false)
		expect(evaluatePipedSettlement(restartedTurn2)).toBe("wait")
		expect(evaluateHaltedQueueSnapshot(afterRefusal, restartedTurn2, idleTurn1, false)).toEqual({
			action: "continue_waiting",
		})

		// 6) Piped message sent while CLI saw turn 1 running, arrived after refusal and started turn 2 (queued: false)
		const { state: startedInsteadOfQueued } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
			{ _tag: "begin_send", label: "m2" },
			{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: false } },
			{ _tag: "event", event: { seq: 2, type: "session.status_idle", stopReason: "refusal" } },
		])
		expect(evaluatePipedSettlement(startedInsteadOfQueued)).toBe("wait")
	})

	it("attributes retries_exhausted and terminal vs retrying errors accurately regardless of receipt order", () => {
		// 1) Turn fails with retries_exhausted BEFORE POST receipt arrives (recorded via pendingTurnErrors)
		const { state: failedBeforeReceipt } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
			{
				_tag: "event",
				event: {
					seq: 2,
					type: "session.error",
					error: { message: "model_error: overloaded", retryStatus: "exhausted" },
				},
			},
			{
				_tag: "event",
				event: { seq: 3, type: "session.status_idle", stopReason: "retries_exhausted" },
			},
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
		])
		expect(evaluatePipedSettlement(failedBeforeReceipt)).toBe("settled")
		expect(resolveFinalPipedError(failedBeforeReceipt)).toBe(
			"Turn 1 failed: model_error: overloaded",
		)

		// 2) Turn has a retrying error then is archived -> reports termination, NOT the transient retrying error
		const { state: archivedAfterRetrying } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
			{
				_tag: "event",
				event: {
					seq: 2,
					type: "session.error",
					error: { message: "model_error: temporary 503", retryStatus: "retrying" },
				},
			},
			{ _tag: "event", event: { seq: 3, type: "session.status_terminated" } },
			{ _tag: "mark_ended" },
		])
		expect(resolveFinalPipedError(archivedAfterRetrying)).toBe(
			"Session terminated before turn 1 completed.",
		)

		// 3) Turn has a terminal error then terminates -> reports the terminal error cause
		const { state: terminatedAfterTerminalErr } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
			{
				_tag: "event",
				event: {
					seq: 2,
					type: "session.error",
					error: { message: "model_error: fatal auth", retryStatus: "terminal" },
				},
			},
			{ _tag: "event", event: { seq: 3, type: "session.status_terminated" } },
			{ _tag: "mark_ended" },
		])
		expect(resolveFinalPipedError(terminatedAfterTerminalErr)).toBe(
			"Turn 1 failed: model_error: fatal auth",
		)

		// 4) Cancelled send never leaves stale pendingTurnErrors or unsettled turns
		const { state: cancelled } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
			{
				_tag: "event",
				event: { seq: 2, type: "session.status_idle", stopReason: "retries_exhausted" },
			},
			{ _tag: "cancel_send" },
		])
		expect(cancelled.sendInFlight).toBe(false)
		expect(cancelled.pendingTurnErrors.size).toBe(0)
		expect(resolveFinalPipedError(cancelled)).toBeUndefined()
	})

	it("evaluates stream-ended errors from fresh settlement state instead of stale snapshots", () => {
		// Turn 2 queued after turn 1 refusal, then another client runs turn 2 and archives session
		const { state: completedAndArchived } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running" } },
			{ _tag: "begin_send", label: "m2" },
			{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
			{ _tag: "event", event: { seq: 2, type: "session.status_idle", stopReason: "refusal" } },
			{ _tag: "event", event: { seq: 3, type: "session.status_running" } },
			{ _tag: "event", event: { seq: 4, type: "session.status_idle", stopReason: "end_turn" } },
			{ _tag: "event", event: { seq: 5, type: "session.archived" } },
			{ _tag: "mark_ended" },
		])
		expect(resolveStreamEndedError(completedAndArchived)).toBeUndefined()
		expect(resolveFinalPipedError(completedAndArchived)).toBeUndefined()

		// Stream ends unexpectedly (e.g. HTTP 204) before target turn 1 settles
		const { state: endedBeforeSettling } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
		])
		expect(resolveStreamEndedError(endedBeforeSettling)).toBe(
			"Event stream ended before turn 1 completed.",
		)

		// Stream ends unexpectedly with no target turn
		expect(resolveStreamEndedError(pipedIdleInitial())).toBe("Event stream ended unexpectedly.")
	})
})
