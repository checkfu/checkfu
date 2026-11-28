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
	text: MessageText,
	schedule: AutomationSchedule,
}

export class AutomationUpdated extends Domain.Event("automation.updated", {
	...AutomationConfiguration,
	agent_version: PositiveInt,
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

export class UpdateAutomation extends Domain.Command("UpdateAutomation", {
	input: {
		automation_id: AutomationId,
		expected_revision: PositiveInt,
		...AutomationConfiguration,
		agent_id: BoundedAgentId,
		environment_id: BoundedEnvironmentId,
		content_changed: Schema.Boolean,
		agent_version: Schema.NullOr(PositiveInt),
	},
	events: [AutomationUpdated],
	reply: { revision: PositiveInt },
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
