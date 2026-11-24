import * as Schema from "effect/Schema"

export const AUTOMATION_CAPACITY = "automations" as const

export const AutomationCapacityId = Schema.Literal(AUTOMATION_CAPACITY)
export type AutomationCapacityId = typeof AutomationCapacityId.Type
