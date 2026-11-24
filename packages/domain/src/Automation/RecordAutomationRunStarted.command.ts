import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionId } from "../Session/Session.id.ts"
import { AutomationId } from "./Automation.id.ts"
import { AutomationTrigger, NonNegativeInt, PositiveInt } from "./AutomationTypes.ts"

export class AutomationRunStarted extends Domain.Event("automation.run_started", {
	run: PositiveInt,
	session_id: SessionId,
	trigger: AutomationTrigger,
	scheduled_at: Schema.NullOr(NonNegativeInt),
}) {}

export class RecordAutomationRunStarted extends Domain.Command("RecordAutomationRunStarted", {
	input: {
		automation_id: AutomationId,
		run: PositiveInt,
		trigger: AutomationTrigger,
		scheduled_at: Schema.NullOr(NonNegativeInt),
	},
	events: [AutomationRunStarted],
	rejects: [],
}) {}
