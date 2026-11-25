import * as Domain from "@alchemy.run/domain"
import type * as Policy from "@alchemy.run/domain/Policy"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { AbandonTurn } from "./AbandonTurn.command.ts"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { SessionStatusIdle } from "./CommitModelReply.command.ts"
import { DEFAULT_TURN_TIMEOUT_MS, TURN_TIMEOUT, TURN_TIMEOUT_MESSAGE } from "./Harness.external.ts"
import { RunTurn, turnKey } from "./RunTurn.saga.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { TurnInput } from "./TurnInput.view.ts"

// Its own timer, so it never replaces the one StartTurn arms; due a fixed time after the
// turn started, so a late delivery cannot move it.
export const ENSURED_TURN_DEADLINE = "ensured-turn-deadline"

// StartTurn is fed by TurnInput so the verifier can follow a turn, but a view that is
// rebuilding takes an event as history, which a policy fed by it never sees. Deliveries
// from the session itself always arrive: start the same run, under the same key, from here.
export class EnsureTurnStarted extends Domain.Policy("EnsureTurnStarted", {
	from: Session,
	on: [SessionStatusRunning, SessionStatusIdle, SessionStatusTerminated],
}) {}

export const ensureTurnStarted = Effect.gen(function* () {
	const runs = yield* RunTurn
	const sessions = yield* Session
	const inputs = yield* TurnInput
	return Effect.fn(function* ({
		source,
		event,
		envelope,
	}: Policy.TriggerOf<typeof EnsureTurnStarted>) {
		if (event._tag !== "session.status_running") {
			yield* sessions
				.unschedule(source.id, ENSURED_TURN_DEADLINE)
				.pipe(
					Effect.catchTag(
						["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"],
						() => Effect.void,
					),
				)
			return
		}
		const state = Option.getOrNull(
			yield* Effect.orDie(
				inputs.get(source, {
					atLeast: { stream: `Session/${source.id}`, version: envelope.seq },
				}),
			),
		)
		if (state === null || state.turn !== event.turn || state.input.length === 0) {
			return
		}
		const abandon = new AbandonTurn({
			session_id: source.id,
			turn: state.turn,
			error_type: TURN_TIMEOUT,
			message: TURN_TIMEOUT_MESSAGE,
		})
		const due = DateTime.toEpochMillis(envelope.at) + DEFAULT_TURN_TIMEOUT_MS
		// Arrived after the turn's deadline: end it now, or the run could reply before the timer fires.
		if ((yield* Clock.currentTimeMillis) >= due) {
			yield* sessions.send(abandon)
			return
		}
		yield* sessions.schedule(abandon, {
			at: DateTime.makeUnsafe(due),
			commandId: ENSURED_TURN_DEADLINE,
		})
		yield* runs.start(turnKey(source.id, state.turn), {
			session_id: source.id,
			agent_id: state.agent_id,
			agent_version: state.agent_version,
			environment_id: state.environment_id,
			turn: state.turn,
			input: state.input,
			...(state.last_reply_turn === undefined ? {} : { last_reply_turn: state.last_reply_turn }),
		})
	})
})

export const EnsureTurnStartedLive = EnsureTurnStarted.toLayer(ensureTurnStarted)
