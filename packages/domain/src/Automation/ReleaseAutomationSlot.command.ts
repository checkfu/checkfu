import * as Domain from "@alchemy.run/domain"
import { AutomationId } from "./Automation.id.ts"
import { AutomationCapacityId } from "./AutomationCapacity.id.ts"

export class AutomationSlotReleased extends Domain.Event("automation_slot.released", {
	automation_id: AutomationId,
}) {}

export class ReleaseAutomationSlot extends Domain.Command("ReleaseAutomationSlot", {
	input: {
		capacity_id: AutomationCapacityId,
		automation_id: AutomationId,
	},
	events: [AutomationSlotReleased],
	rejects: [],
}) {}
