import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AgentArchivedError } from "../Agent/AgentArchived.rejection.ts"
import { AgentNotFound } from "../Agent/AgentNotFound.rejection.ts"
import { EnvironmentArchivedError } from "../Environment/EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "../Environment/EnvironmentNotFound.rejection.ts"
import {
	AgentVersionNotFound,
	BoundedAgentId,
	BoundedEnvironmentId,
} from "../Session/AdmitSession.command.ts"
import { MessageText, ResourceId } from "../Session/SessionTypes.ts"
import { AutomationScheduleUnusable } from "./AdmitAutomation.command.ts"
import { AutomationId } from "./Automation.id.ts"
import { AutomationArchivedError } from "./AutomationArchived.rejection.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"
import {
	AutomationDescription,
	AutomationName,
	AutomationSchedule,
	NonNegativeInt,
	PositiveInt,
} from "./AutomationTypes.ts"

const AutomationConfiguration = {
	name: AutomationName,
	description: Schema.NullOr(AutomationDescription),
	agent_version: Schema.NullOr(PositiveInt),
	text: MessageText,
	schedule: AutomationSchedule,
}

export class AutomationUpdated extends Domain.Event("automation.updated", {
	...AutomationConfiguration,
	agent_id: ResourceId,
	environment_id: ResourceId,
	revision: PositiveInt,
	activation: NonNegativeInt,
	rescheduled: Schema.Boolean,
}) {}

export class AutomationRevisionConflict extends Domain.Rejection(
	"AutomationRevisionConflict",
	{ automation_id: AutomationId, expected_revision: PositiveInt, current_revision: PositiveInt },
	{
		httpApiStatus: 409,
		description: "The automation changed while this update was being made. Send the update again.",
	},
) {}

/**
 * Replaces the automation's configuration with one built on `expected_revision`. The three flags
 * say what differs from that revision's configuration; since the command is refused unless that
 * revision is still current, they hold for the configuration it replaces. Only the API handler sends
 * it, and the domain Api does not serve it.
 */
export class UpdateAutomation extends Domain.Command("UpdateAutomation", {
	input: {
		automation_id: AutomationId,
		expected_revision: PositiveInt,
		...AutomationConfiguration,
		agent_id: BoundedAgentId,
		environment_id: BoundedEnvironmentId,
		reschedule: Schema.Boolean,
		agent_changed: Schema.Boolean,
		environment_changed: Schema.Boolean,
	},
	events: [AutomationUpdated],
	rejects: [
		AutomationNotFound,
		AutomationArchivedError,
		AutomationRevisionConflict,
		AutomationScheduleUnusable,
		AgentNotFound,
		AgentArchivedError,
		AgentVersionNotFound,
		EnvironmentNotFound,
		EnvironmentArchivedError,
	],
}) {}
