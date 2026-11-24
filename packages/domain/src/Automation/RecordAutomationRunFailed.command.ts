import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { ErrorMessage, ErrorType } from "../Session/SessionTypes.ts"
import { AutomationId } from "./Automation.id.ts"
import {
	AutomationRunError,
	AutomationTrigger,
	NonNegativeInt,
	PositiveInt,
} from "./AutomationTypes.ts"
import { AutomationPaused } from "./PauseAutomation.command.ts"

export class AutomationRunFailed extends Domain.Event("automation.run_failed", {
	run: PositiveInt,
	trigger: AutomationTrigger,
	scheduled_at: Schema.NullOr(NonNegativeInt),
	error: AutomationRunError,
}) {}

export class RecordAutomationRunFailed extends Domain.Command("RecordAutomationRunFailed", {
	input: {
		automation_id: AutomationId,
		run: PositiveInt,
		trigger: AutomationTrigger,
		scheduled_at: Schema.NullOr(NonNegativeInt),
		revision: PositiveInt,
		error_type: ErrorType,
		message: ErrorMessage,
		unrecoverable: Schema.Boolean,
	},
	events: [AutomationRunFailed, AutomationPaused],
	rejects: [],
}) {}
