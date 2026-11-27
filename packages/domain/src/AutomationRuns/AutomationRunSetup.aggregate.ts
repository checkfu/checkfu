import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import {
	AutomationRunPrepared,
	AutomationRunSetupId,
	PrepareAutomationRun,
} from "./PrepareAutomationRun.command.ts"

export class AutomationRunSetup extends Domain.Aggregate("AutomationRunSetup", {
	id: AutomationRunSetupId,
	state: Schema.Struct({ prepared: Schema.Boolean }),
	initial: { prepared: false },
	commands: [PrepareAutomationRun],
	keyOf: (command) => command.setup_id,
	decide: {
		PrepareAutomationRun: (state) => (state.prepared ? [] : [new AutomationRunPrepared()]),
	},
	evolve: {
		"automation_run_setup.prepared": () => ({ prepared: true }),
	},
}) {}
