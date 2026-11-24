import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import * as Effect from "effect/Effect"
import type { PiApprovalStore, ToolAnswer, ToolGate } from "./PiApprovals.ts"
import { abortPiDurableTurn, recoverPiDurableTurn, runPiDurableTurn } from "./PiDurableEngine.ts"
import type { PiDurableBackend } from "./PiDurableEngine.ts"
import { isPaused } from "./PiTurn.ts"
import type { PiTurnOutcome, PiTurnPaused, PiTurnRequest } from "./PiTurn.ts"

export interface PiTurnsOptions {
	readonly backend: PiDurableBackend
	readonly approvals: PiApprovalStore
	readonly gate: Pick<ToolGate, "deliver" | "waiting" | "waitingResults">
	/** Runs before a turn reaches Pi, such as to make its tools known. */
	readonly prepare?: (request: PiTurnRequest) => Promise<void>
	/** A turn Pi has not seen starts: what the last operation left behind is forgotten. */
	readonly begin?: () => void
}

/**
 * A session's turns as Pi runs them. Usually a turn is one Pi operation. An
 * operation that pauses on tool calls a person must answer outlives its turn:
 * the turn that carries the answers takes the same operation up again, and
 * ends where it ends or pauses next.
 */
export const makePiTurns = ({ backend, approvals, gate, prepare, begin }: PiTurnsOptions) => {
	const hasSubmission = async (operationId: string): Promise<boolean> => {
		const pi = await backend.pi()
		const record = await pi.commit(
			(tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, operationId),
			BACKGROUND_CONTEXT,
		)
		return record !== undefined
	}

	// The operation a turn stands for: its own, or the paused one it carries on.
	const operationOf = async (turnOperationId: string): Promise<string> => {
		const resumed = approvals.resumedBy(turnOperationId)
		if (resumed !== null) {
			return resumed
		}
		const paused = approvals.pausedOperation()
		if (paused !== null && paused !== turnOperationId && !(await hasSubmission(turnOperationId))) {
			approvals.resume(turnOperationId, paused)
			return paused
		}
		return turnOperationId
	}

	const published = <Outcome extends PiTurnOutcome | null>(
		turnOperationId: string,
		outcome: Outcome,
	): Outcome => {
		if (outcome === null || !("tool_calls" in outcome) || outcome.tool_calls === undefined) {
			return outcome
		}
		return { ...outcome, tool_calls: approvals.unpublished(turnOperationId, outcome.tool_calls) }
	}

	// Says which of a pause's calls wait for a result from the caller's application.
	const paused = <Outcome extends PiTurnOutcome | null>(
		outcome: Outcome,
	): Outcome | PiTurnPaused => {
		if (outcome === null || !isPaused(outcome)) {
			return outcome
		}
		const results = new Set(gate.waitingResults())
		return { ...outcome, waiting_results: outcome.waiting.filter((id) => results.has(id)) }
	}

	const recoverTurn = (turnOperationId: string): Effect.Effect<PiTurnOutcome | null> =>
		Effect.promise(() => operationOf(turnOperationId)).pipe(
			Effect.flatMap((operationId) =>
				Effect.map(recoverPiDurableTurn(backend, operationId), (outcome) =>
					outcome !== null && isPaused(outcome) && operationId !== turnOperationId
						? { ...outcome, carried: true as const }
						: outcome,
				),
			),
			Effect.map((outcome) => paused(published(turnOperationId, outcome))),
		)

	return {
		recoverTurn,
		runTurn: (request: PiTurnRequest): Effect.Effect<PiTurnOutcome> =>
			Effect.gen(function* () {
				yield* Effect.promise(async () => {
					await prepare?.(request)
					if (!(await hasSubmission(request.operationId))) {
						begin?.()
						approvals.begin(request.operationId)
					}
				})
				const result = yield* runPiDurableTurn(backend, request)
				return paused(published(request.operationId, result))
			}),
		/** Hands answers to the calls that wait, then follows the operation to where it ends or pauses next. */
		resumeTurn: (
			turnOperationId: string,
			answers: ReadonlyArray<ToolAnswer>,
		): Effect.Effect<PiTurnOutcome | null> =>
			Effect.promise(() => gate.deliver(answers)).pipe(
				Effect.andThen(recoverTurn(turnOperationId)),
			),
		abortTurn: (turnOperationId: string): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const paused = approvals.resumedBy(turnOperationId) ?? approvals.pausedOperation()
				// Forgotten before the abort, which can reset the object: a paused call is never
				// resumable after it, and Pi, which has the abort on record, ends the call.
				approvals.forgetWaiting()
				if (paused !== null && paused !== turnOperationId) {
					yield* abortPiDurableTurn(backend, paused)
				}
				return yield* abortPiDurableTurn(backend, turnOperationId)
			}),
		/** The tool calls a person has yet to answer. */
		waitingCalls: (): Effect.Effect<ReadonlyArray<string>> => Effect.sync(() => gate.waiting()),
		/** Gives up whatever waits for a person, so `turnOperationId` can run as a turn of its own. */
		cancelWaiting: (turnOperationId: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const paused = approvals.resumedBy(turnOperationId) ?? approvals.pausedOperation()
				approvals.forgetWaiting()
				approvals.forgetResumed(turnOperationId)
				if (paused !== null && paused !== turnOperationId) {
					yield* abortPiDurableTurn(backend, paused)
				}
			}),
	}
}
