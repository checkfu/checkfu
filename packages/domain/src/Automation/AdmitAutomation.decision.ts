import * as Domain from "@alchemy.run/domain"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { AgentArchivedError } from "../Agent/AgentArchived.rejection.ts"
import { AgentNotFound } from "../Agent/AgentNotFound.rejection.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { EnvironmentArchivedError } from "../Environment/EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "../Environment/EnvironmentNotFound.rejection.ts"
import { AgentVersionNotFound } from "../Session/AdmitSession.command.ts"
import {
	AdmitAutomation,
	AutomationLimitReached,
	AutomationScheduleUnusable,
} from "./AdmitAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import {
	AutomationCapacity,
	AutomationSlotReserved,
	MAX_LIVE_AUTOMATIONS,
} from "./AutomationCapacity.aggregate.ts"
import { AUTOMATION_CAPACITY } from "./AutomationCapacity.id.ts"
import { AutomationAlreadyExists, AutomationCreated } from "./CreateAutomation.command.ts"
import { isUsableSchedule } from "./Schedule.ts"

export class AdmitAutomationDecision extends Domain.Decision(AdmitAutomation, {
	reads: {
		agent: Agent,
		environment: Environment,
		capacity: AutomationCapacity,
		automation: Automation,
	},
	keyOf: (cmd) => ({
		agent: cmd.agent_id,
		environment: cmd.environment_id,
		capacity: cmd.capacity_id,
		automation: cmd.automation_id,
	}),
	decide: ({ agent, environment, capacity, automation }, cmd) => {
		if (automation.state.status !== "") {
			return new AutomationAlreadyExists({ automation_id: automation.id })
		}
		if (!isUsableSchedule(cmd.schedule.expression, cmd.schedule.timezone)) {
			return new AutomationScheduleUnusable({
				expression: cmd.schedule.expression,
				timezone: cmd.schedule.timezone,
			})
		}
		if (agent.state.status === "") {
			return new AgentNotFound({ agent_id: agent.id })
		}
		if (agent.state.status !== "active") {
			return new AgentArchivedError({ agent_id: agent.id })
		}
		if (cmd.agent_version !== null && cmd.agent_version > agent.state.version) {
			return new AgentVersionNotFound({ agent_id: agent.id, version: cmd.agent_version })
		}
		if (environment.state.status === "" || environment.state.status === "deleted") {
			return new EnvironmentNotFound({ environment_id: environment.id })
		}
		if (environment.state.status !== "active") {
			return new EnvironmentArchivedError({ environment_id: environment.id })
		}
		if (capacity.state.reserved >= MAX_LIVE_AUTOMATIONS) {
			return new AutomationLimitReached({ limit: MAX_LIVE_AUTOMATIONS })
		}
		return [
			automation.record(
				new AutomationCreated({
					...(cmd.capacity_id === AUTOMATION_CAPACITY ? {} : { capacity_id: cmd.capacity_id }),
					name: cmd.name,
					description: cmd.description,
					agent_id: agent.id,
					agent_version: cmd.agent_version ?? agent.state.version,
					environment_id: environment.id,
					text: cmd.text,
					schedule: cmd.schedule,
				}),
			),
			capacity.record(new AutomationSlotReserved({ automation_id: automation.id })),
		]
	},
	transitions: {
		AnAdmittedAutomationHasAUsableSchedule: ({ command }) =>
			isUsableSchedule(command.schedule.expression, command.schedule.timezone),
		OnlyActiveAgentAndEnvironmentAdmitAutomation: ({ before, after }) =>
			[
				before.agent.status === "active",
				before.environment.status === "active",
				before.automation.status === "",
				after.automation.status === "active",
			].every((ok) => ok),
		PinnedVersionWithinAgentHead: ({ before, command }) =>
			command.agent_version === null || command.agent_version <= before.agent.version,
		AdmissionTakesOneSlotWithinTheLimit: ({ before, after }) =>
			[
				before.capacity.reserved < MAX_LIVE_AUTOMATIONS,
				after.capacity.reserved === before.capacity.reserved + 1,
			].every((ok) => ok),
		AdmissionLeavesAgentAndEnvironmentUnchanged: ({ before, after }) =>
			[
				after.agent.status === before.agent.status,
				after.agent.version === before.agent.version,
				after.environment.status === before.environment.status,
				after.environment.version === before.environment.version,
			].every((ok) => ok),
	},
}) {}
