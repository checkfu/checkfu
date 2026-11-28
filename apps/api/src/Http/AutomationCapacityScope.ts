import type { AutomationId } from "@checkfu/domain/Automation/Automation.id"
import { AUTOMATION_CAPACITY } from "@checkfu/domain/Automation/AutomationCapacity.id"
import type { AutomationCapacityId } from "@checkfu/domain/Automation/AutomationCapacity.id"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

interface AutomationCapacityScopeService {
	readonly capacityId: AutomationCapacityId
	readonly includeDefaultCapacity?: true
	readonly archiveInventory?: Effect.Effect<ReadonlyArray<AutomationId> | null>
}

/**
 * A host may select a capacity partition and supply its complete archive inventory.
 * Partition Agent and Environment references along the same boundary, and include
 * the original default partition while older Automations still have allocations there.
 */
export const AutomationCapacityScope = Context.Reference<AutomationCapacityScopeService>(
	"@checkfu/api/AutomationCapacityScope",
	{ defaultValue: () => ({ capacityId: AUTOMATION_CAPACITY }) },
)
