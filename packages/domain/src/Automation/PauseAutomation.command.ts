import * as Domain from "@alchemy.run/domain"
import { AutomationId } from "./Automation.id.ts"
import { AutomationArchivedError } from "./AutomationArchived.rejection.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"
import { PauseReason } from "./AutomationTypes.ts"

export class AutomationPaused extends Domain.Event("automation.paused", {
	reason: PauseReason,
}) {}

export class PauseAutomation extends Domain.Command("PauseAutomation", {
	input: {
		automation_id: AutomationId,
	},
	events: [AutomationPaused],
	rejects: [AutomationNotFound, AutomationArchivedError],
}) {}
