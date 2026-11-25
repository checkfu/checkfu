import * as Domain from "@alchemy.run/domain"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { agentRefusal, environmentRefusal } from "../Session/AdmissionRefusal.ts"
import { AutomationScheduleUnusable } from "./AdmitAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationArchivedError } from "./AutomationArchived.rejection.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"
import { isUsableSchedule } from "./Schedule.ts"
import {
	AutomationRevisionConflict,
	AutomationUpdated,
	UpdateAutomation,
} from "./UpdateAutomation.command.ts"

export class UpdateAutomationDecision extends Domain.Decision(UpdateAutomation, {
	reads: { agent: Agent, environment: Environment, automation: Automation },
	keyOf: (cmd) => ({
		agent: cmd.agent_id,
		environment: cmd.environment_id,
		automation: cmd.automation_id,
	}),
	decide: ({ agent, environment, automation }, cmd) => {
		const current = automation.state
		if (current.status === "") {
			return new AutomationNotFound({ automation_id: automation.id })
		}
		if (current.status === "archived") {
			return new AutomationArchivedError({ automation_id: automation.id })
		}
		if (cmd.expected_revision !== current.revision) {
			return new AutomationRevisionConflict({
				automation_id: automation.id,
				expected_revision: cmd.expected_revision,
				current_revision: current.revision,
			})
		}
		if (!isUsableSchedule(cmd.schedule.expression, cmd.schedule.timezone)) {
			return new AutomationScheduleUnusable(cmd.schedule)
		}
		const agentRefused = cmd.agent_changed
			? agentRefusal(agent, cmd.agent_version ?? agent.state.version)
			: undefined
		if (agentRefused !== undefined) {
			return agentRefused
		}
		const environmentRefused = cmd.environment_changed ? environmentRefusal(environment) : undefined
		if (environmentRefused !== undefined) {
			return environmentRefused
		}
		const rescheduled = current.status === "active" && cmd.reschedule
		return [
			automation.record(
				new AutomationUpdated({
					name: cmd.name,
					description: cmd.description,
					agent_id: agent.id,
					agent_version: cmd.agent_version,
					environment_id: environment.id,
					text: cmd.text,
					schedule: cmd.schedule,
					revision: current.revision + 1,
					activation: rescheduled ? current.activation + 1 : current.activation,
					rescheduled,
				}),
			),
		]
	},
	transitions: {
		AnUpdateNeedsTheCurrentRevisionOfALiveAutomation: ({ before, after, command }) =>
			after.automation.revision === before.automation.revision ||
			[
				command.expected_revision === before.automation.revision,
				[before.automation.status === "active", before.automation.status === "paused"].some(
					(live) => live,
				),
				after.automation.revision === before.automation.revision + 1,
				after.automation.status === before.automation.status,
			].every((ok) => ok),
		OnlyANewScheduleOnAnActiveAutomationRestartsIt: ({ before, after, command }) =>
			after.automation.activation ===
			([
				before.automation.status === "active",
				command.reschedule,
				after.automation.revision > before.automation.revision,
			].every((ok) => ok)
				? before.automation.activation + 1
				: before.automation.activation),
	},
}) {}
