import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Semaphore from "effect/Semaphore"
import type { BuiltArtifactVersion } from "./ArtifactFiles.ts"
import {
	ArtifactStoreError,
	ArtifactWriteRefused,
	ARTIFACT_DELETE_PREFIX,
	artifactBlobKey,
	artifactManifestKey,
	artifactMarkerKey,
	artifactPrefix,
	deleteUntilEmpty,
} from "./ArtifactStore.ts"
import type { ArtifactWriteMarker } from "./ArtifactStore.ts"

export const ARTIFACT_WRITE_GRACE_MS = 15 * 60 * 1000
export const ORPHAN_RETRY_MS = 60 * 1000

const PUT_CONCURRENCY = 4
const DELETE_BATCH = 1000

export type ArtifactWriteStatus = "staged" | "committed" | "abandoned"

export interface ArtifactWrite {
	readonly write_id: string
	readonly staged_at: number
	readonly status: ArtifactWriteStatus
}

export interface ArtifactLedger {
	readonly transaction: <A>(run: () => A) => A
	readonly findWrite: (writeId: string) => ArtifactWrite | undefined
	readonly saveWrite: (write: ArtifactWrite) => void
	readonly stagedWrites: () => ReadonlyArray<ArtifactWrite>
	readonly oldestAbandoned: () => number | undefined
	readonly dropAbandoned: (stagedBefore: number) => void
	readonly isStored: (key: string) => boolean
	readonly saveKey: (key: string, stored: boolean) => void
	readonly hold: (key: string, writeId: string) => void
	readonly commit: (writeId: string) => void
	readonly retain: (writeId: string) => void
	readonly release: (writeId: string) => void
	readonly hasUnreferenced: () => boolean
	readonly unreferenced: () => ReadonlyArray<string>
	readonly dropKeys: (keys: ReadonlyArray<string>) => void
	readonly isEmpty: () => boolean
	readonly clear: Effect.Effect<void>
}

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
	readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void, ArtifactStoreError, R>
	readonly list: (prefix: string) => Effect.Effect<Array<string>, ArtifactStoreError, R>
}

export interface ArtifactOwnerPorts<R> {
	readonly scope: string
	readonly ledger: ArtifactLedger
	readonly bucket: ArtifactBucketWriter<R>
	readonly now: Effect.Effect<number, never, R>
	readonly alarm: Effect.Effect<number | null, never, R>
	readonly setAlarm: (at: number | null) => Effect.Effect<void, never, R>
	readonly grace?: number
}

const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> =>
	Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
		items.slice(index * size, (index + 1) * size),
	)

export const makeArtifactOwner = <R>(ports: ArtifactOwnerPorts<R>) => {
	const { scope, ledger, bucket } = ports
	const grace = ports.grace ?? ARTIFACT_WRITE_GRACE_MS
	const lock = Semaphore.makeUnsafe(1)

	const rearm = Effect.gen(function* () {
		const now = yield* ports.now
		const due = ledger.stagedWrites().map((write) => write.staged_at + grace)
		const abandoned = ledger.oldestAbandoned()
		if (abandoned !== undefined) {
			due.push(abandoned + grace)
		}
		if (ledger.hasUnreferenced()) {
			due.push(now + ORPHAN_RETRY_MS)
		}
		if (due.length === 0) {
			yield* ports.setAlarm(null)
			if (ledger.isEmpty()) {
				yield* ledger.clear
			}
			return
		}
		const armed = yield* ports.alarm
		yield* ports.setAlarm(
			Math.min(
				...due.map((at) => (at > now ? at : now + ORPHAN_RETRY_MS)),
				...(armed !== null && armed > now ? [armed] : []),
			),
		)
	})

	const release = (writeIds: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			const orphans = ledger.transaction(() => {
				for (const writeId of writeIds) {
					const write = ledger.findWrite(writeId)
					if (write !== undefined) {
						ledger.saveWrite({ ...write, status: "abandoned" })
					}
					ledger.release(writeId)
				}
				const keys = ledger.unreferenced()
				for (const key of keys) {
					ledger.saveKey(key, false)
				}
				return keys
			})
			for (const batch of chunks(orphans, DELETE_BATCH)) {
				yield* bucket.delete(batch)
				ledger.transaction(() => ledger.dropKeys(batch))
			}
		})

	const reclaim = (writeIds: ReadonlyArray<string>) =>
		release(writeIds).pipe(Effect.ensuring(rearm))

	const put = (key: string, body: Uint8Array | string, options?: ArtifactPutOptions) =>
		Effect.andThen(
			bucket.put(key, body, options),
			Effect.sync(() => ledger.transaction(() => ledger.saveKey(key, true))),
		)

	const stage = (artifactId: string, writeId: string, built: BuiltArtifactVersion) =>
		lock.withPermit(
			Effect.gen(function* () {
				const now = yield* ports.now
				const manifestKey = artifactManifestKey(scope, artifactId, built.manifest_hash)
				const armed = yield* ports.alarm
				yield* ports.setAlarm(
					armed !== null && armed > now ? Math.min(armed, now + grace) : now + grace,
				)
				const missing = ledger.transaction(() => {
					if (ledger.findWrite(writeId) !== undefined) {
						return undefined
					}
					ledger.saveWrite({ write_id: writeId, staged_at: now, status: "staged" })
					const keys = [
						...built.blobs.map((blob) => artifactBlobKey(scope, artifactId, blob.sha256)),
						manifestKey,
					]
					const unstored = new Set<string>()
					for (const key of keys) {
						if (!ledger.isStored(key)) {
							ledger.saveKey(key, false)
							unstored.add(key)
						}
						ledger.hold(key, writeId)
					}
					return unstored
				})
				if (missing === undefined) {
					return yield* new ArtifactStoreError({
						cause: new Error(`Artifact write ${writeId} was already staged.`),
					})
				}
				yield* rearm
				const uploads = yield* Effect.forEach(
					built.blobs.filter((blob) =>
						missing.has(artifactBlobKey(scope, artifactId, blob.sha256)),
					),
					(blob) =>
						Effect.result(
							put(artifactBlobKey(scope, artifactId, blob.sha256), blob.bytes, {
								sha256: blob.sha256,
							}),
						),
					{ concurrency: PUT_CONCURRENCY },
				)
				const failed = uploads.find(Result.isFailure)
				const outcome =
					failed !== undefined
						? Effect.fail(failed.failure)
						: missing.has(manifestKey)
							? put(manifestKey, built.manifest_json, { contentType: "application/json" })
							: Effect.void
				yield* outcome.pipe(Effect.tapError(() => Effect.ignore(reclaim([writeId]))))
			}),
		)

	const markCommitted = (writeId: string, marker: ArtifactWriteMarker | null) =>
		lock.withPermit(
			Effect.gen(function* () {
				const now = yield* ports.now
				const write = ledger.findWrite(writeId)
				const reason =
					write === undefined
						? "is unknown"
						: write.status === "abandoned"
							? "was abandoned"
							: write.status === "staged" && now - write.staged_at >= grace
								? "was staged too long ago to commit"
								: undefined
				if (write === undefined || reason !== undefined) {
					return yield* new ArtifactWriteRefused({ write_id: writeId, reason: reason ?? "" })
				}
				if (write.status === "committed") {
					return
				}
				if (marker !== null) {
					yield* bucket.put(
						artifactMarkerKey(scope, marker.artifact_id, writeId),
						JSON.stringify(marker),
						{ contentType: "application/json" },
					)
				}
				ledger.transaction(() => {
					ledger.saveWrite({ ...write, status: "committed" })
					ledger.commit(writeId)
				})
			}),
		)

	const settle = (artifactId: string, writeId: string) =>
		bucket.delete([artifactMarkerKey(scope, artifactId, writeId)])

	const confirm = (artifactId: string, writeId: string) =>
		lock.withPermit(
			Effect.andThen(
				Effect.sync(() =>
					ledger.transaction(() => {
						if (ledger.findWrite(writeId)?.status === "committed") {
							ledger.retain(writeId)
						}
					}),
				),
				settle(artifactId, writeId),
			),
		)

	const abandon = (artifactId: string, writeId: string) =>
		lock.withPermit(Effect.andThen(reclaim([writeId]), settle(artifactId, writeId)))

	const sweep = lock.withPermit(
		Effect.gen(function* () {
			const now = yield* ports.now
			yield* release(
				ledger
					.stagedWrites()
					.filter((write) => now - write.staged_at >= grace)
					.map((write) => write.write_id),
			)
			ledger.transaction(() => ledger.dropAbandoned(now - grace))
		}).pipe(Effect.ensuring(rearm)),
	)

	const purge = (artifactId: string) =>
		lock.withPermit(
			Effect.gen(function* () {
				yield* deleteUntilEmpty(bucket.list(artifactPrefix(scope, artifactId)), bucket.delete)
				yield* ports.setAlarm(null)
				yield* ledger.clear
				yield* deleteUntilEmpty(
					bucket.list(artifactMarkerKey(scope, artifactId, ARTIFACT_DELETE_PREFIX)),
					bucket.delete,
				)
			}),
		)

	const alarm = sweep.pipe(
		Effect.tapCause((cause) => Effect.logError("Artifact write sweep failed", cause)),
		Effect.orDie,
	)

	return { stage, markCommitted, confirm, abandon, sweep, alarm, purge }
}

export type ArtifactOwner<R> = ReturnType<typeof makeArtifactOwner<R>>
