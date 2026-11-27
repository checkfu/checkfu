import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { buildArtifactVersion } from "../src/Artifacts/ArtifactFiles.ts"
import type { ArtifactFileInput } from "../src/Artifacts/ArtifactFiles.ts"
import { UNMARKED, makeArtifactOwner } from "../src/Artifacts/ArtifactOwnership.ts"
import type { ArtifactBucketWriter, ArtifactMarks } from "../src/Artifacts/ArtifactOwnership.ts"
import { artifactBlobKey, artifactManifestKey } from "../src/Artifacts/ArtifactStore.ts"

const SCOPE = "test"
const ID = "art_owner"

const makeOwner = () => {
	const objects = new Map<string, Uint8Array | string>()
	const puts: Array<string> = []
	let marks: ArtifactMarks = UNMARKED
	let beforeList: Effect.Effect<void> = Effect.void
	let duringUpload: Effect.Effect<void> = Effect.void
	const bucket: ArtifactBucketWriter<never> = {
		verifyStream: (body, size) =>
			Effect.promise(async () =>
				(await new Response(body).arrayBuffer()).byteLength === size
					? ("stored" as const)
					: ("mismatch" as const),
			),
		putStream: (key) =>
			Effect.andThen(
				Effect.suspend(() => duringUpload),
				Effect.sync(() => {
					puts.push(key)
					objects.set(key, "uploaded")
					return "stored" as const
				}),
			),
		put: (key, body) =>
			Effect.sync(() => {
				puts.push(key)
				objects.set(key, body)
			}),
		has: (key) => Effect.sync(() => objects.has(key)),
		delete: (keys) =>
			Effect.sync(() => {
				for (const key of keys) {
					objects.delete(key)
				}
			}),
		list: (prefix) =>
			Effect.andThen(
				Effect.suspend(() => beforeList),
				Effect.sync(() => [...objects.keys()].filter((key) => key.startsWith(prefix))),
			),
	}
	const owner = makeArtifactOwner({
		scope: SCOPE,
		bucket,
		marks: Effect.sync(() => marks),
		saveMarks: (next) =>
			Effect.sync(() => {
				marks = next
			}),
	})
	return {
		owner,
		objects,
		puts,
		marks: () => marks,
		setBeforeList: (effect: Effect.Effect<void>) => {
			beforeList = effect
		},
		setDuringUpload: (effect: Effect.Effect<void>) => {
			duringUpload = effect
		},
	}
}

const build = (files: ReadonlyArray<ArtifactFileInput>) =>
	Effect.flatMap(Digest.Digest, (digest) => Effect.orDie(buildArtifactVersion(digest, files))).pipe(
		Effect.provide(Digest.layerWebCrypto),
	)

const isFailure = (exit: Exit.Exit<unknown, unknown>, tag: string) =>
	Exit.isFailure(exit) && JSON.stringify(exit.cause).includes(tag)

describe("artifact owner", () => {
	it.effect("stores each file once and records the latest reservation staged", () =>
		Effect.gen(function* () {
			const { owner, objects, puts, marks } = makeOwner()
			const first = yield* build([{ path: "a.txt", content: "a" }])
			const second = yield* build([
				{ path: "a.txt", content: "a" },
				{ path: "b.txt", content: "b" },
			])
			yield* owner.stage(ID, first, 1)
			yield* owner.stage(ID, second, null)
			expect(marks()).toEqual({ purged: false, staged: 1, released: 0 })
			expect(objects.has(artifactManifestKey(SCOPE, ID, first.manifest_hash))).toBe(true)
			expect(objects.has(artifactManifestKey(SCOPE, ID, second.manifest_hash))).toBe(true)
			const shared = artifactBlobKey(SCOPE, ID, first.blobs[0]?.sha256 ?? "")
			expect(puts.filter((key) => key === shared)).toHaveLength(1)
			expect(objects.size).toBe(4)
		}),
	)

	it.effect("releases the files of an expired reservation and of every one it displaced", () =>
		Effect.gen(function* () {
			const { owner, objects, marks } = makeOwner()
			yield* owner.stage(ID, yield* build([{ path: "a.txt", content: "a" }]), 1)
			yield* owner.release(ID, 2)
			expect(objects.size).toBe(0)
			expect(marks()).toEqual({ purged: false, staged: 1, released: 2 })
			yield* owner.stage(ID, yield* build([{ path: "a.txt", content: "again" }]), 3)
			expect(objects.size).toBe(2)
		}),
	)

	it.effect("keeps a newer reservation's files when an older one is released late", () =>
		Effect.gen(function* () {
			const { owner, objects, marks } = makeOwner()
			yield* owner.stage(ID, yield* build([{ path: "a.txt", content: "a" }]), 2)
			yield* owner.release(ID, 1)
			expect(objects.size).toBe(2)
			expect(marks()).toEqual({ purged: false, staged: 2, released: 1 })
		}),
	)

	it.effect("refuses a stage for a reservation older than one already staged or released", () =>
		Effect.gen(function* () {
			const { owner, objects } = makeOwner()
			const late = yield* build([{ path: "late.txt", content: "late" }])
			yield* owner.release(ID, 1)
			expect(
				isFailure(yield* Effect.exit(owner.stage(ID, late, 1)), "ArtifactReservationStale"),
			).toBe(true)
			yield* owner.stage(ID, yield* build([{ path: "a.txt", content: "a" }]), 3)
			expect(
				isFailure(yield* Effect.exit(owner.stage(ID, late, 2)), "ArtifactReservationStale"),
			).toBe(true)
			yield* owner.release(ID, 2)
			expect(objects.size).toBe(2)
		}),
	)

	it.effect("purges everything, for good, and refuses files staged after", () =>
		Effect.gen(function* () {
			const { owner, objects, marks } = makeOwner()
			const files = yield* build([{ path: "a.txt", content: "a" }])
			yield* owner.stage(ID, files, 1)
			yield* owner.purge(ID)
			expect(objects.size).toBe(0)
			expect(marks().purged).toBe(true)
			expect(isFailure(yield* Effect.exit(owner.stage(ID, files, null)), "ArtifactPurged")).toBe(
				true,
			)
			yield* owner.release(ID, 2)
			yield* owner.purge(ID)
			expect(objects.size).toBe(0)
		}),
	)

	it.effect("lets a stage that arrives during a purge wait, then refuses it", () =>
		Effect.gen(function* () {
			const { owner, objects, setBeforeList } = makeOwner()
			const files = yield* build([{ path: "a.txt", content: "a" }])
			yield* owner.stage(ID, files, 1)
			const listing = yield* Deferred.make<void>()
			const proceed = yield* Deferred.make<void>()
			setBeforeList(
				Effect.gen(function* () {
					setBeforeList(Effect.void)
					yield* Deferred.succeed(listing, undefined)
					yield* Deferred.await(proceed)
				}),
			)
			const purging = yield* Effect.forkChild(owner.purge(ID))
			yield* Deferred.await(listing)
			const staging = yield* Effect.forkChild(Effect.exit(owner.stage(ID, files, null)))
			yield* Deferred.succeed(proceed, undefined)
			yield* Fiber.join(purging)
			expect(Exit.isFailure(yield* Fiber.join(staging))).toBe(true)
			expect(objects.size).toBe(0)
		}),
	)

	it.effect("waits for an upload in flight before purging, so the purge removes its bytes", () =>
		Effect.gen(function* () {
			const { owner, objects, setDuringUpload } = makeOwner()
			const uploading = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			setDuringUpload(
				Effect.andThen(Deferred.succeed(uploading, undefined), Deferred.await(release)),
			)
			const upload = yield* Effect.forkChild(
				owner.putBlob(ID, "a".repeat(64), new ReadableStream(), 1, null),
			)
			yield* Deferred.await(uploading)
			const purge = yield* Effect.forkChild(owner.purge(ID))
			yield* Effect.yieldNow
			expect(purge.pollUnsafe()).toBeUndefined()
			yield* Deferred.succeed(release, undefined)
			expect(yield* Fiber.join(upload)).toBe("stored")
			yield* Fiber.join(purge)
			expect(objects.size).toBe(0)
			expect(
				isFailure(
					yield* Effect.exit(owner.putBlob(ID, "a".repeat(64), new ReadableStream(), 1, null)),
					"ArtifactPurged",
				),
			).toBe(true)
		}),
	)

	it.effect(
		"records a reservation before its bytes arrive, so releasing an older one keeps them",
		() =>
			Effect.gen(function* () {
				const { owner, objects, marks } = makeOwner()
				yield* owner.stage(ID, null, 2)
				expect(marks()).toEqual({ purged: false, staged: 2, released: 0 })
				yield* owner.putBlob(ID, "a".repeat(64), new ReadableStream(), 1, null)
				yield* owner.stage(ID, yield* build([{ path: "a.txt", content: "a" }]), null)
				yield* owner.release(ID, 1)
				expect(objects.size).toBe(3)
			}),
	)

	it.effect("refuses bytes for a reservation that has been released, so none outlive it", () =>
		Effect.gen(function* () {
			const { owner, objects } = makeOwner()
			yield* owner.stage(ID, null, 1)
			yield* owner.putBlob(ID, "a".repeat(64), new Blob(["x"]).stream(), 1, 1)
			expect(objects.size).toBe(1)
			yield* owner.release(ID, 1)
			expect(objects.size).toBe(0)
			expect(
				isFailure(
					yield* Effect.exit(owner.putBlob(ID, "b".repeat(64), new Blob(["y"]).stream(), 1, 1)),
					"ArtifactReservationStale",
				),
			).toBe(true)
			expect(objects.size).toBe(0)
			yield* owner.stage(ID, null, 2)
			expect(yield* owner.putBlob(ID, "b".repeat(64), new Blob(["y"]).stream(), 1, 2)).toBe(
				"stored",
			)
		}),
	)

	it.effect("refuses bytes from a reservation superseded before it was released", () =>
		Effect.gen(function* () {
			const { owner, objects, marks } = makeOwner()
			yield* owner.stage(ID, null, 1)
			yield* owner.stage(ID, null, 2)
			const blob = "a".repeat(64)
			const stale = yield* Effect.exit(owner.putBlob(ID, blob, new Blob(["x"]).stream(), 1, 1))
			expect(isFailure(stale, "ArtifactReservationStale")).toBe(true)
			expect(objects.size).toBe(0)
			expect(marks()).toEqual({ purged: false, staged: 2, released: 0 })
			expect(yield* owner.putBlob(ID, blob, new Blob(["x"]).stream(), 1, 2)).toBe("stored")
		}),
	)

	it.effect("writes a new digest once when two uploads of it race, and checks the second", () =>
		Effect.gen(function* () {
			const { owner, puts, setDuringUpload } = makeOwner()
			const release = yield* Deferred.make<void>()
			setDuringUpload(Deferred.await(release))
			const key = artifactBlobKey(SCOPE, ID, "a".repeat(64))
			const first = yield* Effect.forkChild(
				owner.putBlob(ID, "a".repeat(64), new Blob(["x"]).stream(), 1, null),
			)
			const second = yield* Effect.forkChild(
				owner.putBlob(ID, "a".repeat(64), new Blob(["x"]).stream(), 1, null),
			)
			yield* Effect.yieldNow
			yield* Deferred.succeed(release, undefined)
			expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual(["stored", "stored"])
			expect(puts.filter((put) => put === key)).toHaveLength(1)
		}),
	)

	it.effect("refuses an upload declared empty whose body is not", () =>
		Effect.gen(function* () {
			const { owner, objects } = makeOwner()
			expect(
				yield* owner.putBlob(ID, "e".repeat(64), new Blob(["not empty"]).stream(), 0, null),
			).toBe("mismatch")
			expect(objects.size).toBe(0)
			expect(yield* owner.putBlob(ID, "e".repeat(64), new Blob([]).stream(), 0, null)).toBe(
				"stored",
			)
		}),
	)
})
