import { ModelUsage, NonNegativeInt } from "@checkfu/sessions/Session/SessionTypes"
import type { ServiceFreeSchema } from "@checkfu/snapshots/VersionedSnapshot"
import type { JsonValue } from "@earendil-works/chord/json"
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable"
import type {
	CommonDocDefinition,
	ConversationDocFamilyToken,
	ConversationDocToken,
	JsonObject,
	LatestConversationSemantics,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	RewindableConversationSemantics,
	SessionDocFamilyToken,
	SessionDocToken,
	TaskDocFamilyToken,
	TaskDocToken,
} from "@earendil-works/pi-durable"
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

interface PiDocRegistration {
	readonly schema: ServiceFreeSchema
	readonly previous?: ReadonlyArray<{
		readonly version: number
		readonly schema: ServiceFreeSchema
	}>
}

type FamilyDocInput<T extends JsonObject, I extends JsonValue> = Omit<
	CommonDocDefinition<T>,
	"initial"
> & {
	readonly family: true
	initial(seed: I): T
}

const registeredPiDocs: Array<CheckfuPiDocSpec> = []

// Module-private factories: every Checkfu-owned Pi durable document must be
// declared in this single file so CHECKFU_PI_DOCS is closed, immutable, and
// identical regardless of which entry point (persisted:cut, persisted:check,
// tests, or ApiWorker deploy) loads the module graph.
function registerPiDoc<T extends JsonObject>(
	registration: PiDocRegistration,
	definition: CommonDocDefinition<T> & { readonly scope: "session" },
): SessionDocToken<T>
function registerPiDoc<T extends JsonObject>(
	registration: PiDocRegistration,
	definition: CommonDocDefinition<T> & LatestConversationSemantics,
): ConversationDocToken<T>
function registerPiDoc<T extends JsonObject>(
	registration: PiDocRegistration,
	definition: CommonDocDefinition<T> & RewindableConversationSemantics,
): RewindableConversationDocToken<T>
function registerPiDoc<T extends JsonObject>(
	registration: PiDocRegistration,
	definition: CommonDocDefinition<T> & { readonly scope: "task" },
): TaskDocToken<T>
function registerPiDoc<T extends JsonObject>(
	registration: PiDocRegistration,
	definition:
		| (CommonDocDefinition<T> & { readonly scope: "session" })
		| (CommonDocDefinition<T> & LatestConversationSemantics)
		| (CommonDocDefinition<T> & RewindableConversationSemantics)
		| (CommonDocDefinition<T> & { readonly scope: "task" }),
):
	| SessionDocToken<T>
	| ConversationDocToken<T>
	| RewindableConversationDocToken<T>
	| TaskDocToken<T> {
	const token =
		definition.scope === "session"
			? defineDoc<T>(definition)
			: definition.scope === "task"
				? defineDoc<T>(definition)
				: definition.history === "latest"
					? defineDoc<T>(definition)
					: defineDoc<T>(definition)
	registeredPiDocs.push({
		token,
		schema: registration.schema,
		...(registration.previous === undefined ? {} : { previous: registration.previous }),
	})
	return token
}

function registerPiDocFamily<T extends JsonObject, I extends JsonValue>(
	registration: PiDocRegistration,
	definition: FamilyDocInput<T, I> & { readonly scope: "session" },
): SessionDocFamilyToken<T, I>
function registerPiDocFamily<T extends JsonObject, I extends JsonValue>(
	registration: PiDocRegistration,
	definition: FamilyDocInput<T, I> & LatestConversationSemantics,
): ConversationDocFamilyToken<T, I>
function registerPiDocFamily<T extends JsonObject, I extends JsonValue>(
	registration: PiDocRegistration,
	definition: FamilyDocInput<T, I> & RewindableConversationSemantics,
): RewindableConversationDocFamilyToken<T, I>
function registerPiDocFamily<T extends JsonObject, I extends JsonValue>(
	registration: PiDocRegistration,
	definition: FamilyDocInput<T, I> & { readonly scope: "task" },
): TaskDocFamilyToken<T, I>
function registerPiDocFamily<T extends JsonObject, I extends JsonValue>(
	registration: PiDocRegistration,
	definition:
		| (FamilyDocInput<T, I> & { readonly scope: "session" })
		| (FamilyDocInput<T, I> & LatestConversationSemantics)
		| (FamilyDocInput<T, I> & RewindableConversationSemantics)
		| (FamilyDocInput<T, I> & { readonly scope: "task" }),
):
	| SessionDocFamilyToken<T, I>
	| ConversationDocFamilyToken<T, I>
	| RewindableConversationDocFamilyToken<T, I>
	| TaskDocFamilyToken<T, I> {
	const token =
		definition.scope === "session"
			? defineDocFamily<T, I>(definition)
			: definition.scope === "task"
				? defineDocFamily<T, I>(definition)
				: definition.history === "latest"
					? defineDocFamily<T, I>(definition)
					: defineDocFamily<T, I>(definition)
	registeredPiDocs.push({
		token,
		schema: registration.schema,
		...(registration.previous === undefined ? {} : { previous: registration.previous }),
	})
	return token
}

export const ACTIVE_USAGE_DOC_VERSION = 1 as const
export const ActiveUsageState = Schema.Struct({
	operation: Schema.NullOr(Schema.String),
	input_tokens: NonNegativeInt,
	output_tokens: NonNegativeInt,
})
export type ActiveUsageState = typeof ActiveUsageState.Type

export const SETTLED_USAGE_DOC_VERSION = 1 as const
export const SettledUsageState = ModelUsage
export type SettledUsageState = typeof SettledUsageState.Type

export const SEED_STATE_DOC_VERSION = 1 as const
export const SeedStateValue = Schema.Struct({
	rebuildRequired: Schema.Boolean,
	seededByOperation: Schema.NullOr(Schema.String),
})
export type SeedStateValue = typeof SeedStateValue.Type

// Each Pi object hosts one generation of a Checkfu session. Only one submission
// can accrue usage at a time, including any blocking compaction or retry.
export const ActiveUsage = registerPiDoc<ActiveUsageState>(
	{ schema: ActiveUsageState },
	{
		kind: "checkfu.active-usage",
		version: ACTIVE_USAGE_DOC_VERSION,
		checkpointWhen: () => true,
		scope: "session",
		initial: (): ActiveUsageState => ({
			operation: null,
			input_tokens: 0,
			output_tokens: 0,
		}),
	},
)

export const SettledUsage = registerPiDocFamily<SettledUsageState, SettledUsageState>(
	{ schema: SettledUsageState },
	{
		kind: "checkfu.settled-usage",
		version: SETTLED_USAGE_DOC_VERSION,
		checkpointWhen: () => true,
		scope: "session",
		family: true,
		initial: (usage: SettledUsageState): SettledUsageState => ({ ...usage }),
	},
)

// Marks a root initialized from a trimmed recovery seed (e.g. when a large prompt
// exhausted the seed budget) so the next turn rebuilds full history if the recovery
// turn does not commit a reply.
export const SeedState = registerPiDoc<SeedStateValue>(
	{ schema: SeedStateValue },
	{
		kind: "checkfu.seed-state",
		version: SEED_STATE_DOC_VERSION,
		checkpointWhen: () => true,
		scope: "session",
		initial: (): SeedStateValue => ({
			rebuildRequired: false,
			seededByOperation: null,
		}),
	},
)

/**
 * Closed, immutable registry of every Checkfu-owned Pi durable document so the
 * persistence lock always enumerates the exact same document formats, scopes,
 * conversation semantics, family flags, and versions across every entry point.
 */
export const CHECKFU_PI_DOCS: ReadonlyArray<CheckfuPiDocSpec> = Object.freeze(registeredPiDocs)
