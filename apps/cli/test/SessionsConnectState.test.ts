import { describe, expect, it } from "@effect/vitest"
import {
	applyMessageReceipt,
	applySessionEvent,
	beginMessageSend,
	cancelMessageSend,
	createInitialConnectState,
	awaitingActionOf,
	describeAwaitedAction,
	evaluateHaltedQueueSnapshot,
	evaluatePipedSettlement,
	extractSubmittedMessageReceipt,
	hasInterruptReceipt,
	markSessionEnded,
	observedTurnOf,
	resolveFinalPipedError,
	resolveStreamEndedError,
	settledTurnOf,
	shouldInterruptOnCtrlC,
} from "../src/Commands/SessionsConnectState.ts"
import { emptySessionFold, foldSessionEvents } from "@checkfu/sdk/SessionFold"
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
		liveStatus: "idle",
		liveTurn: 0,
		lastProcessedSeq: after,
		ended: false,
	})

const ttyIdleInitial = (liveTurn = 0): ConnectState =>
	createInitialConnectState({
		trackPipedTurns: false,
		liveStatus: "idle",
		liveTurn,
		lastProcessedSeq: 0,
		ended: false,
		calls: {
			...emptySessionFold("none"),
			turn: { status: "settled", turn: liveTurn, stopReason: undefined },
			settled: { turn: liveTurn, stopReason: undefined },
		},
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
					{ _tag: "event", event: { seq: 2, type: "session.status_running", turn: 1 } },
					{
						_tag: "event",
						event: {
							seq: 4,
							type: "session.status_idle",
							turn: 1,
							stop_reason: { type: "end_turn" },
						},
					},
					{ _tag: "event", event: { seq: 5, type: "session.status_running", turn: 2 } },
					{
						_tag: "event",
						event: {
							seq: 7,
							type: "session.status_idle",
							turn: 2,
							stop_reason: { type: "end_turn" },
						},
					},
				],
			},
			{
				name: "SSE running arrives before receipt 1, and SSE idle arrives before receipt 2",
				steps: [
					{ _tag: "begin_send", label: "m1" },
					{ _tag: "event", event: { seq: 2, type: "session.status_running", turn: 1 } },
					{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
					{
						_tag: "event",
						event: {
							seq: 4,
							type: "session.status_idle",
							turn: 1,
							stop_reason: { type: "end_turn" },
						},
					},
					{ _tag: "begin_send", label: "m2" },
					{ _tag: "event", event: { seq: 5, type: "session.status_running", turn: 2 } },
					{
						_tag: "event",
						event: {
							seq: 7,
							type: "session.status_idle",
							turn: 2,
							stop_reason: { type: "end_turn" },
						},
					},
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
					{ _tag: "event", event: { seq: 2, type: "session.status_running", turn: 1 } },
					{ _tag: "event", event: { seq: 2, type: "session.status_running", turn: 1 } },
					{
						_tag: "event",
						event: {
							seq: 4,
							type: "session.status_idle",
							turn: 1,
							stop_reason: { type: "end_turn" },
						},
					},
					{
						_tag: "event",
						event: {
							seq: 4,
							type: "session.status_idle",
							turn: 1,
							stop_reason: { type: "end_turn" },
						},
					},
					{ _tag: "event", event: { seq: 5, type: "session.status_running", turn: 2 } },
					{
						_tag: "event",
						event: {
							seq: 7,
							type: "session.status_idle",
							turn: 2,
							stop_reason: { type: "end_turn" },
						},
					},
				],
			},
		]

		for (const scenario of orders) {
			const { state } = runSequence(pipedIdleInitial(), scenario.steps)
			expect({
				scenario: scenario.name,
				observedTurn: observedTurnOf(state),
				settledTurn: settledTurnOf(state),
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
			{ _tag: "event", event: { seq: 2, type: "session.status_running", turn: 1 } },
			{ _tag: "event", event: { seq: 2, type: "session.status_running", turn: 1 } },
			{
				_tag: "event",
				event: { seq: 4, type: "session.status_idle", turn: 1, stop_reason: { type: "end_turn" } },
			},
		])
		expect(duplicates).toEqual([2])
		expect(wokeAtEvents).toEqual([])
		expect(observedTurnOf(state)).toBe(1)
		expect(settledTurnOf(state)).toBe(1)
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
					{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
					{ _tag: "begin_send", label: "m2" },
					{
						_tag: "event",
						event: {
							seq: 2,
							type: "session.status_idle",
							turn: 1,
							stop_reason: { type: "refusal" },
						},
					},
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
					{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
					{
						_tag: "event",
						event: {
							seq: 2,
							type: "session.status_idle",
							turn: 1,
							stop_reason: { type: "end_turn" },
						},
					},
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

		const { state: turn1Running } = runSequence(ttyIdleInitial(0), [
			{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
		])
		expect(shouldInterruptOnCtrlC(turn1Running, undefined)).toBe(true)
		expect(shouldInterruptOnCtrlC(turn1Running, turn1Running.liveTurn)).toBe(false)

		const { state: turn2Running } = runSequence(turn1Running, [
			{
				_tag: "event",
				event: {
					seq: 2,
					type: "session.status_idle",
					turn: 1,
					stop_reason: { type: "interrupted" },
				},
			},
			{ _tag: "event", event: { seq: 3, type: "session.status_running", turn: 2 } },
		])
		expect(turn2Running.liveTurn).toBe(2)
		expect(shouldInterruptOnCtrlC(turn2Running, turn1Running.liveTurn)).toBe(true)
		expect(shouldInterruptOnCtrlC(turn2Running, turn2Running.liveTurn)).toBe(false)
	})

	it("evaluates halted queued turns and lagging GET snapshots without false failures or hangs", () => {
		const { state: afterRefusal, wokeAtEvents } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
			{ _tag: "begin_send", label: "m2" },
			{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
			{
				_tag: "event",
				event: { seq: 2, type: "session.status_idle", turn: 1, stop_reason: { type: "refusal" } },
			},
		])
		expect(wokeAtEvents).toEqual([2])
		expect(evaluatePipedSettlement(afterRefusal)).toBe("check_halted_queue")

		const lagRunning: SessionSnapshotSummary = { status: "running", turn: 1 }
		expect(evaluateHaltedQueueSnapshot(afterRefusal, afterRefusal, lagRunning, false)).toEqual({
			action: "retry_snapshot",
		})
		expect(evaluateHaltedQueueSnapshot(afterRefusal, afterRefusal, lagRunning, true)).toEqual({
			action: "unconfirmed",
			message: "Could not confirm whether queued turn 2 started. Reconnect to check its progress.",
		})

		const idleTurn1: SessionSnapshotSummary = { status: "idle", turn: 1 }
		expect(evaluateHaltedQueueSnapshot(afterRefusal, afterRefusal, idleTurn1, false)).toEqual({
			action: "fail",
			message: "Queued turn 2 did not start because turn 1 stopped with refusal.",
		})

		expect(
			evaluateHaltedQueueSnapshot(
				afterRefusal,
				afterRefusal,
				{ status: "running", turn: 2 },
				false,
			),
		).toEqual({ action: "continue_waiting" })

		const turn2RunningTransition = applySessionEvent(afterRefusal, {
			seq: 3,
			type: "session.status_running",
			turn: 2,
		})
		expect(turn2RunningTransition.shouldWakeWaiter).toBe(true)
		expect(
			evaluateHaltedQueueSnapshot(afterRefusal, turn2RunningTransition.state, idleTurn1, false),
		).toEqual({
			action: "continue_waiting",
		})

		const { state: restartedTurn2 } = runSequence(afterRefusal, [
			{ _tag: "begin_send", label: "m3" },
			{ _tag: "receipt", label: "m3", receipt: { turn: 2, queued: false } },
		])
		expect(restartedTurn2.unsettledQueuedTurns.has(2)).toBe(false)
		expect(evaluatePipedSettlement(restartedTurn2)).toBe("wait")
		expect(evaluateHaltedQueueSnapshot(afterRefusal, restartedTurn2, idleTurn1, false)).toEqual({
			action: "continue_waiting",
		})

		const { state: startedInsteadOfQueued } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
			{ _tag: "begin_send", label: "m2" },
			{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: false } },
			{
				_tag: "event",
				event: { seq: 2, type: "session.status_idle", turn: 1, stop_reason: { type: "refusal" } },
			},
		])
		expect(evaluatePipedSettlement(startedInsteadOfQueued)).toBe("wait")
	})

	it("attributes retries_exhausted and terminal vs retrying errors accurately regardless of receipt order", () => {
		const { state: failedBeforeReceipt } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
			{
				_tag: "event",
				event: {
					seq: 2,
					type: "session.error",
					error: {
						type: "model_error",
						message: "overloaded",
						retry_status: { type: "exhausted" },
					},
				},
			},
			{
				_tag: "event",
				event: {
					seq: 3,
					type: "session.status_idle",
					turn: 1,
					stop_reason: { type: "retries_exhausted" },
				},
			},
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
		])
		expect(evaluatePipedSettlement(failedBeforeReceipt)).toBe("settled")
		expect(resolveFinalPipedError(failedBeforeReceipt)).toBe(
			"Turn 1 failed: model_error: overloaded",
		)

		const { state: archivedAfterRetrying } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
			{
				_tag: "event",
				event: {
					seq: 2,
					type: "session.error",
					error: {
						type: "model_error",
						message: "temporary 503",
						retry_status: { type: "retrying" },
					},
				},
			},
			{ _tag: "event", event: { seq: 3, type: "session.status_terminated" } },
			{ _tag: "mark_ended" },
		])
		expect(resolveFinalPipedError(archivedAfterRetrying)).toBe(
			"Session terminated before turn 1 completed.",
		)

		const { state: terminatedAfterTerminalErr } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
			{
				_tag: "event",
				event: {
					seq: 2,
					type: "session.error",
					error: { type: "model_error", message: "fatal auth", retry_status: { type: "terminal" } },
				},
			},
			{ _tag: "event", event: { seq: 3, type: "session.status_terminated" } },
			{ _tag: "mark_ended" },
		])
		expect(resolveFinalPipedError(terminatedAfterTerminalErr)).toBe(
			"Turn 1 failed: model_error: fatal auth",
		)

		const { state: cancelled } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
			{
				_tag: "event",
				event: {
					seq: 2,
					type: "session.status_idle",
					turn: 1,
					stop_reason: { type: "retries_exhausted" },
				},
			},
			{ _tag: "cancel_send" },
		])
		expect(cancelled.sendInFlight).toBe(false)
		expect(cancelled.pendingTurnErrors.size).toBe(0)
		expect(resolveFinalPipedError(cancelled)).toBeUndefined()
	})

	it("evaluates stream-ended errors from fresh settlement state instead of stale snapshots", () => {
		const { state: completedAndArchived } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 1, type: "session.status_running", turn: 1 } },
			{ _tag: "begin_send", label: "m2" },
			{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
			{
				_tag: "event",
				event: { seq: 2, type: "session.status_idle", turn: 1, stop_reason: { type: "refusal" } },
			},
			{ _tag: "event", event: { seq: 3, type: "session.status_running", turn: 2 } },
			{
				_tag: "event",
				event: { seq: 4, type: "session.status_idle", turn: 2, stop_reason: { type: "end_turn" } },
			},
			{ _tag: "event", event: { seq: 5, type: "session.archived" } },
			{ _tag: "mark_ended" },
		])
		expect(resolveStreamEndedError(completedAndArchived)).toBeUndefined()
		expect(resolveFinalPipedError(completedAndArchived)).toBeUndefined()

		const { state: endedBeforeSettling } = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
		])
		expect(resolveStreamEndedError(endedBeforeSettling)).toBe(
			"Event stream ended before turn 1 completed.",
		)

		expect(resolveStreamEndedError(pipedIdleInitial())).toBe("Event stream ended unexpectedly.")
	})

	it("uses wire turn directly on session.status_running and session.status_idle on reconnect", () => {
		const { state: resumedRunning } = runSequence(ttyIdleInitial(0), [
			{ _tag: "event", event: { seq: 15, type: "session.status_running", turn: 4 } },
		])
		expect(observedTurnOf(resumedRunning)).toBe(4)
		expect(resumedRunning.liveTurn).toBe(4)
		expect(resumedRunning.liveStatus).toBe("running")

		const { state: resumedIdle } = runSequence(ttyIdleInitial(0), [
			{
				_tag: "event",
				event: { seq: 16, type: "session.status_idle", turn: 4, stop_reason: { type: "end_turn" } },
			},
		])
		expect(observedTurnOf(resumedIdle)).toBe(4)
		expect(settledTurnOf(resumedIdle)).toBe(4)
		expect(resumedIdle.liveTurn).toBe(4)
		expect(resumedIdle.liveStatus).toBe("idle")
	})

	it("keeps a turn that pauses for an answer unsettled, and settles it when it ends", () => {
		const pause: ConnectSessionEvent = {
			seq: 12,
			type: "session.status_idle",
			turn: 1,
			stop_reason: { type: "requires_action", event_ids: ["tu_1", "tu_2"] },
		}
		const paused = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "begin_send", label: "m2" },
			{ _tag: "receipt", label: "m2", receipt: { turn: 2, queued: true } },
			{ _tag: "event", event: { seq: 10, type: "session.status_running", turn: 1 } },
			{ _tag: "event", event: pause },
		])
		expect(settledTurnOf(paused.state)).toBe(0)
		expect(Array.from(paused.state.unsettledSubmittedTurns)).toEqual([1, 2])
		expect(Array.from(paused.state.unsettledQueuedTurns)).toEqual([2])
		expect(paused.state.calls.settled.stopReason).toBeUndefined()
		expect(awaitingActionOf(paused.state)).toEqual({
			turn: 1,
			seq: 12,
			toolUseIds: ["tu_1", "tu_2"],
		})
		expect(paused.wokeAtEvents).toEqual([12])
		expect(evaluatePipedSettlement(paused.state)).toBe("awaiting_action")
		expect(describeAwaitedAction(awaitingActionOf(paused.state)!)).toBe(
			"Turn 1 waits on tool calls tu_1, tu_2. Answer each, then reconnect with --after 12 to read the reply.",
		)
		expect(resolveFinalPipedError(paused.state)).toBe("Turn 1 did not complete.")
		expect(shouldInterruptOnCtrlC(paused.state, undefined)).toBe(true)

		const answered = runSequence(paused.state, [
			{ _tag: "event", event: { seq: 14, type: "session.status_running", turn: 1 } },
		])
		expect(awaitingActionOf(answered.state)).toBeUndefined()
		expect(answered.state.liveStatus).toBe("running")
		expect(evaluatePipedSettlement(answered.state)).toBe("wait")

		const ended = runSequence(answered.state, [
			{
				_tag: "event",
				event: { seq: 16, type: "session.status_idle", turn: 1, stop_reason: { type: "end_turn" } },
			},
			{ _tag: "event", event: { seq: 17, type: "session.status_running", turn: 2 } },
			{
				_tag: "event",
				event: { seq: 19, type: "session.status_idle", turn: 2, stop_reason: { type: "end_turn" } },
			},
		])
		expect(settledTurnOf(ended.state)).toBe(2)
		expect(evaluatePipedSettlement(ended.state)).toBe("settled")
		expect(resolveFinalPipedError(ended.state)).toBeUndefined()

		const interrupted = runSequence(paused.state, [
			{
				_tag: "event",
				event: {
					seq: 14,
					type: "session.status_idle",
					turn: 1,
					stop_reason: { type: "interrupted" },
				},
			},
		])
		expect(awaitingActionOf(interrupted.state)).toBeUndefined()
		expect(settledTurnOf(interrupted.state)).toBe(1)
	})

	it("does not take a pause of a turn behind the awaited one, or one with nothing sent, for its own", () => {
		const watching = runSequence(pipedIdleInitial(), [
			{
				_tag: "event",
				event: {
					seq: 5,
					type: "session.status_idle",
					turn: 3,
					stop_reason: { type: "requires_action", event_ids: ["tu_9"] },
				},
			},
		])
		expect(watching.wokeAtEvents).toEqual([])
		expect(evaluatePipedSettlement(watching.state)).toBe("wait")
		const settled = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{
				_tag: "event",
				event: { seq: 3, type: "session.status_idle", turn: 1, stop_reason: { type: "end_turn" } },
			},
			{
				_tag: "event",
				event: {
					seq: 8,
					type: "session.status_idle",
					turn: 2,
					stop_reason: { type: "requires_action", event_ids: ["tu_2"] },
				},
			},
		])
		expect(evaluatePipedSettlement(settled.state)).toBe("settled")
	})

	it("subtracts each answer from a pause, and waits on one whose calls are all answered", () => {
		const source = (event: ConnectSessionEvent, seq: number) => ({
			_tag: "event" as const,
			event: { ...event, seq },
		})
		const paused = runSequence(pipedIdleInitial(), [
			{ _tag: "begin_send", label: "m1" },
			{ _tag: "receipt", label: "m1", receipt: { turn: 1, queued: false } },
			{ _tag: "event", event: { seq: 2, type: "session.status_running", turn: 1 } },
			source(
				{
					type: "agent.mcp_tool_use",
					tool_use_id: "tu_1",
					mcp_server_name: "github",
					name: "merge",
					input: { pr: 4 },
					evaluated_permission: "ask",
				},
				3,
			),
			source({ type: "agent.custom_tool_use", tool_use_id: "tu_2", name: "refund", input: {} }, 4),
			{
				_tag: "event",
				event: {
					seq: 5,
					type: "session.status_idle",
					turn: 1,
					stop_reason: { type: "requires_action", event_ids: ["tu_1", "tu_2"] },
				},
			},
			source({ type: "user.tool_confirmation", tool_use_id: "tu_1", result: "allow" }, 6),
		])
		expect(awaitingActionOf(paused.state)).toEqual({ turn: 1, seq: 5, toolUseIds: ["tu_2"] })
		expect(describeAwaitedAction(awaitingActionOf(paused.state)!)).toBe(
			"Turn 1 waits on tool call tu_2. Answer it, then reconnect with --after 5 to read the reply.",
		)
		expect(evaluatePipedSettlement(paused.state)).toBe("awaiting_action")

		const answered = runSequence(paused.state, [
			source(
				{
					type: "user.custom_tool_result",
					custom_tool_use_id: "tu_2",
					content: [{ type: "text", text: "refunded" }],
				},
				7,
			),
		])
		expect(awaitingActionOf(answered.state)?.toolUseIds).toEqual([])
		expect(evaluatePipedSettlement(answered.state)).toBe("wait")
		expect(shouldInterruptOnCtrlC(answered.state, undefined)).toBe(true)
	})

	it("opens on the pause its cursor sits in, so the turn can be interrupted and go on", () => {
		const calls = foldSessionEvents(emptySessionFold("waiting"), [
			{ type: "session.status_running", turn: 2, seq: 7 },
			{
				type: "agent.mcp_tool_use",
				tool_use_id: "tu_1",
				mcp_server_name: "github",
				name: "merge",
				input: { pr: 4 },
				evaluated_permission: "ask",
				seq: 8,
			},
			{
				type: "agent.custom_tool_use",
				tool_use_id: "tu_2",
				name: "refund",
				input: { order: 7 },
				seq: 9,
			},
			{
				type: "session.status_idle",
				turn: 2,
				seq: 10,
				stop_reason: { type: "requires_action", event_ids: ["tu_1", "tu_2"] },
			},
			{ type: "user.tool_confirmation", tool_use_id: "tu_1", result: "allow", seq: 12 },
		])
		const restored = createInitialConnectState({
			trackPipedTurns: false,
			liveStatus: "idle",
			liveTurn: 2,
			lastProcessedSeq: 12,
			ended: false,
			calls,
		})
		expect(awaitingActionOf(restored)).toEqual({ turn: 2, seq: 10, toolUseIds: ["tu_2"] })
		expect(Array.from(restored.calls.calls.keys())).toEqual(["tu_2"])
		expect(shouldInterruptOnCtrlC(restored, undefined)).toBe(true)
		const resumed = runSequence(restored, [
			{ _tag: "event", event: { seq: 14, type: "session.status_running", turn: 2 } },
		])
		expect(resumed.state.liveStatus).toBe("running")
		expect(awaitingActionOf(resumed.state)).toBeUndefined()
	})
})
