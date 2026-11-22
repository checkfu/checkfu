import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { AbandonTurn, TurnAbandoned } from "./AbandonTurn.command.ts"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import {
	HARNESS_UNAVAILABLE,
	HARNESS_UNAVAILABLE_MESSAGE,
	ModelProvider,
} from "./ModelProvider.external.ts"
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
		const provider = yield* ModelProvider
		const sessions = yield* Session
		return Effect.fn(function* ({ source, state, event }) {
			if (state === null || state.turn === 0) return
			// TurnInput advances the generation when it projects the abandonment.
			const generation =
				event._tag === "turn.abandoned" ? state.harness_generation - 1 : state.harness_generation
			const interrupt = provider.interrupt({ session_id: source.id, turn: state.turn, generation })
			if (event._tag === "user.interrupt") {
				yield* interrupt.pipe(
					Effect.catchTag("HarnessUnavailable", () =>
						sessions.send(
							new AbandonTurn({
								session_id: source.id,
								turn: state.turn,
								error_type: HARNESS_UNAVAILABLE,
								message: HARNESS_UNAVAILABLE_MESSAGE,
							}),
						),
					),
				)
				return
			}
			// Keep cleanup pending in this turn's durable inbox until the harness acknowledges it.
			yield* interrupt.pipe(Effect.orDie)
		})
	}),
)
