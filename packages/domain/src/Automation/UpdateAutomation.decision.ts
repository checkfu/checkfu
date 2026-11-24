import * as Domain from "@alchemy.run/domain"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { admissionRefusal } from "../Session/AdmissionRefusal.ts"
import { AutomationScheduleUnusable } from "./AdmitAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationArchivedError } from "./AutomationArchived.rejection.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"
import { isUsableSchedule } from "./Schedule.ts"
import { AutomationUpdated, UpdateAutomation } from "./UpdateAutomation.command.ts"

export class UpdateAutomationDecision extends Domain.Decision(UpdateAutomation, {
	reads: { agent: Agent, environment: Environment, automation: Automation },
	keyOf: (cmd) => ({
		agent: cmd.agent_id,
		environment: cmd.environment_id,
		automation: cmd.automation_id,
	}),
	decide: ({ agent, environment, automation }, cmd) => {
		if (automation.state.status === "") {
			return new AutomationNotFound({ automation_id: automation.id })
		}
		if (automation.state.status === "archived") {
			return new AutomationArchivedError({ automation_id: automation.id })
		}
		if (!isUsableSchedule(cmd.schedule.expression, cmd.schedule.timezone)) {
			return new AutomationScheduleUnusable({
				expression: cmd.schedule.expression,
				timezone: cmd.schedule.timezone,
			})
		}
		const refused = admissionRefusal(agent, environment, cmd.agent_version ?? agent.state.version)
		if (refused !== undefined) {
			return refused
		}
		const { activation } = automation.state
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
					activation: automation.state.status === "active" ? activation + 1 : activation,
				}),
			),
		]
	},
	transitions: {
		OnlyALiveAutomationOnAnActiveAgentAndEnvironmentIsUpdated: ({ before, after }) =>
			[
				before.agent.status === "active",
				before.environment.status === "active",
				[before.automation.status === "active", before.automation.status === "paused"].some(
					(live) => live,
				),
				after.automation.status === before.automation.status,
			].every((ok) => ok),
		AnUpdateRestartsTheScheduleOnlyOfAnActiveAutomation: ({ before, after }) =>
			after.automation.activation ===
			(before.automation.status === "active"
				? before.automation.activation + 1
				: before.automation.activation),
		AnUpdatePinsAVersionWithinTheAgentHead: ({ before, command }) =>
			command.agent_version === null || command.agent_version <= before.agent.version,
		AnUpdateLeavesRunsAgentAndEnvironmentUnchanged: ({ before, after }) =>
			[
				after.automation.runs === before.automation.runs,
				after.automation.reported === before.automation.reported,
				after.agent.status === before.agent.status,
				after.agent.version === before.agent.version,
				after.environment.status === before.environment.status,
				after.environment.version === before.environment.version,
			].every((ok) => ok),
	},
}) {}
