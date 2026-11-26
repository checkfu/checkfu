import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { Session } from "./Session.aggregate.ts"

const SessionTurnId = Schema.String.pipe(Schema.brand("SessionTurnId"))

export const sessionTurnKey = (sessionId: string, turn: number) =>
	SessionTurnId.make(`${sessionId}:${turn}`)

export class SessionTurnCompletion extends Domain.View("SessionTurnCompletion", {
	version: 1,
	from: [Session],
	key: SessionTurnId,
	keyOf: {
		"session.status_idle": ({ source, event }) =>
			event.stop_reason.type === "requires_action"
				? undefined
				: sessionTurnKey(source.id, event.turn),
		"session.status_terminated": ({ source, event }) =>
			event.running_turn === null || event.running_turn === undefined
				? undefined
				: sessionTurnKey(source.id, event.running_turn),
	},
	state: Schema.NullOr(Schema.DateTimeUtc),
	initial: null,
	evolve: {
		"session.status_idle": (state, _event, ctx) => state ?? ctx.at,
		"session.status_terminated": (state, _event, ctx) => state ?? ctx.at,
	},
}) {}
