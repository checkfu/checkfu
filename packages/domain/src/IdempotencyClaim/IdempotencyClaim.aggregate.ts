import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import {
	RequestFingerprint,
	ClaimIdempotencyKey,
	IdempotencyKeyClaimed,
	IdempotencyKeyConflict,
} from "./ClaimIdempotencyKey.command.ts"
import { IdempotencyClaimId } from "./IdempotencyClaim.id.ts"

export const IDEMPOTENCY_CLAIM_STATE_SCHEMA_VERSION = 1 as const

export const IdempotencyClaimState = Schema.Union([
	Schema.TaggedStruct("Unclaimed", {}),
	Schema.TaggedStruct("Claimed", { fingerprint: RequestFingerprint }),
])
export type IdempotencyClaimState = typeof IdempotencyClaimState.Type

export const IdempotencyClaimStateSnapshot = versionedSnapshot({
	current: IDEMPOTENCY_CLAIM_STATE_SCHEMA_VERSION,
	schema: IdempotencyClaimState,
})

/**
 * Durably binds a scoped idempotency key to a request fingerprint before write
 * commands run, rejecting mismatched retries with 409 while allowing identical
 * retries to resume.
 */
export class IdempotencyClaim extends Domain.Aggregate("IdempotencyClaim", {
	id: IdempotencyClaimId,
	state: IdempotencyClaimStateSnapshot,
	initial: { _tag: "Unclaimed" as const },
	commands: [ClaimIdempotencyKey],
	keyOf: (cmd) => cmd.claim_id,
	transitions: {
		ClaimNeverReturnsToUnclaimed: ({ before, after }) =>
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
		ClaimIdempotencyKey: (state, cmd, ctx) => {
			if (state._tag === "Unclaimed") {
				return [new IdempotencyKeyClaimed({ fingerprint: cmd.fingerprint })]
			}
			if (state.fingerprint === cmd.fingerprint) {
				return []
			}
			return new IdempotencyKeyConflict({ claim_id: ctx.id })
		},
	},
	evolve: {
		"idempotency_key.claimed": (_state, event) => ({
			_tag: "Claimed" as const,
			fingerprint: event.fingerprint,
		}),
	},
}) {}
