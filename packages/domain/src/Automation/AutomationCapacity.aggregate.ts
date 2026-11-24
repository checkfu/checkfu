import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { AutomationId } from "./Automation.id.ts"
import { AutomationCapacityId } from "./AutomationCapacity.id.ts"
import { NonNegativeInt } from "./AutomationTypes.ts"
import { AutomationSlotReleased, ReleaseAutomationSlot } from "./ReleaseAutomationSlot.command.ts"

export const MAX_LIVE_AUTOMATIONS = 100

export class AutomationSlotReserved extends Domain.Event("automation_slot.reserved", {
	automation_id: AutomationId,
}) {}

export const AutomationCapacityState = Schema.Struct({ reserved: NonNegativeInt })
export type AutomationCapacityState = typeof AutomationCapacityState.Type

export const AUTOMATION_CAPACITY_STATE_SCHEMA_VERSION = 1 as const

export const AutomationCapacityStateSnapshot = versionedSnapshot({
	current: AUTOMATION_CAPACITY_STATE_SCHEMA_VERSION,
	schema: AutomationCapacityState,
})

export class AutomationCapacity extends Domain.Aggregate("AutomationCapacity", {
	id: AutomationCapacityId,
	state: AutomationCapacityStateSnapshot,
	initial: { reserved: 0 },
	commands: [ReleaseAutomationSlot],
	events: [AutomationSlotReserved],
	keyOf: (cmd) => cmd.capacity_id,
	invariants: {
		ReservedSlotsStayWithinTheLimit: (s) =>
			[s.reserved >= 0, s.reserved <= MAX_LIVE_AUTOMATIONS].every((ok) => ok),
	},
	transitions: {
		SlotsChangeOneAtATime: ({ before, after }) =>
			[
				after.reserved === before.reserved,
				after.reserved === before.reserved + 1,
				after.reserved === before.reserved - 1,
			].some((ok) => ok),
	},
	decide: {
		ReleaseAutomationSlot: (state, cmd) =>
			state.reserved > 0 ? [new AutomationSlotReleased({ automation_id: cmd.automation_id })] : [],
	},
	evolve: {
		"automation_slot.reserved": (state) =>
			state.reserved < MAX_LIVE_AUTOMATIONS ? { reserved: state.reserved + 1 } : state,
		"automation_slot.released": (state) =>
			state.reserved > 0 ? { reserved: state.reserved - 1 } : state,
	},
}) {}
