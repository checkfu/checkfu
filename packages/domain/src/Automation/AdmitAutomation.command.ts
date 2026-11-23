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
import { MessageText } from "../Session/SessionTypes.ts"
import { AutomationId } from "./Automation.id.ts"
import { AutomationSlotReserved } from "./AutomationCapacity.aggregate.ts"
import { AutomationCapacityId } from "./AutomationCapacity.id.ts"
import {
	AutomationName,
	AutomationSchedule,
	CronExpression,
	PositiveInt,
	Timezone,
} from "./AutomationTypes.ts"
import { AutomationAlreadyExists, AutomationCreated } from "./CreateAutomation.command.ts"

export class AutomationLimitReached extends Domain.Rejection(
	"AutomationLimitReached",
	{ limit: PositiveInt },
	{
		httpApiStatus: 429,
		description: "The limit of automations is reached. Archive one to create another.",
	},
) {}

export class AutomationScheduleUnusable extends Domain.Rejection(
	"AutomationScheduleUnusable",
	{ expression: CronExpression, timezone: Timezone },
	{
		httpApiStatus: 400,
		description:
			"The schedule must be a five-field cron expression whose minute field is a single number, read in an IANA time zone name.",
	},
) {}

export class AdmitAutomation extends Domain.Command("AdmitAutomation", {
	input: {
		automation_id: AutomationId,
		capacity_id: AutomationCapacityId,
		name: AutomationName,
		agent_id: BoundedAgentId,
		agent_version: Schema.NullOr(PositiveInt),
		environment_id: BoundedEnvironmentId,
		text: MessageText,
		schedule: AutomationSchedule,
	},
	events: [AutomationCreated, AutomationSlotReserved],
	rejects: [
		AutomationScheduleUnusable,
		AgentNotFound,
		AgentArchivedError,
		AgentVersionNotFound,
		EnvironmentNotFound,
		EnvironmentArchivedError,
		AutomationAlreadyExists,
		AutomationLimitReached,
	],
}) {}
