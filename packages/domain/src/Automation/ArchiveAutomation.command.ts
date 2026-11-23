import * as Domain from "@alchemy.run/domain"
import { AutomationId } from "./Automation.id.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"

export class AutomationArchived extends Domain.Event("automation.archived") {}

export class ArchiveAutomation extends Domain.Command("ArchiveAutomation", {
	input: {
		automation_id: AutomationId,
	},
	events: [AutomationArchived],
	rejects: [AutomationNotFound],
}) {}
