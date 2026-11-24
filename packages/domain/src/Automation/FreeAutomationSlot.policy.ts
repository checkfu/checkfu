import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { AutomationArchived } from "./ArchiveAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationCapacity } from "./AutomationCapacity.aggregate.ts"
import { AUTOMATION_CAPACITY } from "./AutomationCapacity.id.ts"
import { ReleaseAutomationSlot } from "./ReleaseAutomationSlot.command.ts"

export class FreeAutomationSlot extends Domain.Policy("FreeAutomationSlot", {
	from: Automation,
	on: [AutomationArchived],
}) {}

export const FreeAutomationSlotLive = FreeAutomationSlot.toLayer(
	Effect.gen(function* () {
		const capacity = yield* AutomationCapacity
		return Effect.fn(function* ({ source }) {
			yield* capacity.send(
				new ReleaseAutomationSlot({ capacity_id: AUTOMATION_CAPACITY, automation_id: source.id }),
			)
		})
	}),
)
