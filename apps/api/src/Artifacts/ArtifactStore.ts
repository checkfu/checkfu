import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Config from "effect/Config"
import { SourceError } from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { JURISDICTION_ENV, placement } from "../Placement.ts"
import type { ArtifactManifest, BuiltArtifactVersion } from "./ArtifactFiles.ts"

export class ArtifactStoreError extends Schema.TaggedError<
	ArtifactStoreError,
	{ readonly brand: unique symbol }
>()("ArtifactStoreError", { cause: Schema.Unknown }) {}

export class ArtifactWriteRefused extends Schema.TaggedError<
	ArtifactWriteRefused,
	{ readonly brand: unique symbol }
>()("ArtifactWriteRefused", { write_id: Schema.String, reason: Schema.String }) {}

export const ArtifactWriteCheck = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("create"), manifest: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("version"),
		manifest: Schema.String,
		expected_version: Schema.Finite,
	}),
])
export type ArtifactWriteCheck = typeof ArtifactWriteCheck.Type

export const ArtifactWriteMarker = Schema.Struct({
	artifact_id: Schema.String,
	write_id: Schema.String,
	check: ArtifactWriteCheck,
})
export type ArtifactWriteMarker = typeof ArtifactWriteMarker.Type

export const ArtifactWriteMarkerJson = Schema.fromJsonString(ArtifactWriteMarker)

export interface StagedWrite {
	readonly id: string
	readonly markCommitted: (
		check: ArtifactWriteCheck | null,
	) => Effect.Effect<void, ArtifactStoreError | ArtifactWriteRefused>
	readonly confirm: Effect.Effect<void, ArtifactStoreError>
	readonly abandon: Effect.Effect<void, ArtifactStoreError>
}

export interface UnconfirmedWrite {
	readonly key: string
	readonly artifact_id: string
	readonly write_id: string
	readonly age: number
	readonly marker: Effect.Effect<ArtifactWriteMarker | null, ArtifactStoreError>
	readonly confirm: Effect.Effect<void, ArtifactStoreError>
	readonly abandon: Effect.Effect<void, ArtifactStoreError>
}

export interface UnconfirmedPage {
	readonly writes: ReadonlyArray<UnconfirmedWrite>
	readonly next: string | null
}

export const committedOrFailed = (write: StagedWrite) =>
	Effect.catchTag(write.markCommitted(null), "ArtifactWriteRefused", (cause) =>
		Effect.fail(new ArtifactStoreError({ cause })),
	)

export interface ArtifactStoreService {
	readonly stage: (
		artifactId: string,
		version: BuiltArtifactVersion,
	) => Effect.Effect<StagedWrite, ArtifactStoreError>
	readonly putVersion: (
		artifactId: string,
		version: BuiltArtifactVersion,
	) => Effect.Effect<void, ArtifactStoreError>
	readonly getManifest: (
		artifactId: string,
		manifestHash: string,
	) => Effect.Effect<ArtifactManifest | null, ArtifactStoreError>
	readonly getBlob: (
		artifactId: string,
		sha256: string,
	) => Effect.Effect<Uint8Array | null, ArtifactStoreError>
	readonly markDeleting: (artifactId: string) => Effect.Effect<void, ArtifactStoreError>
	readonly purge: (artifactId: string) => Effect.Effect<void, ArtifactStoreError>
	readonly unconfirmedWrites: (
		startAfter: string | null,
		limit: number,
	) => Effect.Effect<UnconfirmedPage, ArtifactStoreError>
	readonly reconcileCursor: Effect.Effect<string | null, ArtifactStoreError>
	readonly saveReconcileCursor: (cursor: string | null) => Effect.Effect<void, ArtifactStoreError>
}

export class ArtifactStore extends Context.Service<ArtifactStore, ArtifactStoreService>()(
	"@checkfu/api/ArtifactStore",
) {}

export const artifactPrefix = (scope: string, artifactId: string) =>
	`artifacts/${scope}/${artifactId}/`
export const artifactBlobKey = (scope: string, artifactId: string, sha256: string) =>
	`${artifactPrefix(scope, artifactId)}blobs/${sha256}`
export const artifactManifestKey = (scope: string, artifactId: string, manifestHash: string) =>
	`${artifactPrefix(scope, artifactId)}manifests/${manifestHash}.json`

export const ARTIFACT_MARKER_ROOT = "reconcile/"
export const artifactMarkerPrefix = (scope: string) => `${ARTIFACT_MARKER_ROOT}${scope}/`
export const artifactMarkerKey = (scope: string, artifactId: string, writeId: string) =>
	`${artifactMarkerPrefix(scope)}${artifactId}/${writeId}`
export const ARTIFACT_DELETE_PREFIX = "delete-"
export const isDeleteMarker = (writeId: string) => writeId.startsWith(ARTIFACT_DELETE_PREFIX)
export const artifactReconcileCursorKey = (scope: string) => `reconcile-cursor/${scope}`
export const parseArtifactMarkerKey = (scope: string, key: string) => {
	const prefix = artifactMarkerPrefix(scope)
	if (!key.startsWith(prefix)) {
		return null
	}
	const [artifact_id, write_id, ...rest] = key.slice(prefix.length).split("/")
	return artifact_id === undefined || write_id === undefined || rest.length > 0
		? null
		: { artifact_id, write_id }
}

export const listedMarkers = (
	scope: string,
	objects: ReadonlyArray<{ readonly key: string; readonly uploaded: Date }>,
	now: number,
) =>
	objects.flatMap((object) => {
		const parsed = parseArtifactMarkerKey(scope, object.key)
		return parsed === null
			? []
			: [{ ...parsed, key: object.key, age: now - object.uploaded.getTime() }]
	})

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
