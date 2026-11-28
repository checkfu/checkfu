import * as Schema from "effect/Schema"

export const AUTOMATION_CAPACITY = "automations" as const

export const AutomationCapacityId = Schema.String
export type AutomationCapacityId = typeof AutomationCapacityId.Type

export const capacityOf = (automation: { readonly capacity_id?: AutomationCapacityId }) =>
	automation.capacity_id ?? AUTOMATION_CAPACITY
