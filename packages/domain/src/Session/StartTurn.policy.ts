import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { AbandonTurn } from "./AbandonTurn.command.ts"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { SessionStatusIdle } from "./CommitModelReply.command.ts"
import { DEFAULT_TURN_TIMEOUT_MS, TURN_TIMEOUT, TURN_TIMEOUT_MESSAGE } from "./Harness.external.ts"
import { RunTurn, turnKey } from "./RunTurn.saga.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { TurnInput } from "./TurnInput.view.ts"

// The session policy handles running, idle and terminated in stream order.
const TURN_DEADLINE = "turn-deadline"

export class StartTurn extends Domain.Policy("StartTurn", {
	from: TurnInput,
	on: [SessionStatusRunning, SessionStatusIdle, SessionStatusTerminated],
}) {}

export const StartTurnLive = StartTurn.toLayer(
	Effect.gen(function* () {
		const runs = yield* RunTurn
		const sessions = yield* Session
		return Effect.fn(function* ({ source, state, event }) {
			if (state === null || state.turn < 1) {
				return
			}
			if (event._tag !== "session.status_running") {
				// An expired, previously cancelled or absent deadline needs no further work.
				yield* sessions
					.unschedule(source.id, TURN_DEADLINE)
					.pipe(
						Effect.catchTag(
							["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"],
							() => Effect.void,
						),
					)
				return
			}
			yield* sessions.schedule(
				new AbandonTurn({
					session_id: source.id,
					turn: state.turn,
					error_type: TURN_TIMEOUT,
					message: TURN_TIMEOUT_MESSAGE,
				}),
				{ after: DEFAULT_TURN_TIMEOUT_MS, commandId: TURN_DEADLINE },
			)
			yield* runs.start(turnKey(source.id, state.turn), {
				session_id: source.id,
				agent_id: state.agent_id,
				agent_version: state.agent_version,
				environment_id: state.environment_id,
				turn: state.turn,
				input: state.input,
				...(state.last_reply_turn === undefined ? {} : { last_reply_turn: state.last_reply_turn }),
				...(state.resume === true ? { resume: true as const } : {}),
			})
		})
	}),
)
