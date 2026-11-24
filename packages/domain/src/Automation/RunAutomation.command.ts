import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionId } from "../Session/Session.id.ts"
import { AutomationId } from "./Automation.id.ts"
import { AutomationArchivedError } from "./AutomationArchived.rejection.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"
import { AutomationTrigger, NonNegativeInt, PositiveInt } from "./AutomationTypes.ts"

export class AutomationFired extends Domain.Event("automation.fired", {
	run: PositiveInt,
	session_id: SessionId,
	trigger: AutomationTrigger,
	scheduled_at: Schema.NullOr(NonNegativeInt),
}) {}

export class RunAutomation extends Domain.Command("RunAutomation", {
	input: {
		automation_id: AutomationId,
	},
	events: [AutomationFired],
	rejects: [AutomationNotFound, AutomationArchivedError],
	reply: {
		run: PositiveInt,
	},
}) {}
