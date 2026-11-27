import { initialOwnerMarks } from "@checkfu/domain/Bytes/ByteOwnership"
import type { OwnerMarks } from "@checkfu/domain/Bytes/ByteOwnership"
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { makeByteOwner } from "../src/Files/ByteOwner.ts"

const makeOwner = () => {
	const objects = new Set<string>()
	let marks: OwnerMarks = initialOwnerMarks
	const owner = makeByteOwner({
		marks: Effect.sync(() => marks),
		saveMarks: (next) =>
			Effect.sync(() => {
				marks = next
			}),
		removeAll: Effect.sync(() => objects.clear()),
	})
	const store = (name: string) => Effect.sync(() => void objects.add(name))
	return { owner, objects, store, marks: () => marks }
}

const isFailure = (exit: Exit.Exit<unknown, unknown>, tag: string) =>
	Exit.isFailure(exit) && JSON.stringify(exit.cause).includes(tag)

describe("byte owner", () => {
	it.effect("records the latest reservation written, and refuses an older one", () =>
		Effect.gen(function* () {
			const { owner, objects, store, marks } = makeOwner()
			yield* owner.write(2, store("a"))
			expect(marks()).toEqual({ purged: false, staged: 2, released: 0 })
			expect(isFailure(yield* Effect.exit(owner.write(1, store("late"))), "ReservationStale")).toBe(
				true,
			)
			yield* owner.write(null, store("b"))
			expect([...objects]).toEqual(["a", "b"])
		}),
	)

	it.effect("releases what a lapsed reservation wrote, and keeps a newer one's bytes", () =>
		Effect.gen(function* () {
			const { owner, objects, store, marks } = makeOwner()
			yield* owner.write(1, store("first"))
			yield* owner.release(1)
			expect(objects.size).toBe(0)
			expect(marks()).toEqual({ purged: false, staged: 1, released: 1 })
			expect(
				isFailure(yield* Effect.exit(owner.write(1, store("again"))), "ReservationStale"),
			).toBe(true)
			yield* owner.write(3, store("third"))
			yield* owner.release(2)
			expect([...objects]).toEqual(["third"])
			expect(marks()).toEqual({ purged: false, staged: 3, released: 2 })
		}),
	)

	it.effect("redrives cleanup after a partial deletion or an interrupted marker write", () =>
		Effect.gen(function* () {
			let marks = initialOwnerMarks
			let fault: "before-mark" | "after-mark" | "remove" | null = null
			const objects = new Set(["first", "second"])
			const restart = () =>
				makeByteOwner({
					marks: Effect.sync(() => marks),
					saveMarks: (next) =>
						Effect.sync(() => {
							if (fault === "before-mark") {
								throw new Error("before marker commit")
							}
							marks = next
							if (fault === "after-mark") {
								throw new Error("after marker commit")
							}
						}),
					removeAll: Effect.sync(() => {
						for (const key of objects) {
							objects.delete(key)
							if (fault === "remove") {
								throw new Error("partial remove")
							}
						}
					}),
				})
			fault = "before-mark"
			expect(Exit.isFailure(yield* Effect.exit(restart().purge))).toBe(true)
			expect(marks.purged).toBe(false)
			expect([...objects]).toEqual(["first", "second"])
			fault = "remove"
			expect(Exit.isFailure(yield* Effect.exit(restart().release(2)))).toBe(true)
			expect(marks.released).toBe(0)
			expect([...objects]).toEqual(["second"])
			fault = null
			yield* restart().release(2)
			expect(objects.size).toBe(0)
			expect(marks.released).toBe(2)
			yield* restart().writeAlone(
				3,
				Effect.sync(() => objects.add("new")),
			)
			fault = "after-mark"
			expect(Exit.isFailure(yield* Effect.exit(restart().purge))).toBe(true)
			expect(marks.purged).toBe(true)
			expect([...objects]).toEqual(["new"])
			expect(isFailure(yield* Effect.exit(restart().write(null, Effect.void)), "BytesPurged")).toBe(
				true,
			)
			fault = null
			yield* restart().purge
			expect(objects.size).toBe(0)
		}),
	)

	it.effect("purges for good, and refuses every write after", () =>
		Effect.gen(function* () {
			const { owner, objects, store, marks } = makeOwner()
			yield* owner.write(1, store("a"))
			yield* owner.purge
			expect(objects.size).toBe(0)
			expect(marks().purged).toBe(true)
			expect(isFailure(yield* Effect.exit(owner.write(2, store("b"))), "BytesPurged")).toBe(true)
			expect(isFailure(yield* Effect.exit(owner.write(null, store("c"))), "BytesPurged")).toBe(true)
			yield* owner.release(5)
			yield* owner.purge
			expect(objects.size).toBe(0)
		}),
	)

	it.effect("waits for a write in flight before purging, so the purge removes its bytes", () =>
		Effect.gen(function* () {
			const { owner, objects, store } = makeOwner()
			const writing = yield* Deferred.make<void>()
			const finish = yield* Deferred.make<void>()
			const write = yield* Effect.forkChild(
				owner.write(
					1,
					Deferred.succeed(writing, undefined).pipe(
						Effect.andThen(Deferred.await(finish)),
						Effect.andThen(store("slow")),
					),
				),
			)
			yield* Deferred.await(writing)
			const purge = yield* Effect.forkChild(owner.purge)
			yield* Effect.yieldNow
			expect(purge.pollUnsafe()).toBeUndefined()
			yield* Deferred.succeed(finish, undefined)
			yield* Fiber.join(write)
			yield* Fiber.join(purge)
			expect(objects.size).toBe(0)
		}),
	)

	it.effect("runs a lone write after the one before it, and refuses an older one that waited", () =>
		Effect.gen(function* () {
			const { owner, objects, store } = makeOwner()
			const writing = yield* Deferred.make<void>()
			const finish = yield* Deferred.make<void>()
			const first = yield* Effect.forkChild(
				owner.writeAlone(
					1,
					Deferred.succeed(writing, undefined).pipe(
						Effect.andThen(Deferred.await(finish)),
						Effect.andThen(store("first")),
					),
				),
			)
			yield* Deferred.await(writing)
			const second = yield* Effect.forkChild(
				owner.writeAlone(
					2,
					Effect.sync(() => {
						objects.clear()
						objects.add("second")
					}),
				),
			)
			yield* Effect.yieldNow
			expect(second.pollUnsafe()).toBeUndefined()
			yield* Deferred.succeed(finish, undefined)
			yield* Fiber.join(first)
			yield* Fiber.join(second)
			expect([...objects]).toEqual(["second"])
			expect(
				isFailure(yield* Effect.exit(owner.writeAlone(1, store("late"))), "ReservationStale"),
			).toBe(true)
			expect([...objects]).toEqual(["second"])
		}),
	)

	it.effect("lets writes run side by side", () =>
		Effect.gen(function* () {
			const { owner, objects, store } = makeOwner()
			const first = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const slow = yield* Effect.forkChild(
				owner.write(
					null,
					Deferred.succeed(first, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.andThen(store("slow")),
					),
				),
			)
			yield* Deferred.await(first)
			yield* owner.write(null, store("quick"))
			expect([...objects]).toEqual(["quick"])
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(slow)
			expect(objects.size).toBe(2)
		}),
	)
})
