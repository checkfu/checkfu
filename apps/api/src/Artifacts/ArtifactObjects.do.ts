import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Hex from "effect/encoding/Hex"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { placedStub, placement, storageScope, storageScopeOf } from "../Placement.ts"
import type { BuiltArtifactVersion } from "./ArtifactFiles.ts"
import {
	ArtifactPurged,
	ArtifactReservationStale,
	UNMARKED,
	makeArtifactOwner,
} from "./ArtifactOwnership.ts"
import type { ArtifactBucketWriter, ArtifactMarks } from "./ArtifactOwnership.ts"
import {
	ArtifactBucket,
	ArtifactStore,
	ArtifactStoreError,
	artifactReads,
	isChecksumMismatch,
} from "./ArtifactStore.ts"

const LIST_PAGE_SIZE = 1000

const MARKS_KEY = "marks"

const storeError = (cause: unknown) => new ArtifactStoreError({ cause })

declare global {
	interface Crypto {
		readonly DigestStream: new (
			algorithm: string,
		) => WritableStream<ArrayBufferView> & { readonly digest: Promise<ArrayBuffer> }
	}
}

const hexOf = (buffer: ArrayBuffer) => Hex.encode(new Uint8Array(buffer))

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
	putStream: (key, body, size, sha256) =>
		bucket
			.put(key, Stream.fromReadableStream({ evaluate: () => body, onError: storeError }), {
				sha256,
				contentLength: size,
			})
			.pipe(
				Effect.as("stored" as const),
				Effect.catch((error) =>
					isChecksumMismatch(error)
						? Effect.succeed("mismatch" as const)
						: Effect.fail(storeError(error)),
				),
			),
	verifyStream: (body, size, sha256) =>
		Effect.tryPromise({
			try: async () => {
				const digest = new crypto.DigestStream("SHA-256")
				let received = 0
				await body
					.pipeThrough(
						new TransformStream<Uint8Array, Uint8Array>({
							transform: (chunk, controller) => {
								received += chunk.byteLength
								controller.enqueue(chunk)
							},
						}),
					)
					.pipeTo(digest)
				return received === size && hexOf(await digest.digest) === sha256
					? ("stored" as const)
					: ("mismatch" as const)
			},
			catch: storeError,
		}),
})

interface ArtifactObjectsShape {
	readonly stage: (
		artifactId: string,
		built: BuiltArtifactVersion | null,
		reservation: number | null,
	) => Effect.Effect<"staged" | "purged" | "stale", ArtifactStoreError, RuntimeContext>
	readonly putBlob: (
		artifactId: string,
		sha256: string,
		body: ReadableStream<Uint8Array>,
		size: number,
		reservation: number | null,
	) => Effect.Effect<"stored" | "mismatch" | "purged" | "stale", ArtifactStoreError, RuntimeContext>
	readonly release: (
		artifactId: string,
		reservation: number,
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
							onSuccess: (marks) => marks ?? UNMARKED,
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
								Effect.as("staged" as const),
								Effect.catchTags({
									ArtifactPurged: () => Effect.succeed("purged" as const),
									ArtifactReservationStale: () => Effect.succeed("stale" as const),
								}),
							),
						),
					putBlob: (artifactId, sha256, body, size, reservation) =>
						overWire(
							owner.putBlob(artifactId, sha256, body, size, reservation).pipe(
								Effect.catchTags({
									ArtifactPurged: () => Effect.succeed("purged" as const),
									ArtifactReservationStale: () => Effect.succeed("stale" as const),
								}),
							),
						),
					release: (artifactId, reservation) => overWire(owner.release(artifactId, reservation)),
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
					Effect.flatMap(
						(outcome): Effect.Effect<void, ArtifactPurged | ArtifactReservationStale> =>
							outcome === "staged"
								? Effect.void
								: outcome === "purged"
									? Effect.fail(new ArtifactPurged({ artifact_id: artifactId }))
									: Effect.fail(
											new ArtifactReservationStale({
												artifact_id: artifactId,
												reservation: reservation ?? 0,
											}),
										),
					),
				),
			...artifactReads(scope, bucket, run),
			putBlob: (artifactId, sha256, body, size, reservation) =>
				call(() =>
					owners(artifactId).putBlob(
						artifactId,
						sha256,
						Stream.toReadableStream(body),
						size,
						reservation,
					),
				).pipe(
					Effect.flatMap(
						(
							outcome,
						): Effect.Effect<"stored" | "mismatch", ArtifactPurged | ArtifactReservationStale> =>
							outcome === "purged"
								? Effect.fail(new ArtifactPurged({ artifact_id: artifactId }))
								: outcome === "stale"
									? Effect.fail(
											new ArtifactReservationStale({
												artifact_id: artifactId,
												reservation: reservation ?? 0,
											}),
										)
									: Effect.succeed(outcome),
					),
				),
			purge: (artifactId) => call(() => owners(artifactId).purge(artifactId)),
			release: (artifactId, reservation) =>
				call(() => owners(artifactId).release(artifactId, reservation)),
		}
	}),
)
