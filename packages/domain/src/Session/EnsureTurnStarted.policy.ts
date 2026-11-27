import * as Domain from "@alchemy.run/domain"
import type * as Policy from "@alchemy.run/domain/Policy"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { AbandonTurn } from "./AbandonTurn.command.ts"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { SessionStatusIdle } from "./CommitModelReply.command.ts"
import { DEFAULT_TURN_TIMEOUT_MS, TURN_TIMEOUT, TURN_TIMEOUT_MESSAGE } from "./Harness.external.ts"
import { TurnContinued } from "./PauseTurn.command.ts"
import { RunTurn, segmentKey } from "./RunTurn.saga.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { TurnInput } from "./TurnInput.view.ts"

export const ENSURED_TURN_DEADLINE = "ensured-turn-deadline"

const ensuredDeadline = (segment: number) =>
	segment === 1 ? ENSURED_TURN_DEADLINE : `${ENSURED_TURN_DEADLINE}:${segment}`

export class EnsureTurnStarted extends Domain.Policy("EnsureTurnStarted", {
	from: Session,
	on: [SessionStatusRunning, TurnContinued, SessionStatusIdle, SessionStatusTerminated],
}) {}

export const ensureTurnStarted = Effect.gen(function* () {
	const runs = yield* RunTurn
	const sessions = yield* Session
	const inputs = yield* TurnInput
	return Effect.fn(function* ({
		source,
		event,
		envelope,
	}: Policy.TriggerOf<typeof EnsureTurnStarted>) {
		const state = Option.getOrNull(
			yield* Effect.orDie(
				inputs.get(source, {
					atLeast: { stream: `Session/${source.id}`, version: envelope.seq },
				}),
			),
		)
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
		if (event._tag !== "session.status_running" && event._tag !== "turn.continued") {
			yield* unschedule(ensuredDeadline(state === null ? 1 : state.segment))
			return
		}
		if (state === null || state.turn !== event.turn || state.input.length === 0) {
			return
		}
		const segment = state.segment
		if (event._tag === "session.status_running" ? segment > 1 : event.segment !== segment) {
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
			{ after: DEFAULT_TURN_TIMEOUT_MS, commandId: ensuredDeadline(segment) },
		)
		if (segment > 1) {
			yield* unschedule(ensuredDeadline(segment - 1))
		}
		yield* runs.start(segmentKey(source.id, state.turn, segment), {
			session_id: source.id,
			agent_id: state.agent_id,
			agent_version: state.agent_version,
			environment_id: state.environment_id,
			turn: state.turn,
			input: state.input,
			resources: state.resources,
			...(state.system_context === undefined ? {} : { system_context: state.system_context }),
			last_reply_turn: state.last_reply_turn,
			segment,
		})
	})
})

export const EnsureTurnStartedLive = EnsureTurnStarted.toLayer(ensureTurnStarted)
