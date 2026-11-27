import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"

export const AutomationRunSetupId = Schema.Literal("automation-run-setup")

export class AutomationRunPrepared extends Domain.Event("automation_run_setup.prepared", {}) {}

export class PrepareAutomationRun extends Domain.Command("PrepareAutomationRun", {
	input: { setup_id: AutomationRunSetupId },
	events: [AutomationRunPrepared],
}) {}
