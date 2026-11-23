import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { Automation } from "./Automation.aggregate.ts"
import { NonNegativeInt } from "./AutomationTypes.ts"
import { AutomationRunFailed } from "./RecordAutomationRunFailed.command.ts"
import { AutomationRunStarted } from "./RecordAutomationRunStarted.command.ts"

export class AutomationRunView extends Domain.View("AutomationRunView", {
	version: 1,
	from: [Automation],
	key: Automation,
	state: Schema.Struct({ recorded: NonNegativeInt }),
	initial: { recorded: 0 },
	events: [AutomationRunStarted, AutomationRunFailed],
	evolve: {
		"automation.run_started": (_state, e) => ({ recorded: e.run }),
		"automation.run_failed": (_state, e) => ({ recorded: e.run }),
	},
}) {}
