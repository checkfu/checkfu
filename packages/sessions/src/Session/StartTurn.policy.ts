import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { RecordSessionError } from "./RecordSessionError.command.ts"
import { RunTurn, turnKey } from "./RunTurn.saga.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionTranscript } from "./SessionTranscript.view.ts"

export class StartTurn extends Domain.Policy("StartTurn", {
	from: SessionTranscript,
	on: [SessionStatusRunning],
}) {}

export const StartTurnLive = StartTurn.toLayer(
	Effect.gen(function* () {
		const sessions = yield* Session
		const runs = yield* RunTurn
		return Effect.fn(function* ({ source, state }) {
			if (state === null || state.turn < 1) {
				return
			}
			if (state.agent_id === "" || state.environment_id === "") {
				yield* sessions
					.send(
						new RecordSessionError({
							session_id: source.id,
							turn: state.turn,
							error: {
								type: "invalid_session_configuration",
								message: "Session is missing an agent or environment identifier.",
								retry_status: { type: "terminal" },
							},
						}),
					)
					.pipe(
						Effect.asVoid,
						Effect.catchTag("SessionNotFound", () => Effect.void),
						Effect.catchTag("SessionNotRunning", () => Effect.void),
						Effect.catchTag("SessionTerminated", () => Effect.void),
						Effect.catchTag("StaleTurn", () => Effect.void),
						Effect.catchTag("OpenModelRequests", () => Effect.void),
					)
				return
			}
			yield* runs.start(turnKey(source.id, state.turn), {
				session_id: source.id,
				agent_id: state.agent_id,
				agent_version: state.agent_version,
				environment_id: state.environment_id,
				turn: state.turn,
				messages: state.messages,
			})
		})
	}),
)
