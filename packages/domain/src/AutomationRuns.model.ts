import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import { Agent } from "./Agent/Agent.aggregate.ts"
import { CreateAgentDecision } from "./Agent/CreateAgent.decision.ts"
import { AdmitAutomationDecision } from "./Automation/AdmitAutomation.decision.ts"
import { Automation } from "./Automation/Automation.aggregate.ts"
import { AutomationCapacity } from "./Automation/AutomationCapacity.aggregate.ts"
import { capacityOf } from "./Automation/AutomationCapacity.id.ts"
import { AutomationRunView } from "./Automation/AutomationRunView.view.ts"
import { AutomationView } from "./Automation/AutomationView.view.ts"
import {
	FreeAutomationSlot,
	FreeAutomationSlotLive,
} from "./Automation/FreeAutomationSlot.policy.ts"
import { OpenAutomationSessionDecision } from "./Automation/OpenAutomationSession.decision.ts"
import { AutomationRunSetup } from "./AutomationRuns/AutomationRunSetup.aggregate.ts"
import {
	PrepareAutomationRunFixture,
	PrepareAutomationRunFixtureLive,
} from "./AutomationRuns/PrepareAutomationRunFixture.policy.ts"
import {
	StartAutomationRun,
	StartAutomationRunLive,
} from "./Automation/StartAutomationRun.policy.ts"
import { Environment } from "./Environment/Environment.aggregate.ts"
import { Session } from "./Session/Session.aggregate.ts"

export class AutomationRuns extends Domain.Model("AutomationRuns", {
	aggregates: [AutomationRunSetup, Agent, Environment, Session, Automation, AutomationCapacity],
	decisions: [CreateAgentDecision, AdmitAutomationDecision, OpenAutomationSessionDecision],
	views: [AutomationView, AutomationRunView],
	policies: [PrepareAutomationRunFixture, StartAutomationRun, FreeAutomationSlot],
	invariants: {
		EveryRunReportMatchesItsFiring: (m) =>
			m.Automation.every((automation) =>
				automation.events.every((report) => {
					if (report._tag !== "automation.run_started" && report._tag !== "automation.run_failed") {
						return true
					}
					return automation.events.some(
						(fired) =>
							fired._tag === "automation.fired" &&
							fired.run === report.run &&
							fired.trigger === report.trigger &&
							fired.scheduled_at === report.scheduled_at &&
							(report._tag !== "automation.run_started" || report.session_id === fired.session_id),
					)
				}),
			),
		ReservedSlotsCoverLiveAutomations: (m) => {
			const live = m.Automation.filter((a) =>
				[a.state.status === "active", a.state.status === "paused"].some((ok) => ok),
			)
			return [
				live.every((automation) =>
					m.AutomationCapacity.some((capacity) => capacity.id === capacityOf(automation.state)),
				),
				m.AutomationCapacity.every(
					(capacity) =>
						capacity.state.reserved >=
						live.filter((automation) => capacity.id === capacityOf(automation.state)).length,
				),
			].every((ok) => ok)
		},
	},
	eventually: {
		EveryFiredRunIsReported: (m) =>
			m.Automation.every((a) => {
				const ledger = m.AutomationRunView.find((v) => v.id === a.id)
				return [
					a.state.reported === a.state.runs,
					(ledger === undefined ? 0 : ledger.state.recorded) === a.state.reported,
				].every((ok) => ok)
			}),
		ReservedSlotsEqualLiveAutomations: (m) => {
			const live = m.Automation.filter((a) =>
				[a.state.status === "active", a.state.status === "paused"].some((ok) => ok),
			)
			return [
				live.every((automation) =>
					m.AutomationCapacity.some((capacity) => capacity.id === capacityOf(automation.state)),
				),
				m.AutomationCapacity.every(
					(capacity) =>
						capacity.state.reserved ===
						live.filter((automation) => capacity.id === capacityOf(automation.state)).length,
				),
			].every((ok) => ok)
		},
	},
	sometimes: {
		AStartedRunIsReported: (m) =>
			m.Automation.some((automation) =>
				automation.events.some(
					(report) =>
						report._tag === "automation.run_started" &&
						m.Session.some(
							(session) =>
								session.id === report.session_id &&
								session.events.some(
									(created) =>
										created._tag === "session.created" && created.automation_id === automation.id,
								),
						),
				),
			),
		AFailedRunPausesTheAutomation: (m) =>
			m.Automation.some((automation) =>
				automation.events.some((report, index) => {
					const next = automation.events[index + 1]
					return (
						report._tag === "automation.run_failed" &&
						next?._tag === "automation.paused" &&
						next.reason === report.error.type
					)
				}),
			),
		AnArchivedAutomationFreesItsSlot: (m) =>
			[
				m.Automation.some((a) => a.state.status === "archived"),
				m.AutomationCapacity.some((c) => c.state.reserved === 0),
			].every((ok) => ok),
	},
}) {}

export class AutomationRunsApi extends Domain.Api("AutomationRunsApi", {
	model: AutomationRuns,
	commands: ["PrepareAutomationRun", "RunAutomation", "ArchiveAgent", "ArchiveAutomation"],
	views: ["AutomationView", "AutomationRunView"],
}) {}

export const AutomationRunsHandlersLive = Layer.mergeAll(
	PrepareAutomationRunFixtureLive,
	StartAutomationRunLive,
	FreeAutomationSlotLive,
)
