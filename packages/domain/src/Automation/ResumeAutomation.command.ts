import * as Domain from "@alchemy.run/domain"
import { AutomationId } from "./Automation.id.ts"
import { AutomationArchivedError } from "./AutomationArchived.rejection.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"
import { PositiveInt } from "./AutomationTypes.ts"

export class AutomationUnpaused extends Domain.Event("automation.unpaused", {
	activation: PositiveInt,
}) {}

export class ResumeAutomation extends Domain.Command("ResumeAutomation", {
	input: {
		automation_id: AutomationId,
	},
	events: [AutomationUnpaused],
	rejects: [AutomationNotFound, AutomationArchivedError],
}) {}
