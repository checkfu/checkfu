import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Config from "effect/Config"
import { SourceError } from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { ByteRange } from "../Content/ByteRange.ts"
import { JURISDICTION_ENV, placement, storageScope } from "../Placement.ts"
import { ArtifactManifestJson } from "./ArtifactFiles.ts"
import type { ArtifactManifest, BuiltArtifactVersion } from "./ArtifactFiles.ts"
import type { ArtifactPurged, ArtifactReservationStale } from "./ArtifactOwnership.ts"

export class ArtifactStoreError extends Schema.TaggedError<
	ArtifactStoreError,
	{ readonly brand: unique symbol }
>()("ArtifactStoreError", { cause: Schema.Unknown }) {}

export interface ArtifactStoreService {
	readonly stage: (
		artifactId: string,
		version: BuiltArtifactVersion | null,
		reservation: number | null,
	) => Effect.Effect<void, ArtifactStoreError | ArtifactPurged | ArtifactReservationStale>
	readonly getManifest: (
		artifactId: string,
		manifestHash: string,
	) => Effect.Effect<ArtifactManifest | null, ArtifactStoreError>
	readonly getBlob: (
		artifactId: string,
		sha256: string,
		range?: ByteRange,
	) => Effect.Effect<Uint8Array | null, ArtifactStoreError>
	readonly hasBlob: (
		artifactId: string,
		sha256: string,
	) => Effect.Effect<boolean, ArtifactStoreError>
	readonly blobSize: (
		artifactId: string,
		sha256: string,
	) => Effect.Effect<number | null, ArtifactStoreError>
	readonly blobStream: (
		artifactId: string,
		sha256: string,
		range?: ByteRange,
	) => Effect.Effect<Stream.Stream<Uint8Array, ArtifactStoreError> | null, ArtifactStoreError>
	readonly putBlob: (
		artifactId: string,
		sha256: string,
		body: Stream.Stream<Uint8Array, ArtifactStoreError>,
		size: number,
		reservation: number | null,
	) => Effect.Effect<
		"stored" | "mismatch",
		ArtifactStoreError | ArtifactPurged | ArtifactReservationStale
	>
	readonly purge: (artifactId: string) => Effect.Effect<void, ArtifactStoreError>
	readonly release: (
		artifactId: string,
		reservation: number,
	) => Effect.Effect<void, ArtifactStoreError>
}

export class ArtifactStore extends Context.Service<ArtifactStore, ArtifactStoreService>()(
	"@checkfu/api/ArtifactStore",
) {}

export type ArtifactReaderService = Pick<
	ArtifactStoreService,
	"getManifest" | "getBlob" | "hasBlob" | "blobSize" | "blobStream"
>

export class ArtifactReader extends Context.Service<ArtifactReader, ArtifactReaderService>()(
	"@checkfu/api/ArtifactReader",
) {}

export const artifactPrefix = (scope: string, artifactId: string) =>
	`artifacts/${scope}/${artifactId}/`
export const artifactBlobKey = (scope: string, artifactId: string, sha256: string) =>
	`${artifactPrefix(scope, artifactId)}blobs/${sha256}`
export const artifactManifestKey = (scope: string, artifactId: string, manifestHash: string) =>
	`${artifactPrefix(scope, artifactId)}manifests/${manifestHash}.json`

export const ARTIFACT_BUCKET_PROPS = { forceDestroy: true } as const

export const artifactBucketProps: Config.Config<Cloudflare.R2.BucketProps> = Config.flatMap(
	placement,
	({ jurisdiction }): Config.Config<Cloudflare.R2.BucketProps> =>
		jurisdiction === undefined
			? Config.succeed(ARTIFACT_BUCKET_PROPS)
			: jurisdiction === "fedramp-high"
				? Config.fail(
						new SourceError({
							message: `${JURISDICTION_ENV}=${jurisdiction} places Durable Objects there, but R2 cannot keep artifact files in that jurisdiction. Use eu, fedramp or us, or leave it empty.`,
						}),
					)
				: Config.succeed({ ...ARTIFACT_BUCKET_PROPS, jurisdiction }),
)

export const ArtifactBucket = Effect.gen(function* () {
	return yield* Cloudflare.R2.Bucket("ArtifactBucket", yield* artifactBucketProps)
})

export const deleteUntilEmpty = <E, R>(
	firstPage: Effect.Effect<Array<string>, E, R>,
	remove: (keys: Array<string>) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
	Effect.gen(function* () {
		while (true) {
			const keys = yield* firstPage
			if (keys.length === 0) {
				return
			}
			yield* remove(keys)
		}
	})

const decodeManifest = Schema.decodeUnknownEffect(ArtifactManifestJson)

type Run = <A, E>(
	effect: Effect.Effect<A, E, RuntimeContext>,
) => Effect.Effect<A, ArtifactStoreError>

const runWith =
	(runtime: RuntimeContext["Service"]): Run =>
	(effect) =>
		effect.pipe(
			Effect.mapError((cause) => new ArtifactStoreError({ cause })),
			Effect.provideService(RuntimeContext, runtime),
		)

export const artifactReads = (
	scope: string,
	bucket: Pick<Cloudflare.R2.ReadBucketClient, "get" | "head">,
	run: Run,
): ArtifactReaderService => ({
	getManifest: (artifactId, manifestHash) =>
		run(
			Effect.gen(function* () {
				const object = yield* bucket.get(artifactManifestKey(scope, artifactId, manifestHash))
				return object === null ? null : yield* decodeManifest(yield* object.text())
			}),
		),
	getBlob: (artifactId, sha256, range) =>
		run(
			Effect.gen(function* () {
				const object = yield* bucket.get(
					artifactBlobKey(scope, artifactId, sha256),
					range === undefined ? undefined : { range },
				)
				return object === null ? null : yield* object.bytes()
			}),
		),
	hasBlob: (artifactId, sha256) =>
		run(
			Effect.map(
				bucket.head(artifactBlobKey(scope, artifactId, sha256)),
				(object) => object !== null,
			),
		),
	blobSize: (artifactId, sha256) =>
		run(
			Effect.map(bucket.head(artifactBlobKey(scope, artifactId, sha256)), (object) =>
				object === null ? null : object.size,
			),
		),
	blobStream: (artifactId, sha256, range) =>
		run(
			Effect.map(
				bucket.get(
					artifactBlobKey(scope, artifactId, sha256),
					range === undefined ? undefined : { range },
				),
				(object) =>
					object === null
						? null
						: object.body.pipe(Stream.mapError((cause) => new ArtifactStoreError({ cause }))),
			),
		),
})

export const isChecksumMismatch = (cause: unknown): boolean =>
	/sha-?256|checksum|digest/i.test(String(cause))

export const ArtifactReaderR2 = Layer.effect(
	ArtifactReader,
	Effect.gen(function* () {
		const bucket = yield* Cloudflare.R2.ReadBucket(yield* ArtifactBucket)
		const scope = yield* Effect.orDie(storageScope)
		return artifactReads(scope, bucket, runWith(yield* Cloudflare.Worker))
	}),
)
