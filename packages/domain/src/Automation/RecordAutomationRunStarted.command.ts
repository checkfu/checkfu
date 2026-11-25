import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SessionId } from "../Session/Session.id.ts"
import { ResourceId } from "../Session/SessionTypes.ts"
import { AutomationId } from "./Automation.id.ts"
import { AutomationTrigger, NonNegativeInt, PositiveInt } from "./AutomationTypes.ts"

export class AutomationRunStarted extends Domain.Event("automation.run_started", {
	run: PositiveInt,
	session_id: SessionId,
	trigger: AutomationTrigger,
	scheduled_at: Schema.NullOr(NonNegativeInt),
	agent_id: Schema.NullOr(ResourceId).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
	agent_version: Schema.NullOr(PositiveInt).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(null)),
	),
}) {}

export class RecordAutomationRunStarted extends Domain.Command("RecordAutomationRunStarted", {
	input: {
		automation_id: AutomationId,
		run: PositiveInt,
		trigger: AutomationTrigger,
		scheduled_at: Schema.NullOr(NonNegativeInt),
		agent_id: ResourceId,
		agent_version: PositiveInt,
	},
	events: [AutomationRunStarted],
	rejects: [],
}) {}
