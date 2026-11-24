import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { MessageText, ResourceId } from "../Session/SessionTypes.ts"
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
	agent_id: ResourceId,
	agent_version: Schema.NullOr(PositiveInt),
	environment_id: ResourceId,
	text: MessageText,
	schedule: AutomationSchedule,
}

export class AutomationUpdated extends Domain.Event("automation.updated", {
	...AutomationConfiguration,
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
 * Replaces the automation's configuration with one built on `expected_revision`, so a sender that
 * merged a partial change onto that revision never overwrites a later one. `reschedule` says the
 * schedule differs from that revision's.
 */
export class UpdateAutomation extends Domain.Command("UpdateAutomation", {
	input: {
		automation_id: AutomationId,
		expected_revision: PositiveInt,
		reschedule: Schema.Boolean,
		...AutomationConfiguration,
	},
	events: [AutomationUpdated],
	rejects: [AutomationNotFound, AutomationArchivedError, AutomationRevisionConflict],
}) {}
