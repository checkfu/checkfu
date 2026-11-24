import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { TurnAbandoned } from "./AbandonTurn.command.ts"
import { SessionStatusIdle } from "./CommitModelReply.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { UserInterrupt } from "./SendUserInterrupt.command.ts"
import { Session } from "./Session.aggregate.ts"
import { MessageText, NonNegativeInt, PositiveInt, ResourceId } from "./SessionTypes.ts"

/**
 * The input a resumed turn carries, since a running turn's input is never
 * empty. Nothing reads it: `resume` says the turn resumes a paused one, so a
 * user who types the same text sends an ordinary message.
 */
export const RESUME_INPUT = "[checkfu:resume]"

export const TurnInputState = Schema.Struct({
	agent_id: ResourceId,
	agent_version: PositiveInt,
	environment_id: ResourceId,
	turn: NonNegativeInt,
	input: Schema.Array(MessageText),
	unsent: Schema.Array(MessageText),
	// The last turn whose reply the session published. A later turn's reply never reached the
	// session, so the model must not keep it. Absent in state written before it existed.
	last_reply_turn: Schema.optionalKey(NonNegativeInt),
	// The session's last turn paused; its tool calls are still parked in the harness. Optional, so
	// a state queued in a policy delivery before it existed still reads, as not awaiting.
	awaiting: Schema.optionalKey(Schema.Boolean),
	// The running turn resumes a paused one: no message set it running, its answers did.
	// Optional, so a state stored before it existed still reads.
	resume: Schema.optionalKey(Schema.Boolean),
})
export type TurnInputState = typeof TurnInputState.Type

export class TurnInput extends Domain.View("TurnInput", {
	version: 4,
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
						input: [],
						unsent: [],
						last_reply_turn: 0,
						awaiting: false,
						resume: false,
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
						input: state.unsent.length > 0 ? state.unsent : [RESUME_INPUT],
						unsent: [],
						awaiting: false,
						resume: state.unsent.length === 0,
					},
		"agent.message": (state) => (state === null ? null : { ...state, last_reply_turn: state.turn }),
		"session.status_idle": (state, e) =>
			state === null
				? null
				: {
						...state,
						input: [],
						awaiting: e.stop_reason.type === "requires_action",
						resume: false,
					},
		"user.interrupt": (state) => (state === null ? null : { ...state, awaiting: false }),
		"session.status_terminated": (state) =>
			state === null ? null : { ...state, input: [], unsent: [], awaiting: false, resume: false },
	},
	emit: {
		// An idle session has no live turn or deadline to stop on termination, unless it paused.
		"session.status_terminated": (event, { before }) =>
			before !== null && (before.input.length > 0 || before.awaiting) ? event : undefined,
	},
}) {}
