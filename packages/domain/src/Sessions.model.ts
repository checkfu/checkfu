import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import { ConfirmToolDecision } from "./Session/ConfirmTool.decision.ts"
import { DiscardWorkspace, DiscardWorkspaceLive } from "./Session/DiscardWorkspace.policy.ts"
import { ReturnCustomToolResultDecision } from "./Session/ReturnCustomToolResult.decision.ts"
import { RunTurn, RunTurnLive } from "./Session/RunTurn.saga.ts"
import { Session } from "./Session/Session.aggregate.ts"
import { SessionView } from "./Session/SessionView.view.ts"
import { StartTurn, StartTurnLive } from "./Session/StartTurn.policy.ts"
import { StopModelRequest, StopModelRequestLive } from "./Session/StopModelRequest.policy.ts"
import { ToolConfirmation } from "./Session/ToolConfirmation.aggregate.ts"
import { TurnInput } from "./Session/TurnInput.view.ts"

export class Sessions extends Domain.Model("Sessions", {
	aggregates: [Session, ToolConfirmation],
	decisions: [ConfirmToolDecision, ReturnCustomToolResultDecision],
	views: [SessionView, TurnInput],
	policies: [StartTurn, StopModelRequest, DiscardWorkspace],
	sagas: [RunTurn],
	invariants: {
		SessionViewMatchesSession: (m) =>
			[
				m.Session.every((s) => {
					const view = m.SessionView.find((v) => v.id === s.id)
					if (s.state._tag === "Uninitialized") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					if (s.state._tag === "Idle") {
						return [
							view.state.id === s.id,
							view.state.status === "idle",
							view.state.turn === s.state.turn,
							!view.state.archived_at,
						].every((ok) => ok)
					}
					if (s.state._tag === "Running") {
						return [
							view.state.id === s.id,
							view.state.status === "running",
							view.state.turn === s.state.turn,
							!view.state.archived_at,
						].every((ok) => ok)
					}
					return [
						view.state.id === s.id,
						view.state.status === "terminated",
						!!view.state.archived_at === s.state.archived,
					].every((ok) => ok)
				}),
				m.SessionView.every((v) =>
					m.Session.some((s) =>
						[s.id === v.id, s.state._tag !== "Uninitialized"].every((ok) => ok),
					),
				),
			].every((ok) => ok),
		TurnInputMatchesSession: (m) =>
			[
				m.Session.every((s) => {
					const view = m.TurnInput.find((v) => v.id === s.id)
					const sessionView = m.SessionView.find((v) => v.id === s.id)
					if (s.state._tag === "Uninitialized") {
						return view === undefined
					}
					if (view === undefined || sessionView === undefined) {
						return false
					}
					const common = [
						view.state.agent_id === sessionView.state.agent_id,
						view.state.agent_version === sessionView.state.agent_version,
						view.state.environment_id === sessionView.state.environment_id,
						view.state.turn === sessionView.state.turn,
					]
					if (s.state._tag === "Idle") {
						return [
							...common,
							view.state.turn === s.state.turn,
							view.state.input.length === 0,
							view.state.unsent.length <= 8,
						].every((ok) => ok)
					}
					if (s.state._tag === "Running") {
						return [
							...common,
							view.state.turn === s.state.turn,
							view.state.input.length >= 1,
							view.state.unsent.length === s.state.pending_user_messages,
						].every((ok) => ok)
					}
					return [...common, view.state.input.length === 0, view.state.unsent.length === 0].every(
						(ok) => ok,
					)
				}),
				m.TurnInput.every((v) =>
					m.Session.some((s) =>
						[s.id === v.id, s.state._tag !== "Uninitialized"].every((ok) => ok),
					),
				),
			].every((ok) => ok),
	},
	sometimes: {
		ASessionCompletesATurn: (m) =>
			m.Session.some((s) => s.state._tag === "Idle" && s.state.turn >= 1),
		ASessionTerminates: (m) => m.Session.some((s) => s.state._tag === "Terminated"),
		ASessionIsArchived: (m) =>
			m.Session.some((s) => s.state._tag === "Terminated" && s.state.archived),
	},
	eventually: {
		EveryTurnSettles: (m) => m.Session.every((s) => s.state._tag !== "Running"),
	},
}) {}

export class SessionsApi extends Domain.Api("SessionsApi", {
	model: Sessions,
	commands: [
		"CreateSession",
		"SendUserMessage",
		"SendUserInterrupt",
		"ConfirmTool",
		"ReturnCustomToolResult",
		"ArchiveSession",
	],
	views: ["SessionView"],
}) {}

export const SessionsHandlersLive = Layer.mergeAll(
	StartTurnLive,
	StopModelRequestLive,
	DiscardWorkspaceLive,
	RunTurnLive,
)
