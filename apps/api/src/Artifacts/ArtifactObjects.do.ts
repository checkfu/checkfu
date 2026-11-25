import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { placedStub, placement, storageScope, storageScopeOf } from "../Placement.ts"
import type { BuiltArtifactVersion } from "./ArtifactFiles.ts"
import { ArtifactPurged, makeArtifactOwner } from "./ArtifactOwnership.ts"
import type { ArtifactBucketWriter, ArtifactMarks } from "./ArtifactOwnership.ts"
import {
	ArtifactBucket,
	ArtifactStore,
	ArtifactStoreError,
	artifactReads,
} from "./ArtifactStore.ts"

const LIST_PAGE_SIZE = 1000

const MARKS_KEY = "marks"

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
	has: (key) =>
		bucket
			.head(key)
			.pipe(Effect.mapBoth({ onSuccess: (object) => object !== null, onFailure: storeError })),
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
		built: BuiltArtifactVersion,
		reservation: string | null,
	) => Effect.Effect<boolean, ArtifactStoreError, RuntimeContext>
	readonly release: (
		artifactId: string,
		writeId: string,
	) => Effect.Effect<void, ArtifactStoreError, RuntimeContext>
	readonly purge: (artifactId: string) => Effect.Effect<void, ArtifactStoreError, RuntimeContext>
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
					bucket: makeWriter(bucket),
					marks: state.storage.get<ArtifactMarks>(MARKS_KEY).pipe(
						Effect.mapBoth({
							onSuccess: (marks) => marks ?? { purged: false, reservation: null },
							onFailure: storeError,
						}),
					),
					saveMarks: (marks) =>
						state.storage.put(MARKS_KEY, marks).pipe(Effect.mapError(storeError)),
				})
				return {
					stage: (artifactId, built, reservation) =>
						overWire(
							owner.stage(artifactId, built, reservation).pipe(
								Effect.as(true),
								Effect.catchTag("ArtifactPurged", () => Effect.succeed(false)),
							),
						),
					release: (artifactId, writeId) => overWire(owner.release(artifactId, writeId)),
					purge: (artifactId) => overWire(owner.purge(artifactId)),
				}
			}),
	),
)

export const ArtifactStoreR2 = Layer.effect(
	ArtifactStore,
	Effect.gen(function* () {
		const bucket = yield* Cloudflare.R2.ReadBucket(yield* ArtifactBucket)
		const placed = yield* placement
		const scope = storageScopeOf(placed)
		const owners = placedStub(yield* ArtifactObjects, placed)
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
		return {
			stage: (artifactId, version, reservation) =>
				call(() => owners(artifactId).stage(artifactId, version, reservation)).pipe(
					Effect.flatMap((staged) =>
						staged ? Effect.void : Effect.fail(new ArtifactPurged({ artifact_id: artifactId })),
					),
				),
			...artifactReads(scope, bucket, run),
			purge: (artifactId) => call(() => owners(artifactId).purge(artifactId)),
			release: (artifactId, writeId) => call(() => owners(artifactId).release(artifactId, writeId)),
		}
	}),
)
