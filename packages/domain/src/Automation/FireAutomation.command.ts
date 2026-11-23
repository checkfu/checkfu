import * as Domain from "@alchemy.run/domain"
import { AutomationId } from "./Automation.id.ts"
import { NonNegativeInt, PositiveInt } from "./AutomationTypes.ts"
import { AutomationFired } from "./RunAutomation.command.ts"

export class FireAutomation extends Domain.Command("FireAutomation", {
	input: {
		automation_id: AutomationId,
		activation: NonNegativeInt,
		scheduled_at: PositiveInt,
	},
	events: [AutomationFired],
	rejects: [],
}) {}
