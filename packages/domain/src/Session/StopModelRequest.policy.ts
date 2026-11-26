import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { AbandonTurn, TurnAbandoned } from "./AbandonTurn.command.ts"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { HARNESS_UNAVAILABLE, HARNESS_UNAVAILABLE_MESSAGE, Harness } from "./Harness.external.ts"
import { TurnId, turnKey } from "./RunTurn.saga.ts"
import { UserInterrupt } from "./SendUserInterrupt.command.ts"
import { Session } from "./Session.aggregate.ts"
import { TurnInput } from "./TurnInput.view.ts"

export class StopModelRequest extends Domain.Policy("StopModelRequest", {
	from: TurnInput,
	on: [UserInterrupt, TurnAbandoned, SessionStatusTerminated],
	key: TurnId,
	keyOf: {
		TurnInput: ({ source, state }) =>
			state !== null && state.turn > 0 ? turnKey(source.id, state.turn) : undefined,
	},
}) {}

export const StopModelRequestLive = StopModelRequest.toLayer(
	Effect.gen(function* () {
		const harness = yield* Harness
		const sessions = yield* Session
		return Effect.fn(function* ({ source, state, event }) {
			if (state === null || state.turn === 0) {
				return
			}
			const interrupt = harness.interrupt({ session_id: source.id, turn: state.turn })
			if (event._tag === "user.interrupt") {
				yield* interrupt.pipe(
					Effect.catchTag("HarnessUnavailable", () =>
						sessions
							.send(
								new AbandonTurn({
									session_id: source.id,
									turn: state.turn,
									segment: state.segment ?? 1,
									error_type: HARNESS_UNAVAILABLE,
									message: HARNESS_UNAVAILABLE_MESSAGE,
								}),
							)
							.pipe(
								Effect.flatMap((receipt) =>
									receipt.events.length === 0 ? Effect.orDie(interrupt) : Effect.void,
								),
							),
					),
				)
				return
			}
			yield* interrupt.pipe(Effect.orDie)
		})
	}),
)
