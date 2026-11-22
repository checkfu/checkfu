import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { TurnAbandoned } from "./AbandonTurn.command.ts"
import { SessionStatusIdle } from "./CompleteTurn.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { UserInterrupt } from "./SendUserInterrupt.command.ts"
import { Session } from "./Session.aggregate.ts"
import { MessageText, NonNegativeInt, PositiveInt, ResourceId } from "./SessionTypes.ts"

export const TurnInputState = Schema.Struct({
	agent_id: ResourceId,
	agent_version: PositiveInt,
	environment_id: ResourceId,
	turn: NonNegativeInt,
	harness_generation: NonNegativeInt,
	input: Schema.Array(MessageText),
	unsent: Schema.Array(MessageText),
})
export type TurnInputState = typeof TurnInputState.Type

export class TurnInput extends Domain.View("TurnInput", {
	version: 1,
	from: [Session],
	key: Session,
	state: Schema.NullOr(TurnInputState),
	initial: null,
	events: [
		SessionStatusRunning,
		SessionStatusIdle,
		UserInterrupt,
		TurnAbandoned,
		SessionStatusTerminated,
	],
	evolve: {
		"session.created": (state, e) =>
			state !== null
				? state
				: {
						agent_id: e.agent_id,
						agent_version: e.agent_version,
						environment_id: e.environment_id,
						turn: 0,
						harness_generation: 0,
						input: [],
						unsent: [],
					},
		"user.message": (state, e) =>
			state === null
				? null
				: {
						...state,
						unsent: [
							...state.unsent,
							...e.content.map((block) => block.text).filter((text) => text.length > 0),
						],
					},
		"session.status_running": (state) =>
			state === null
				? null
				: {
						...state,
						turn: state.turn + 1,
						input: state.unsent,
						unsent: [],
					},
		"session.status_idle": (state) => (state === null ? null : { ...state, input: [] }),
		// A retained Pi conversation still contains the full answer. Rebuild from the published text.
		"agent.message": (state, event) =>
			state !== null && event.truncated === true
				? { ...state, harness_generation: state.harness_generation + 1 }
				: state,
		"turn.abandoned": (state) =>
			state === null ? state : { ...state, harness_generation: state.harness_generation + 1 },
		"session.status_terminated": (state) =>
			state === null ? null : { ...state, input: [], unsent: [] },
	},
	emit: {
		// An idle session has no live turn or deadline to stop on termination.
		"session.status_terminated": (event, { before }) =>
			before !== null && before.input.length > 0 ? event : undefined,
	},
}) {}
