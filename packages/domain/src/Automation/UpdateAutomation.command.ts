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

export class AutomationUpdated extends Domain.Event("automation.updated", {
	name: AutomationName,
	description: Schema.NullOr(AutomationDescription),
	agent_id: ResourceId,
	agent_version: Schema.NullOr(PositiveInt),
	environment_id: ResourceId,
	text: MessageText,
	schedule: AutomationSchedule,
	activation: NonNegativeInt,
}) {}

export class UpdateAutomation extends Domain.Command("UpdateAutomation", {
	input: {
		automation_id: AutomationId,
		name: AutomationName,
		description: Schema.NullOr(AutomationDescription),
		agent_id: BoundedAgentId,
		agent_version: Schema.NullOr(PositiveInt),
		environment_id: BoundedEnvironmentId,
		text: MessageText,
		schedule: AutomationSchedule,
	},
	events: [AutomationUpdated],
	rejects: [
		AutomationNotFound,
		AutomationArchivedError,
		AutomationScheduleUnusable,
		AgentNotFound,
		AgentArchivedError,
		AgentVersionNotFound,
		EnvironmentNotFound,
		EnvironmentArchivedError,
	],
}) {}
