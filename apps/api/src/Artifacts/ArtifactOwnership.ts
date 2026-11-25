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

export class ArtifactPurged extends Schema.TaggedError<
	ArtifactPurged,
	{ readonly brand: unique symbol }
>()("ArtifactPurged", { artifact_id: Schema.String }) {}

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
}

export const ArtifactMarks = Schema.Struct({
	purged: Schema.Boolean,
	reservation: Schema.NullOr(Schema.String),
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

	const putMissing = (key: string, body: Uint8Array | string, options: ArtifactPutOptions) =>
		Effect.flatMap(bucket.has(key), (stored) =>
			stored ? Effect.void : bucket.put(key, body, options),
		)

	const stage = (artifactId: string, built: BuiltArtifactVersion, reservation: string | null) =>
		lock.withPermit(
			Effect.gen(function* () {
				const marks = yield* ports.marks
				if (marks.purged) {
					return yield* new ArtifactPurged({ artifact_id: artifactId })
				}
				if (reservation !== null && marks.reservation !== reservation) {
					yield* ports.saveMarks({ ...marks, reservation })
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

	const release = (artifactId: string, writeId: string) =>
		lock.withPermit(
			Effect.gen(function* () {
				const marks = yield* ports.marks
				if (marks.purged || marks.reservation !== writeId) {
					return
				}
				yield* deleteAll(artifactId)
				yield* ports.saveMarks({ ...marks, reservation: null })
			}),
		)

	const purge = (artifactId: string) =>
		lock.withPermit(
			Effect.gen(function* () {
				const marks = yield* ports.marks
				if (!marks.purged) {
					yield* ports.saveMarks({ purged: true, reservation: null })
				}
				yield* deleteAll(artifactId)
			}),
		)

	return { stage, release, purge }
}

export type ArtifactOwner<R> = ReturnType<typeof makeArtifactOwner<R>>
