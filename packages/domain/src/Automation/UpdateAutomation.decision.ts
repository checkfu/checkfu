import * as Domain from "@alchemy.run/domain"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { agentRefusal, environmentRefusal } from "../Session/AdmissionRefusal.ts"
import { AutomationScheduleUnusable } from "./AdmitAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationArchivedError } from "./AutomationArchived.rejection.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"
import { isUsableSchedule, sameSchedule } from "./Schedule.ts"
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
		const agentVersion = cmd.agent_version ?? agent.state.version
		const agentChanged = cmd.agent_id !== current.agent_id || agentVersion !== current.agent_version
		const environmentChanged = cmd.environment_id !== current.environment_id
		const scheduleChanged = !sameSchedule(cmd.schedule, {
			expression: current.schedule_expression,
			timezone: current.schedule_timezone,
		})
		if (!cmd.content_changed && !agentChanged && !environmentChanged && !scheduleChanged) {
			return []
		}
		if (!isUsableSchedule(cmd.schedule.expression, cmd.schedule.timezone)) {
			return new AutomationScheduleUnusable(cmd.schedule)
		}
		const agentRefused = agentChanged ? agentRefusal(agent, agentVersion) : undefined
		if (agentRefused !== undefined) {
			return agentRefused
		}
		const environmentRefused = environmentChanged ? environmentRefusal(environment) : undefined
		if (environmentRefused !== undefined) {
			return environmentRefused
		}
		const rescheduled = [current.status === "active", scheduleChanged].every((ok) => ok)
		return [
			automation.record(
				new AutomationUpdated({
					name: cmd.name,
					description: cmd.description,
					agent_id: agent.id,
					agent_version: agentVersion,
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
	reply: (states) => ({ revision: states.automation.revision }),
	transitions: {
		AChangedAgentIsActiveAndHasThePinnedVersion: ({ before, after, command }) =>
			[
				after.automation.revision === before.automation.revision,
				[
					command.agent_id === before.automation.agent_id,
					(command.agent_version ?? before.agent.version) === before.automation.agent_version,
				].every((ok) => ok),
				[
					before.agent.status === "active",
					(command.agent_version ?? before.agent.version) <= before.agent.version,
				].every((ok) => ok),
			].some((ok) => ok),
		AChangedEnvironmentIsActive: ({ before, after, command }) =>
			[
				after.automation.revision === before.automation.revision,
				command.environment_id === before.automation.environment_id,
				before.environment.status === "active",
			].some((ok) => ok),
		AnUpdateStoresOnlyAUsableSchedule: ({ before, after, command }) =>
			after.automation.revision === before.automation.revision ||
			isUsableSchedule(command.schedule.expression, command.schedule.timezone),
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
				command.schedule.expression !== before.automation.schedule_expression ||
					command.schedule.timezone !== before.automation.schedule_timezone,
				after.automation.revision > before.automation.revision,
			].every((ok) => ok)
				? before.automation.activation + 1
				: before.automation.activation),
	},
}) {}
