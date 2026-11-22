import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import { RunTurn, RunTurnLive } from "./Session/RunTurn.saga.ts"
import { Session } from "./Session/Session.aggregate.ts"
import { SessionView } from "./Session/SessionView.view.ts"
import { StartTurn, StartTurnLive } from "./Session/StartTurn.policy.ts"
import { StopModelRequest, StopModelRequestLive } from "./Session/StopModelRequest.policy.ts"
import { TurnInput } from "./Session/TurnInput.view.ts"

export class Sessions extends Domain.Model("Sessions", {
	aggregates: [Session],
	views: [SessionView, TurnInput],
	policies: [StartTurn, StopModelRequest],
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

export const SessionsHandlersLive = Layer.mergeAll(StartTurnLive, StopModelRequestLive, RunTurnLive)
