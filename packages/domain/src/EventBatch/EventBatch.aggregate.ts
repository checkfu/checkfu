import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import {
	BatchFingerprint,
	ClaimEventBatch,
	EventBatchClaimed,
	IdempotencyKeyConflict,
} from "./ClaimEventBatch.command.ts"
import { EventBatchId } from "./EventBatch.id.ts"

export const EVENT_BATCH_STATE_SCHEMA_VERSION = 1 as const

export const EventBatchState = Schema.Union([
	Schema.TaggedStruct("Unclaimed", {}),
	Schema.TaggedStruct("Claimed", { fingerprint: BatchFingerprint }),
])
export type EventBatchState = typeof EventBatchState.Type

export const EventBatchStateSnapshot = versionedSnapshot({
	current: EVENT_BATCH_STATE_SCHEMA_VERSION,
	schema: EventBatchState,
})

/**
 * Durably binds a scoped idempotency key to a request fingerprint before write
 * commands run, rejecting mismatched retries with 409 while allowing identical
 * retries to resume.
 */
export class EventBatch extends Domain.Aggregate("EventBatch", {
	id: EventBatchId,
	state: EventBatchStateSnapshot,
	initial: { _tag: "Unclaimed" as const },
	commands: [ClaimEventBatch],
	keyOf: (cmd) => cmd.batch_id,
	transitions: {
		ClaimedBatchNeverReturnsToUnclaimed: ({ before, after }) =>
			before._tag !== "Claimed" || after._tag === "Claimed",
		ClaimedFingerprintNeverChanges: ({ before, after }) =>
			before._tag !== "Claimed" ||
			(after._tag === "Claimed" && after.fingerprint === before.fingerprint),
		// Aggregate transitions are proved over event-producing (Changed) outcomes only;
		// zero-event matching retries and IdempotencyKeyConflict rejections are checked separately.
		ClaimOnlyEmitsFromUnclaimedWithCommandFingerprint: ({ before, after, command, events }) => {
			if (before._tag !== "Unclaimed" || after._tag !== "Claimed") {
				return false
			}
			return [
				after.fingerprint === command.fingerprint,
				events.length === 1,
				events.every((event) => event.fingerprint === command.fingerprint),
			].every((ok) => ok)
		},
	},
	decide: {
		ClaimEventBatch: (state, cmd, ctx) => {
			if (state._tag === "Unclaimed") {
				return [new EventBatchClaimed({ fingerprint: cmd.fingerprint })]
			}
			if (state.fingerprint === cmd.fingerprint) {
				return []
			}
			return new IdempotencyKeyConflict({ batch_id: ctx.id })
		},
	},
	evolve: {
		"event_batch.claimed": (_state, event) => ({
			_tag: "Claimed" as const,
			fingerprint: event.fingerprint,
		}),
	},
}) {}
