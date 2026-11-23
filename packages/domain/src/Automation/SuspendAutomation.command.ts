import * as Domain from "@alchemy.run/domain"
import { AutomationId } from "./Automation.id.ts"
import { PauseReason } from "./AutomationTypes.ts"
import { AutomationPaused } from "./PauseAutomation.command.ts"

export class SuspendAutomation extends Domain.Command("SuspendAutomation", {
	input: {
		automation_id: AutomationId,
		reason: PauseReason,
	},
	events: [AutomationPaused],
	rejects: [],
}) {}
