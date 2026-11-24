import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { placedStub, placement, storageScope, storageScopeOf } from "../Placement.ts"
import type { BuiltArtifactVersion } from "./ArtifactFiles.ts"
import { makeArtifactOwner } from "./ArtifactOwnership.ts"
import { makeSqlLedger } from "./ArtifactLedgerSql.ts"
import type { ArtifactBucketWriter } from "./ArtifactOwnership.ts"
import {
	ARTIFACT_DELETE_PREFIX,
	ArtifactBucket,
	ArtifactStore,
	ArtifactStoreError,
	ArtifactWriteMarkerJson,
	ArtifactWriteRefused,
	listedMarkers,
	artifactReads,
	artifactMarkerKey,
	artifactMarkerPrefix,
	artifactReconcileCursorKey,
	committedOrFailed,
} from "./ArtifactStore.ts"
import type { ArtifactWriteMarker, StagedWrite } from "./ArtifactStore.ts"

const LIST_PAGE_SIZE = 1000

const storeError = (cause: unknown) => new ArtifactStoreError({ cause })

const overWire = <A, R>(effect: Effect.Effect<A, ArtifactStoreError, R>) =>
	Effect.mapError(effect, (error) => storeError(String(error.cause)))

const makeWriter = (
	bucket: Cloudflare.R2.ReadWriteBucketClient,
): ArtifactBucketWriter<RuntimeContext> => ({
	put: (key, body, { contentType, sha256 } = {}) =>
		bucket
			.put(key, body, {
				...(contentType === undefined ? {} : { httpMetadata: { contentType } }),
				...(sha256 === undefined ? {} : { sha256 }),
			})
			.pipe(Effect.asVoid, Effect.mapError(storeError)),
	delete: (keys) => bucket.delete([...keys]).pipe(Effect.mapError(storeError)),
	list: (prefix) =>
		bucket.list({ prefix, limit: LIST_PAGE_SIZE }).pipe(
			Effect.mapBoth({
				onSuccess: (page) => page.objects.map((object) => object.key),
				onFailure: storeError,
			}),
		),
})

interface ArtifactObjectsShape {
	readonly stage: (
		artifactId: string,
		writeId: string,
		built: BuiltArtifactVersion,
	) => Effect.Effect<void, ArtifactStoreError, RuntimeContext>
	readonly markCommitted: (
		writeId: string,
		marker: ArtifactWriteMarker | null,
	) => Effect.Effect<string | null, ArtifactStoreError, RuntimeContext>
	readonly confirm: (
		artifactId: string,
		writeId: string,
	) => Effect.Effect<void, ArtifactStoreError, RuntimeContext>
	readonly abandon: (
		artifactId: string,
		writeId: string,
	) => Effect.Effect<void, ArtifactStoreError, RuntimeContext>
	readonly purge: (artifactId: string) => Effect.Effect<void, ArtifactStoreError, RuntimeContext>
	readonly alarm: () => Effect.Effect<void, never, RuntimeContext>
}

export class ArtifactObjects extends Cloudflare.DurableObject<
	ArtifactObjects,
	ArtifactObjectsShape
>()("ArtifactObjects") {}

export const ArtifactObjectsLive = ArtifactObjects.make(
	Effect.map(
		Effect.gen(function* () {
			const bucket = yield* Cloudflare.R2.ReadWriteBucket(yield* Effect.orDie(ArtifactBucket))
			const state = yield* Cloudflare.DurableObjectState
			const scope = yield* Effect.orDie(storageScope)
			return { bucket, state, scope }
		}),
		({ state, bucket, scope }) =>
			Effect.sync((): ArtifactObjectsShape => {
				const owner = makeArtifactOwner({
					scope,
					ledger: makeSqlLedger(state.raw.storage),
					bucket: makeWriter(bucket),
					now: Clock.currentTimeMillis,
					alarm: Effect.suspend(() => state.storage.getAlarm()),
					setAlarm: (at) =>
						at === null ? state.storage.deleteAlarm() : state.storage.setAlarm(at),
				})
				return {
					stage: (artifactId, writeId, built) => overWire(owner.stage(artifactId, writeId, built)),
					markCommitted: (writeId, marker) =>
						overWire(
							owner.markCommitted(writeId, marker).pipe(
								Effect.as(null),
								Effect.catchTag("ArtifactWriteRefused", (refused) =>
									Effect.succeed(refused.reason),
								),
							),
						),
					confirm: (artifactId, writeId) => overWire(owner.confirm(artifactId, writeId)),
					abandon: (artifactId, writeId) => overWire(owner.abandon(artifactId, writeId)),
					purge: (artifactId) => overWire(owner.purge(artifactId)),
					alarm: () => owner.alarm,
				}
			}),
	),
)

const decodeMarker = Schema.decodeUnknownEffect(ArtifactWriteMarkerJson)

export const ArtifactStoreR2 = Layer.effect(
	ArtifactStore,
	Effect.gen(function* () {
		const bucket = yield* Cloudflare.R2.ReadWriteBucket(yield* ArtifactBucket)
		const placed = yield* placement
		const scope = storageScopeOf(placed)
		const owners = placedStub(yield* ArtifactObjects, placed)
		const random = yield* SecureRandom.SecureRandom
		const runtime = yield* Cloudflare.Worker
		const run = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
			effect.pipe(Effect.mapError(storeError), Effect.provideService(RuntimeContext, runtime))
		const call = <A, E>(effect: () => Effect.Effect<A, E, RuntimeContext>) =>
			Effect.suspend(effect).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.fail(storeError(Cause.squash(cause))),
				),
				Effect.provideService(RuntimeContext, runtime),
			)
		const writeOf = (artifactId: string, writeId: string): StagedWrite => ({
			id: writeId,
			markCommitted: (check) =>
				call(() =>
					owners(artifactId).markCommitted(
						writeId,
						check === null ? null : { artifact_id: artifactId, write_id: writeId, check },
					),
				).pipe(
					Effect.flatMap((reason) =>
						reason === null
							? Effect.void
							: Effect.fail(new ArtifactWriteRefused({ write_id: writeId, reason })),
					),
				),
			confirm: call(() => owners(artifactId).confirm(artifactId, writeId)),
			abandon: call(() => owners(artifactId).abandon(artifactId, writeId)),
		})
		const stage = (artifactId: string, version: BuiltArtifactVersion) =>
			Effect.gen(function* () {
				const writeId = Hex.encode(yield* random.randomBytes(12))
				yield* call(() => owners(artifactId).stage(artifactId, writeId, version))
				return writeOf(artifactId, writeId)
			})
		const markerOf = (key: string) =>
			run(
				Effect.gen(function* () {
					const object = yield* bucket.get(key)
					return object === null ? null : yield* decodeMarker(yield* object.text())
				}),
			)
		const cursorKey = artifactReconcileCursorKey(scope)
		return {
			stage,
			putVersion: (artifactId, version) =>
				Effect.flatMap(stage(artifactId, version), (write) => committedOrFailed(write)),
			...artifactReads(scope, bucket, run),
			markDeleting: (artifactId) =>
				Effect.gen(function* () {
					const deleteId = `${ARTIFACT_DELETE_PREFIX}${Hex.encode(yield* random.randomBytes(12))}`
					yield* run(Effect.asVoid(bucket.put(artifactMarkerKey(scope, artifactId, deleteId), "")))
				}),
			purge: (artifactId) => call(() => owners(artifactId).purge(artifactId)),
			unconfirmedWrites: (startAfter, limit) =>
				run(
					Effect.gen(function* () {
						const page = yield* bucket.list({
							prefix: artifactMarkerPrefix(scope),
							limit,
							...(startAfter === null ? {} : { startAfter }),
						})
						const now = yield* Clock.currentTimeMillis
						return {
							writes: listedMarkers(scope, page.objects, now).map((listed) => {
								const write = writeOf(listed.artifact_id, listed.write_id)
								return {
									key: listed.key,
									artifact_id: listed.artifact_id,
									write_id: listed.write_id,
									age: listed.age,
									marker: markerOf(listed.key),
									confirm: write.confirm,
									abandon: write.abandon,
								}
							}),
							next: page.truncated ? (page.objects.at(-1)?.key ?? startAfter) : null,
						}
					}),
				),
			reconcileCursor: run(
				Effect.gen(function* () {
					const object = yield* bucket.get(cursorKey)
					const cursor = object === null ? "" : yield* object.text()
					return cursor === "" ? null : cursor
				}),
			),
			saveReconcileCursor: (cursor) =>
				run(
					cursor === null ? bucket.delete(cursorKey) : Effect.asVoid(bucket.put(cursorKey, cursor)),
				),
		}
	}),
)
