import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AutomationCapacityId } from "./AutomationCapacity.id.ts"
import { AutomationId } from "./Automation.id.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"

export class AutomationArchived extends Domain.Event("automation.archived", {
	capacity_id: Schema.optionalKey(AutomationCapacityId),
}) {}

export class ArchiveAutomation extends Domain.Command("ArchiveAutomation", {
	input: {
		automation_id: AutomationId,
	},
	events: [AutomationArchived],
	rejects: [AutomationNotFound],
}) {}
