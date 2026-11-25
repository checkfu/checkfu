import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { AbandonTurn, TurnAbandoned } from "./AbandonTurn.command.ts"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { HARNESS_UNAVAILABLE, HARNESS_UNAVAILABLE_MESSAGE, Harness } from "./Harness.external.ts"
import { TurnId, turnKey } from "./RunTurn.saga.ts"
import { UserInterrupt } from "./SendUserInterrupt.command.ts"
import { Session } from "./Session.aggregate.ts"

// Forwards each stop from the session itself, for the turn the event names, so no view rebuild can
// swallow one: the harness refuses a run whose turn it was told to stop, whichever arrives first.
// The hosted model's only stop path, so each stop has one outcome. Keyed by turn, so a stop still
// being retried for one turn never holds up the next turn's.
export class EnsureTurnStopped extends Domain.Policy("EnsureTurnStopped", {
	from: Session,
	on: [UserInterrupt, TurnAbandoned, SessionStatusTerminated],
	key: TurnId,
	keyOf: {
		"user.interrupt": ({ source, event }) =>
			event.turn === null ? undefined : turnKey(source.id, event.turn),
		"turn.abandoned": ({ source, event }) => turnKey(source.id, event.turn),
		"session.status_terminated": ({ source, event }) =>
			event.running_turn === null ? undefined : turnKey(source.id, event.running_turn),
	},
}) {}

export const EnsureTurnStoppedLive = EnsureTurnStopped.toLayer(
	Effect.gen(function* () {
		const harness = yield* Harness
		const sessions = yield* Session
		return Effect.fn(function* ({ source, event }) {
			const turn = event._tag === "session.status_terminated" ? event.running_turn : event.turn
			if (turn === null) {
				return
			}
			const interrupt = harness.interrupt({ session_id: source.id, turn })
			if (event._tag === "user.interrupt") {
				yield* interrupt.pipe(
					Effect.catchTag("HarnessUnavailable", () =>
						sessions.send(
							new AbandonTurn({
								session_id: source.id,
								turn,
								error_type: HARNESS_UNAVAILABLE,
								message: HARNESS_UNAVAILABLE_MESSAGE,
							}),
						),
					),
				)
				return
			}
			yield* interrupt.pipe(Effect.orDie)
		})
	}),
)
