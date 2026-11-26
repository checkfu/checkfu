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
}

export const ArtifactMarks = Schema.Struct({
	purged: Schema.Boolean,
	staged: Schema.Int,
	released: Schema.Int,
})
export type ArtifactMarks = typeof ArtifactMarks.Type

export interface ArtifactOwnerPorts<R> {
	readonly scope: string
	readonly bucket: ArtifactBucketWriter<R>
	readonly marks: Effect.Effect<ArtifactMarks, ArtifactStoreError, R>
	readonly saveMarks: (marks: ArtifactMarks) => Effect.Effect<void, ArtifactStoreError, R>
}

export const makeArtifactOwner = <R>(ports: ArtifactOwnerPorts<R>) => {
	const { scope, bucket } = ports
	const lock = Semaphore.makeUnsafe(1)
	const uploads = Semaphore.makeUnsafe(UPLOAD_SLOTS)
	const exclusive = <A, E, R2>(effect: Effect.Effect<A, E, R2>) =>
		uploads.withPermits(UPLOAD_SLOTS)(lock.withPermit(effect))

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
				const marks = yield* ports.marks
				if (marks.purged) {
					return yield* new ArtifactPurged({ artifact_id: artifactId })
				}
				if (reservation !== null) {
					if (reservation <= marks.released || reservation < marks.staged) {
						return yield* new ArtifactReservationStale({ artifact_id: artifactId, reservation })
					}
					if (reservation > marks.staged) {
						yield* ports.saveMarks({ ...marks, staged: reservation })
					}
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
	) =>
		uploads.withPermits(1)(
			Effect.gen(function* () {
				if ((yield* ports.marks).purged) {
					return yield* new ArtifactPurged({ artifact_id: artifactId })
				}
				return yield* bucket.putStream(
					artifactBlobKey(scope, artifactId, sha256),
					body,
					size,
					sha256,
				)
			}),
		)

	const release = (artifactId: string, reservation: number) =>
		exclusive(
			Effect.gen(function* () {
				const marks = yield* ports.marks
				if (marks.purged || reservation <= marks.released) {
					return
				}
				if (marks.staged <= reservation) {
					yield* deleteAll(artifactId)
				}
				yield* ports.saveMarks({ ...marks, released: reservation })
			}),
		)

	const purge = (artifactId: string) =>
		exclusive(
			Effect.gen(function* () {
				const marks = yield* ports.marks
				if (!marks.purged) {
					yield* ports.saveMarks({ ...marks, purged: true })
				}
				yield* deleteAll(artifactId)
			}),
		)

	return { stage, putBlob, release, purge }
}

export const UNMARKED: ArtifactMarks = { purged: false, staged: 0, released: 0 }

export type ArtifactOwner<R> = ReturnType<typeof makeArtifactOwner<R>>
