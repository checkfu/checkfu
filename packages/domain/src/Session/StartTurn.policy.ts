import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { AbandonTurn } from "./AbandonTurn.command.ts"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { SessionStatusIdle } from "./CommitModelReply.command.ts"
import { DEFAULT_TURN_TIMEOUT_MS, TURN_TIMEOUT, TURN_TIMEOUT_MESSAGE } from "./Harness.external.ts"
import { TurnContinued } from "./PauseTurn.command.ts"
import { RunTurn, segmentKey } from "./RunTurn.saga.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { TurnInput } from "./TurnInput.view.ts"

const deadline = (segment: number) => (segment === 1 ? "turn-deadline" : `turn-deadline:${segment}`)

export class StartTurn extends Domain.Policy("StartTurn", {
	from: TurnInput,
	on: [SessionStatusRunning, TurnContinued, SessionStatusIdle, SessionStatusTerminated],
}) {}

export const StartTurnLive = StartTurn.toLayer(
	Effect.gen(function* () {
		const runs = yield* RunTurn
		const sessions = yield* Session
		return Effect.fn(function* ({ source, state, event }) {
			if (state === null || state.turn < 1) {
				return
			}
			const segment = state.segment
			const unschedule = (id: string) =>
				sessions
					.unschedule(source.id, id)
					.pipe(
						Effect.catchTag(
							["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"],
							() => Effect.void,
						),
					)
			if (event._tag === "session.status_idle" && event.stop_reason.type === "requires_action") {
				return
			}
			if (event._tag === "session.status_running" && segment > 1) {
				return
			}
			if (event._tag !== "session.status_running" && event._tag !== "turn.continued") {
				yield* unschedule(deadline(segment))
				return
			}
			yield* sessions.schedule(
				new AbandonTurn({
					session_id: source.id,
					turn: state.turn,
					segment,
					error_type: TURN_TIMEOUT,
					message: TURN_TIMEOUT_MESSAGE,
				}),
				{ after: DEFAULT_TURN_TIMEOUT_MS, commandId: deadline(segment) },
			)
			if (segment > 1) {
				yield* unschedule(deadline(segment - 1))
			}
			yield* runs.start(segmentKey(source.id, state.turn, segment), {
				session_id: source.id,
				agent_id: state.agent_id,
				agent_version: state.agent_version,
				environment_id: state.environment_id,
				resources: state.resources,
				turn: state.turn,
				input: state.input,
				...(state.system_context === undefined ? {} : { system_context: state.system_context }),
				...(state.unattended === true ? { unattended: true as const } : {}),
				last_reply_turn: state.last_reply_turn,
				segment,
			})
		})
	}),
)
