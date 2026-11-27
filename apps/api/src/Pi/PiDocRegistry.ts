import { ModelUsage, NonNegativeInt } from "@checkfu/domain/Session/SessionTypes"
import type { ServiceFreeSchema } from "@checkfu/snapshots/VersionedSnapshot"
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable"
import type { JsonObject } from "@earendil-works/pi-durable"
import * as Schema from "effect/Schema"

export interface CheckfuPiDocSpec {
	readonly token: {
		readonly definition: {
			readonly kind: string
			readonly version: number
			readonly scope: "session" | "conversation" | "task"
			readonly history?: "latest" | "rewindable"
			readonly fork?: "asOf" | "current" | "initial"
			readonly family?: true
			readonly migrate?: (value: JsonObject, fromVersion: number) => JsonObject
		}
	}
	readonly schema: ServiceFreeSchema
	readonly previous?: ReadonlyArray<{
		readonly version: number
		readonly schema: ServiceFreeSchema
	}>
}

export const ACTIVE_USAGE_DOC_VERSION = 1 as const
export const ActiveUsageState = Schema.Struct({
	operation: Schema.NullOr(Schema.String),
	turn: NonNegativeInt,
	input_tokens: NonNegativeInt,
	output_tokens: NonNegativeInt,
	cache_read_input_tokens: NonNegativeInt,
	cache_creation_input_tokens: NonNegativeInt,
	cache_creation_5m_input_tokens: NonNegativeInt,
	cache_creation_1h_input_tokens: NonNegativeInt,
})
export type ActiveUsageState = typeof ActiveUsageState.Type

export const SETTLED_USAGE_DOC_VERSION = 1 as const
export const SettledUsageState = ModelUsage
export type SettledUsageState = typeof SettledUsageState.Type

export const ActiveUsage = defineDoc<ActiveUsageState>({
	kind: "checkfu.active-usage",
	version: ACTIVE_USAGE_DOC_VERSION,
	checkpointWhen: () => true,
	scope: "session",
	initial: (): ActiveUsageState => ({
		operation: null,
		turn: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_creation_5m_input_tokens: 0,
		cache_creation_1h_input_tokens: 0,
	}),
})

export const SettledUsage = defineDocFamily<SettledUsageState, SettledUsageState>({
	kind: "checkfu.settled-usage",
	version: SETTLED_USAGE_DOC_VERSION,
	checkpointWhen: () => true,
	scope: "session",
	family: true,
	initial: (usage: SettledUsageState): SettledUsageState => ({ ...usage }),
})

const SystemContextState = Schema.Struct({ text: Schema.String, updated_at: NonNegativeInt })
type SystemContextState = typeof SystemContextState.Type

export const SessionSystemContext = defineDoc<SystemContextState>({
	kind: "checkfu.session-system-context",
	version: 1,
	checkpointWhen: () => true,
	scope: "session",
	initial: (): SystemContextState => ({ text: "", updated_at: 0 }),
})

export const CHECKFU_PI_DOCS: ReadonlyArray<CheckfuPiDocSpec> = Object.freeze([
	{ token: ActiveUsage, schema: ActiveUsageState },
	{ token: SettledUsage, schema: SettledUsageState },
	{ token: SessionSystemContext, schema: SystemContextState },
])
