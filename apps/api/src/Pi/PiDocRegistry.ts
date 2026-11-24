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
	// The newest turn this conversation has admitted. An older one arriving late is refused.
	turn: NonNegativeInt,
	input_tokens: NonNegativeInt,
	output_tokens: NonNegativeInt,
})
export type ActiveUsageState = typeof ActiveUsageState.Type

export const SETTLED_USAGE_DOC_VERSION = 1 as const
export const SettledUsageState = ModelUsage
export type SettledUsageState = typeof SettledUsageState.Type

// Each Pi object hosts one Checkfu session. Only one submission
// can accrue usage at a time, including any blocking compaction or retry.
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

/**
 * Every Pi document Checkfu persists, for the persistence lock. A document
 * defined above and left out of this list fails the in-memory storage in tests.
 */
export const CHECKFU_PI_DOCS: ReadonlyArray<CheckfuPiDocSpec> = Object.freeze([
	{ token: ActiveUsage, schema: ActiveUsageState },
	{ token: SettledUsage, schema: SettledUsageState },
])
