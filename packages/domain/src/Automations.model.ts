import * as Domain from "@alchemy.run/domain"
import { ArmAutomation, ArmAutomationLive } from "./Automation/ArmAutomation.policy.ts"
import { Automation } from "./Automation/Automation.aggregate.ts"
import { AutomationRunView } from "./Automation/AutomationRunView.view.ts"
import { AutomationView } from "./Automation/AutomationView.view.ts"

export class Automations extends Domain.Model("Automations", {
	aggregates: [Automation],
	views: [AutomationView, AutomationRunView],
	policies: [ArmAutomation],
	invariants: {
		AutomationViewMatchesAutomation: (m) =>
			[
				m.Automation.every((a) => {
					const view = m.AutomationView.find((v) => v.id === a.id)
					if (a.state.status === "") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === a.id,
						view.state.status === a.state.status,
						view.state.runs === a.state.runs,
						view.state.activation === a.state.activation,
						(view.state.pause_reason !== null) === (a.state.status === "paused"),
						!!view.state.archived_at === (a.state.status === "archived"),
					].every((ok) => ok)
				}),
				m.AutomationView.every((v) =>
					m.Automation.some((a) => [a.id === v.id, a.state.status !== ""].every((ok) => ok)),
				),
			].every((ok) => ok),
		RunLedgerHoldsEveryReportedRun: (m) =>
			m.Automation.every((a) => {
				const ledger = m.AutomationRunView.find((v) => v.id === a.id)
				return (ledger === undefined ? 0 : ledger.state.recorded) === a.state.reported
			}),
		AutomationViewRevisionMatchesAutomation: (m) =>
			m.Automation.every((a) => {
				const view = m.AutomationView.find((v) => v.id === a.id)
				return view === undefined || view.state.revision === a.state.revision
			}),
	},
	sometimes: {
		AnAutomationFiresOnSchedule: (m) =>
			m.Automation.some((a) =>
				[a.state.runs >= 1, a.state.last_scheduled_at > 0].every((ok) => ok),
			),
		AnAutomationIsPaused: (m) => m.Automation.some((a) => a.state.status === "paused"),
		AnAutomationIsArchived: (m) => m.Automation.some((a) => a.state.status === "archived"),
	},
}) {}

export class AutomationsApi extends Domain.Api("AutomationsApi", {
	model: Automations,
	commands: [
		"CreateAutomation",
		"PauseAutomation",
		"UnpauseAutomation",
		"ArchiveAutomation",
		"RunAutomation",
	],
	views: ["AutomationView", "AutomationRunView"],
}) {}

export const AutomationsHandlersLive = ArmAutomationLive
