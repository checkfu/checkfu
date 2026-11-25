import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { TurnAbandoned } from "./AbandonTurn.command.ts"
import { SessionStatusIdle } from "./CommitModelReply.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { UserInterrupt } from "./SendUserInterrupt.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionResources } from "./SessionResource.ts"
import { MessageText, NonNegativeInt, PositiveInt, ResourceId } from "./SessionTypes.ts"

export const TurnInputState = Schema.Struct({
	agent_id: ResourceId,
	agent_version: PositiveInt,
	environment_id: ResourceId,
	resources: SessionResources.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
	turn: NonNegativeInt,
	input: Schema.Array(MessageText),
	unsent: Schema.Array(MessageText),
	last_reply_turn: Schema.optionalKey(NonNegativeInt),
})
export type TurnInputState = typeof TurnInputState.Type

export class TurnInput extends Domain.View("TurnInput", {
	version: 3,
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
						resources: e.resources,
						turn: 0,
						input: [],
						unsent: [],
						last_reply_turn: 0,
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
				: {
						...state,
						turn: e.turn,
						input: state.unsent,
						unsent: [],
					},
		"agent.message": (state) => (state === null ? null : { ...state, last_reply_turn: state.turn }),
		"session.status_idle": (state) => (state === null ? null : { ...state, input: [] }),
		"session.status_terminated": (state) =>
			state === null ? null : { ...state, input: [], unsent: [] },
	},
	emit: {
		"session.status_terminated": (event, { before }) =>
			before !== null && before.input.length > 0 ? event : undefined,
	},
}) {}
