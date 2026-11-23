import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { MessageText, ResourceId } from "../Session/SessionTypes.ts"
import { AutomationId } from "./Automation.id.ts"
import { AutomationName, AutomationSchedule, PositiveInt } from "./AutomationTypes.ts"

export class AutomationCreated extends Domain.Event("automation.created", {
	name: AutomationName,
	agent_id: ResourceId,
	agent_version: Schema.NullOr(PositiveInt),
	environment_id: ResourceId,
	text: MessageText,
	schedule: AutomationSchedule,
}) {}

export class AutomationAlreadyExists extends Domain.Rejection(
	"AutomationAlreadyExists",
	{ automation_id: AutomationId },
	{ httpApiStatus: 409, description: "An automation with this id already exists." },
) {}

export class CreateAutomation extends Domain.Command("CreateAutomation", {
	input: {
		automation_id: AutomationId,
		name: AutomationName,
		agent_id: ResourceId,
		agent_version: Schema.NullOr(PositiveInt),
		environment_id: ResourceId,
		text: MessageText,
		schedule: AutomationSchedule,
	},
	events: [AutomationCreated],
	rejects: [AutomationAlreadyExists],
}) {}
