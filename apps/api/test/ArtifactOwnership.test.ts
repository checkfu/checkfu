import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { buildArtifactVersion } from "../src/Artifacts/ArtifactFiles.ts"
import type { ArtifactFileInput } from "../src/Artifacts/ArtifactFiles.ts"
import { makeArtifactOwner } from "../src/Artifacts/ArtifactOwnership.ts"
import type { ArtifactBucketWriter, ArtifactMarks } from "../src/Artifacts/ArtifactOwnership.ts"
import { artifactBlobKey, artifactManifestKey } from "../src/Artifacts/ArtifactStore.ts"

const SCOPE = "test"
const ID = "art_owner"

const makeOwner = () => {
	const objects = new Map<string, Uint8Array | string>()
	const puts: Array<string> = []
	let marks: ArtifactMarks = { purged: false, reservation: null }
	let beforeList: Effect.Effect<void> = Effect.void
	const bucket: ArtifactBucketWriter<never> = {
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
	}
}

const build = (files: ReadonlyArray<ArtifactFileInput>) =>
	Effect.flatMap(Digest.Digest, (digest) => Effect.orDie(buildArtifactVersion(digest, files))).pipe(
		Effect.provide(Digest.layerWebCrypto),
	)

describe("artifact owner", () => {
	it.effect("stores each file once and records the reservation it was staged under", () =>
		Effect.gen(function* () {
			const { owner, objects, puts, marks } = makeOwner()
			const first = yield* build([{ path: "a.txt", content: "a" }])
			const second = yield* build([
				{ path: "a.txt", content: "a" },
				{ path: "b.txt", content: "b" },
			])
			yield* owner.stage(ID, first, "w1")
			yield* owner.stage(ID, second, null)
			expect(marks()).toEqual({ purged: false, reservation: "w1" })
			expect(objects.has(artifactManifestKey(SCOPE, ID, first.manifest_hash))).toBe(true)
			expect(objects.has(artifactManifestKey(SCOPE, ID, second.manifest_hash))).toBe(true)
			const shared = artifactBlobKey(SCOPE, ID, first.blobs[0]?.sha256 ?? "")
			expect(puts.filter((key) => key === shared)).toHaveLength(1)
			expect(objects.size).toBe(4)
		}),
	)

	it.effect("releases files only for the reservation they were staged under", () =>
		Effect.gen(function* () {
			const { owner, objects, marks } = makeOwner()
			yield* owner.stage(ID, yield* build([{ path: "a.txt", content: "a" }]), "w1")
			yield* owner.stage(ID, yield* build([{ path: "a.txt", content: "a" }]), "w2")
			yield* owner.release(ID, "w1")
			expect(objects.size).toBe(2)
			yield* owner.release(ID, "w2")
			expect(objects.size).toBe(0)
			expect(marks()).toEqual({ purged: false, reservation: null })
			yield* owner.stage(ID, yield* build([{ path: "a.txt", content: "again" }]), "w3")
			expect(objects.size).toBe(2)
		}),
	)

	it.effect("purges everything, for good, and refuses files staged after", () =>
		Effect.gen(function* () {
			const { owner, objects, marks } = makeOwner()
			const files = yield* build([{ path: "a.txt", content: "a" }])
			yield* owner.stage(ID, files, "w1")
			yield* owner.purge(ID)
			expect(objects.size).toBe(0)
			expect(marks()).toEqual({ purged: true, reservation: null })
			const late = yield* Effect.exit(owner.stage(ID, files, null))
			expect(Exit.isFailure(late) && JSON.stringify(late.cause).includes("ArtifactPurged")).toBe(
				true,
			)
			yield* owner.release(ID, "w1")
			yield* owner.purge(ID)
			expect(objects.size).toBe(0)
		}),
	)

	it.effect("lets a stage that arrives during a purge wait, then refuses it", () =>
		Effect.gen(function* () {
			const { owner, objects, setBeforeList } = makeOwner()
			const files = yield* build([{ path: "a.txt", content: "a" }])
			yield* owner.stage(ID, files, "w1")
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
})
