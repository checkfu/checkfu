import { ownerTransition } from "@checkfu/domain/Bytes/ByteOwnership"
import type { OwnerMarks } from "@checkfu/domain/Bytes/ByteOwnership"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"

const WRITE_SLOTS = 64

export class BytesPurged extends Schema.TaggedError<
	BytesPurged,
	{ readonly brand: unique symbol }
>()("BytesPurged", {}) {}

export class ReservationStale extends Schema.TaggedError<
	ReservationStale,
	{ readonly brand: unique symbol }
>()("ReservationStale", { reservation: Schema.Int }) {}

export interface ByteOwnerPorts<E, R> {
	readonly marks: Effect.Effect<OwnerMarks, E, R>
	readonly saveMarks: (marks: OwnerMarks) => Effect.Effect<void, E, R>
	readonly removeAll: Effect.Effect<void, E, R>
}

export const makeByteOwner = <E, R>(ports: ByteOwnerPorts<E, R>) => {
	const lock = Semaphore.makeUnsafe(1)
	const writes = Semaphore.makeUnsafe(WRITE_SLOTS)
	const exclusive = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
		writes.withPermits(WRITE_SLOTS)(lock.withPermit(effect))

	const admit = (reservation: number | null) =>
		lock.withPermit(
			Effect.gen(function* () {
				const decision = ownerTransition(yield* ports.marks, "stage", reservation)
				if (decision.action === "purged") {
					return yield* new BytesPurged()
				}
				if (decision.action === "stale") {
					return yield* new ReservationStale({ reservation: decision.reservation })
				}
				if (decision.action === "stage") {
					yield* ports.saveMarks(decision.marks)
				}
			}),
		)

	const write = <A, E2, R2>(reservation: number | null, work: Effect.Effect<A, E2, R2>) =>
		writes.withPermits(1)(Effect.andThen(admit(reservation), work))

	const writeAlone = <A, E2, R2>(reservation: number, work: Effect.Effect<A, E2, R2>) =>
		writes.withPermits(WRITE_SLOTS)(Effect.andThen(admit(reservation), work))

	const release = (reservation: number) =>
		exclusive(
			Effect.gen(function* () {
				const decision = ownerTransition(yield* ports.marks, "release", reservation)
				if (decision.action === "keep") {
					return
				}
				if (decision.action === "removeThenRelease") {
					yield* ports.removeAll
				}
				yield* ports.saveMarks(decision.marks)
			}),
		)

	const purge = exclusive(
		Effect.gen(function* () {
			const decision = ownerTransition(yield* ports.marks, "purge", null)
			if (decision.action === "markThenRemove") {
				yield* ports.saveMarks(decision.marks)
			}
			yield* ports.removeAll
		}),
	)

	return { write, writeAlone, release, purge }
}
