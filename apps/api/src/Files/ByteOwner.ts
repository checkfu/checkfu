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

export const OwnerMarks = Schema.Struct({
	purged: Schema.Boolean,
	staged: Schema.Int,
	released: Schema.Int,
})
export type OwnerMarks = typeof OwnerMarks.Type

export const UNMARKED: OwnerMarks = { purged: false, staged: 0, released: 0 }

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
				const marks = yield* ports.marks
				if (marks.purged) {
					return yield* new BytesPurged()
				}
				if (reservation === null) {
					return
				}
				if (reservation <= marks.released || reservation < marks.staged) {
					return yield* new ReservationStale({ reservation })
				}
				if (reservation > marks.staged) {
					yield* ports.saveMarks({ ...marks, staged: reservation })
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
				const marks = yield* ports.marks
				if (marks.purged || reservation <= marks.released) {
					return
				}
				if (marks.staged <= reservation) {
					yield* ports.removeAll
				}
				yield* ports.saveMarks({ ...marks, released: reservation })
			}),
		)

	const purge = exclusive(
		Effect.gen(function* () {
			const marks = yield* ports.marks
			if (!marks.purged) {
				yield* ports.saveMarks({ ...marks, purged: true })
			}
			yield* ports.removeAll
		}),
	)

	return { write, writeAlone, release, purge }
}
