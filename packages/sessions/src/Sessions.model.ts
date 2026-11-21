import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import { TimeoutModelProvider } from "./Session/ModelProvider.external.ts"
import { RunTurn, RunTurnLive } from "./Session/RunTurn.saga.ts"
import { Session } from "./Session/Session.aggregate.ts"
import { SessionTranscript } from "./Session/SessionTranscript.view.ts"
import { SessionView } from "./Session/SessionView.view.ts"
import { StartTurn, StartTurnLive } from "./Session/StartTurn.policy.ts"

export class Sessions extends Domain.Model("Sessions", {
	aggregates: [Session],
	views: [SessionView, SessionTranscript],
	policies: [StartTurn],
	sagas: [RunTurn],
	sometimes: {
		ASessionCompletesATurn: (m) =>
			m.Session.some((s) => s.state._tag === "Idle" && s.state.turn >= 1),
		ASessionTerminates: (m) => m.Session.some((s) => s.state._tag === "Terminated"),
	},
	eventually: {
		EveryTurnSettles: (m) => m.Session.every((s) => s.state._tag !== "Running"),
	},
}) {}

export class SessionsApi extends Domain.Api("SessionsApi", {
	model: Sessions,
	commands: ["CreateSession", "SendUserMessage", "SendUserInterrupt", "ArchiveSession"],
	views: ["SessionView"],
}) {}

export const SessionsHandlersLive = Layer.mergeAll(
	StartTurnLive,
	RunTurnLive.pipe(Layer.provide(TimeoutModelProvider)),
)
