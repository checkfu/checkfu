import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { AbandonTurn, TurnAbandoned } from "./AbandonTurn.command.ts"
import { HARNESS_UNAVAILABLE, HARNESS_UNAVAILABLE_MESSAGE, Harness } from "./Harness.external.ts"
import { UserInterrupt } from "./SendUserInterrupt.command.ts"
import { Session } from "./Session.aggregate.ts"

// StopModelRequest is fed by TurnInput, so it can miss a stop signal the view takes as history
// while it rebuilds. Forward each one from the session itself, for the turn the event names: the
// harness refuses a run whose turn it was told to stop, whichever of the two arrives first.
export class EnsureTurnStopped extends Domain.Policy("EnsureTurnStopped", {
	from: Session,
	on: [UserInterrupt, TurnAbandoned],
}) {}

export const EnsureTurnStoppedLive = EnsureTurnStopped.toLayer(
	Effect.gen(function* () {
		const harness = yield* Harness
		const sessions = yield* Session
		return Effect.fn(function* ({ source, event }) {
			const interrupt = harness.interrupt({ session_id: source.id, turn: event.turn })
			if (event._tag === "user.interrupt") {
				yield* interrupt.pipe(
					Effect.catchTag("HarnessUnavailable", () =>
						sessions.send(
							new AbandonTurn({
								session_id: source.id,
								turn: event.turn,
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
