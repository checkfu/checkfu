import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { TurnAbandoned } from "./AbandonTurn.command.ts"
import { SessionStatusIdle } from "./CommitModelReply.command.ts"
import { TurnContinued } from "./PauseTurn.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { UserInterrupt } from "./SendUserInterrupt.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionResources } from "./SessionResource.ts"
import { MessageText, NonNegativeInt, PositiveInt, ResourceId } from "./SessionTypes.ts"

export const TurnInputState = Schema.Struct({
	agent_id: ResourceId,
	agent_version: PositiveInt,
	environment_id: ResourceId,
	resources: SessionResources,
	turn: NonNegativeInt,
	input: Schema.Array(MessageText),
	system_context: Schema.optionalKey(Schema.String),
	unsent: Schema.Array(MessageText),
	last_reply_turn: NonNegativeInt,
	segment: PositiveInt,
})
export type TurnInputState = typeof TurnInputState.Type

export class TurnInput extends Domain.View("TurnInput", {
	version: 5,
	from: [Session],
	key: Session,
	state: Schema.NullOr(TurnInputState),
	initial: null,
	events: [
		SessionStatusRunning,
		TurnContinued,
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
						resources: e.resources,
						turn: 0,
						input: [],
						unsent: [],
						last_reply_turn: 0,
						segment: 1,
					},
		"system.message": (state, event) => {
			if (state === null) {
				return null
			}
			const text = event.content.map((block) => block.text).join("\n")
			return {
				...state,
				system_context:
					state.system_context === undefined ? text : `${state.system_context}\n\n${text}`,
			}
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
		"session.status_running": (state, e) =>
			state === null
				? null
				: e.turn === state.turn
					? { ...state, segment: state.segment + 1 }
					: { ...state, turn: e.turn, input: state.unsent, unsent: [], segment: 1 },
		"turn.continued": (state, e) =>
			state === null || e.turn !== state.turn ? state : { ...state, segment: e.segment },
		"agent.message": (state) => (state === null ? null : { ...state, last_reply_turn: state.turn }),
		"session.status_idle": (state, e) =>
			state === null || e.stop_reason.type === "requires_action" ? state : { ...state, input: [] },
		"session.status_terminated": (state) =>
			state === null ? null : { ...state, input: [], unsent: [] },
	},
	emit: {
		"session.status_terminated": (event, { before }) =>
			before !== null && before.input.length > 0 ? event : undefined,
	},
}) {}
