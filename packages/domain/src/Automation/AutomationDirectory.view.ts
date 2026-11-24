import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AutomationId } from "./Automation.id.ts"
import { AutomationCapacity } from "./AutomationCapacity.aggregate.ts"
import { NonNegativeInt, PositiveInt } from "./AutomationTypes.ts"

export const AutomationDirectoryEntry = Schema.Struct({
	automation_id: AutomationId,
	seq: PositiveInt,
})
export type AutomationDirectoryEntry = typeof AutomationDirectoryEntry.Type

export class AutomationDirectory extends Domain.View(
	"AutomationDirectory",
	{
		version: 1,
		from: [AutomationCapacity],
		key: AutomationCapacity,
		state: Schema.Struct({ listed: NonNegativeInt, live: Schema.Array(AutomationDirectoryEntry) }),
		initial: { listed: 0, live: [] },
		evolve: {
			"automation_slot.reserved": (state, e) => ({
				listed: state.listed + 1,
				live: [...state.live, { automation_id: e.automation_id, seq: state.listed + 1 }],
			}),
			"automation_slot.released": (state, e) => ({
				...state,
				live: state.live.filter((entry) => entry.automation_id !== e.automation_id),
			}),
		},
	},
	{
		description:
			"The automations holding a slot, in the order they were created. Holding a slot means not archived, so this never lists more than the live limit.",
	},
) {}
