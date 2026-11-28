import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { AutomationArchived } from "./ArchiveAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationCapacity } from "./AutomationCapacity.aggregate.ts"
import { capacityOf } from "./AutomationCapacity.id.ts"
import { ReleaseAutomationSlot } from "./ReleaseAutomationSlot.command.ts"

export class FreeAutomationSlot extends Domain.Policy("FreeAutomationSlot", {
	from: Automation,
	on: [AutomationArchived],
}) {}

export const FreeAutomationSlotLive = FreeAutomationSlot.toLayer(
	Effect.gen(function* () {
		const capacity = yield* AutomationCapacity
		return Effect.fn(function* ({ source, event }) {
			yield* capacity.send(
				new ReleaseAutomationSlot({ capacity_id: capacityOf(event), automation_id: source.id }),
			)
		})
	}),
)
