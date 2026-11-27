import { ownerTransition } from "@checkfu/domain/Bytes/ByteOwnership"
import type { OwnerMarks } from "@checkfu/domain/Bytes/ByteOwnership"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import type { BuiltArtifactVersion } from "./ArtifactFiles.ts"
import type { ArtifactStoreError } from "./ArtifactStore.ts"
import {
	artifactBlobKey,
	artifactManifestKey,
	artifactPrefix,
	deleteUntilEmpty,
} from "./ArtifactStore.ts"

const PUT_CONCURRENCY = 4

const UPLOAD_SLOTS = 64

export class ArtifactPurged extends Schema.TaggedError<
	ArtifactPurged,
	{ readonly brand: unique symbol }
>()("ArtifactPurged", { artifact_id: Schema.String }) {}

export class ArtifactReservationStale extends Schema.TaggedError<
	ArtifactReservationStale,
	{ readonly brand: unique symbol }
>()("ArtifactReservationStale", { artifact_id: Schema.String, reservation: Schema.Int }) {}

export interface ArtifactPutOptions {
	readonly contentType?: string
	readonly sha256?: string
}

export interface ArtifactBucketWriter<R> {
	readonly put: (
		key: string,
		body: Uint8Array | string,
		options?: ArtifactPutOptions,
	) => Effect.Effect<void, ArtifactStoreError, R>
	readonly has: (key: string) => Effect.Effect<boolean, ArtifactStoreError, R>
	readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void, ArtifactStoreError, R>
	readonly list: (prefix: string) => Effect.Effect<Array<string>, ArtifactStoreError, R>
	readonly putStream: (
		key: string,
		body: ReadableStream<Uint8Array>,
		size: number,
		sha256: string,
	) => Effect.Effect<"stored" | "mismatch", ArtifactStoreError, R>
	readonly verifyStream: (
		body: ReadableStream<Uint8Array>,
		size: number,
		sha256: string,
	) => Effect.Effect<"stored" | "mismatch", ArtifactStoreError, R>
}

export interface ArtifactOwnerPorts<R> {
	readonly scope: string
	readonly bucket: ArtifactBucketWriter<R>
	readonly marks: Effect.Effect<OwnerMarks, ArtifactStoreError, R>
	readonly saveMarks: (marks: OwnerMarks) => Effect.Effect<void, ArtifactStoreError, R>
}

export const makeArtifactOwner = <R>(ports: ArtifactOwnerPorts<R>) => {
	const { scope, bucket } = ports
	const lock = Semaphore.makeUnsafe(1)
	const uploads = Semaphore.makeUnsafe(UPLOAD_SLOTS)
	const exclusive = <A, E, R2>(effect: Effect.Effect<A, E, R2>) =>
		uploads.withPermits(UPLOAD_SLOTS)(lock.withPermit(effect))
	const blobLocks = new Map<string, { readonly lock: Semaphore.Semaphore; holders: number }>()
	const perBlob = <A, E, R2>(key: string, effect: Effect.Effect<A, E, R2>) =>
		Effect.acquireUseRelease(
			Effect.sync(() => {
				const entry = blobLocks.get(key) ?? { lock: Semaphore.makeUnsafe(1), holders: 0 }
				entry.holders += 1
				blobLocks.set(key, entry)
				return entry
			}),
			(entry) => entry.lock.withPermit(effect),
			(entry) =>
				Effect.sync(() => {
					entry.holders -= 1
					if (entry.holders === 0) {
						blobLocks.delete(key)
					}
				}),
		)

	const putMissing = (key: string, body: Uint8Array | string, options: ArtifactPutOptions) =>
		Effect.flatMap(bucket.has(key), (stored) =>
			stored ? Effect.void : bucket.put(key, body, options),
		)

	const stage = (
		artifactId: string,
		built: BuiltArtifactVersion | null,
		reservation: number | null,
	) =>
		lock.withPermit(
			Effect.gen(function* () {
				const decision = ownerTransition(yield* ports.marks, "stage", reservation)
				if (decision.action === "purged") {
					return yield* new ArtifactPurged({ artifact_id: artifactId })
				}
				if (decision.action === "stale") {
					return yield* new ArtifactReservationStale({
						artifact_id: artifactId,
						reservation: decision.reservation,
					})
				}
				if (decision.action === "stage") {
					yield* ports.saveMarks(decision.marks)
				}
				if (built === null) {
					return
				}
				yield* Effect.forEach(
					built.blobs,
					(blob) =>
						putMissing(artifactBlobKey(scope, artifactId, blob.sha256), blob.bytes, {
							sha256: blob.sha256,
						}),
					{ concurrency: PUT_CONCURRENCY, discard: true },
				)
				yield* putMissing(
					artifactManifestKey(scope, artifactId, built.manifest_hash),
					built.manifest_json,
					{ contentType: "application/json" },
				)
			}),
		)

	const deleteAll = (artifactId: string) =>
		deleteUntilEmpty(bucket.list(artifactPrefix(scope, artifactId)), bucket.delete)

	const putBlob = (
		artifactId: string,
		sha256: string,
		body: ReadableStream<Uint8Array>,
		size: number,
		reservation: number | null,
	) =>
		uploads.withPermits(1)(
			Effect.gen(function* () {
				const key = artifactBlobKey(scope, artifactId, sha256)
				return yield* perBlob(
					key,
					Effect.gen(function* () {
						const decision = ownerTransition(yield* ports.marks, "check", reservation)
						if (decision.action === "purged") {
							return yield* new ArtifactPurged({ artifact_id: artifactId })
						}
						if (decision.action === "stale") {
							return yield* new ArtifactReservationStale({
								artifact_id: artifactId,
								reservation: decision.reservation,
							})
						}
						if (yield* bucket.has(key)) {
							return yield* bucket.verifyStream(body, size, sha256)
						}
						if (size === 0) {
							const empty = yield* bucket.verifyStream(body, 0, sha256)
							if (empty === "mismatch") {
								return empty
							}
							yield* bucket.put(key, new Uint8Array(0), { sha256 })
							return "stored" as const
						}
						return yield* bucket.putStream(key, body, size, sha256)
					}),
				)
			}),
		)

	const release = (artifactId: string, reservation: number) =>
		exclusive(
			Effect.gen(function* () {
				const decision = ownerTransition(yield* ports.marks, "release", reservation)
				if (decision.action === "keep") {
					return
				}
				if (decision.action === "removeThenRelease") {
					yield* deleteAll(artifactId)
				}
				yield* ports.saveMarks(decision.marks)
			}),
		)

	const purge = (artifactId: string) =>
		exclusive(
			Effect.gen(function* () {
				const decision = ownerTransition(yield* ports.marks, "purge", null)
				if (decision.action === "markThenRemove") {
					yield* ports.saveMarks(decision.marks)
				}
				yield* deleteAll(artifactId)
			}),
		)

	return { stage, putBlob, release, purge }
}

export type ArtifactOwner<R> = ReturnType<typeof makeArtifactOwner<R>>
