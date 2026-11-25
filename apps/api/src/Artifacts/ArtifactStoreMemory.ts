import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { DEFAULT_STORAGE_SCOPE } from "../Placement.ts"
import { ArtifactManifestJson } from "./ArtifactFiles.ts"
import { UNMARKED, makeArtifactOwner } from "./ArtifactOwnership.ts"
import type { ArtifactBucketWriter, ArtifactMarks, ArtifactOwner } from "./ArtifactOwnership.ts"
import {
	ArtifactStore,
	ArtifactStoreError,
	artifactBlobKey,
	artifactManifestKey,
	artifactPrefix,
} from "./ArtifactStore.ts"

const decodeManifest = Schema.decodeUnknownSync(ArtifactManifestJson)

const LIST_PAGE_SIZE = 1000

const offline = (cause: string) => new ArtifactStoreError({ cause: new Error(cause) })

export const makeArtifactStoreMemory = (options?: { readonly scope?: string }) => {
	const objects = new Map<string, Uint8Array>()
	const puts = new Map<string, number>()
	const owners = new Map<string, ArtifactOwner<never>>()
	const marks = new Map<string, ArtifactMarks>()
	const encoder = new TextEncoder()
	const decoder = new TextDecoder()
	let failing = false
	let failManifest = false
	let beforePut: Effect.Effect<void> = Effect.void
	let beforeGet: Effect.Effect<void> = Effect.void
	let beforeDelete: Effect.Effect<void> = Effect.void
	let afterStage: Effect.Effect<void> = Effect.void
	let blobReads = 0
	let blobChecks = 0

	const online = Effect.suspend(() =>
		failing ? Effect.fail(offline("store offline")) : Effect.void,
	)

	const bucket: ArtifactBucketWriter<never> = {
		put: (key, body, options) =>
			Effect.gen(function* () {
				yield* online
				if (failManifest && key.includes("/manifests/")) {
					return yield* offline("manifest write failed")
				}
				const bytes = typeof body === "string" ? encoder.encode(body) : body
				if (options?.sha256 !== undefined) {
					const digest = yield* Digest.Digest
					if ((yield* digest.digestHex(Digest.sha256, bytes)) !== options.sha256) {
						return yield* offline(`${key} does not match its sha256`)
					}
				}
				objects.set(key, bytes)
				puts.set(key, (puts.get(key) ?? 0) + 1)
			}).pipe(Effect.provide(Digest.layerWebCrypto)),
		has: (key) =>
			Effect.andThen(
				online,
				Effect.sync(() => objects.has(key)),
			),
		delete: (keys) =>
			Effect.suspend(() => beforeDelete).pipe(
				Effect.andThen(online),
				Effect.andThen(
					Effect.sync(() => {
						for (const key of keys) {
							objects.delete(key)
						}
					}),
				),
			),
		list: (prefix) =>
			Effect.andThen(
				online,
				Effect.sync(() =>
					[...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, LIST_PAGE_SIZE),
				),
			),
	}

	const ownerOf = (scope: string, artifactId: string) => {
		const owned = artifactPrefix(scope, artifactId)
		const existing = owners.get(owned)
		if (existing !== undefined) {
			return existing
		}
		const owner = makeArtifactOwner({
			scope,
			bucket,
			marks: Effect.sync(() => marks.get(owned) ?? UNMARKED),
			saveMarks: (next) =>
				Effect.andThen(
					online,
					Effect.sync(() => {
						marks.set(owned, next)
					}),
				),
		})
		owners.set(owned, owner)
		return owner
	}

	const read = <A>(run: () => A) =>
		Effect.andThen(
			online,
			Effect.try({ try: run, catch: (cause) => new ArtifactStoreError({ cause }) }),
		)

	const layerIn = (scope: string) =>
		Layer.succeed(ArtifactStore, {
			stage: (artifactId, version, reservation) =>
				Effect.suspend(() => beforePut).pipe(
					Effect.andThen(ownerOf(scope, artifactId).stage(artifactId, version, reservation)),
					Effect.andThen(Effect.suspend(() => afterStage)),
				),
			getManifest: (artifactId, manifestHash) =>
				Effect.andThen(
					Effect.suspend(() => beforeGet),
					read(() => {
						const bytes = objects.get(artifactManifestKey(scope, artifactId, manifestHash))
						return bytes === undefined ? null : decodeManifest(decoder.decode(bytes))
					}),
				),
			getBlob: (artifactId, sha256, range) =>
				read(() => {
					blobReads += 1
					const bytes = objects.get(artifactBlobKey(scope, artifactId, sha256))
					return bytes === undefined
						? null
						: range === undefined
							? bytes
							: bytes.slice(range.offset, range.offset + range.length)
				}),
			hasBlob: (artifactId, sha256) =>
				read(() => {
					blobChecks += 1
					return objects.has(artifactBlobKey(scope, artifactId, sha256))
				}),
			purge: (artifactId) => ownerOf(scope, artifactId).purge(artifactId),
			release: (artifactId, reservation) =>
				ownerOf(scope, artifactId).release(artifactId, reservation),
		})

	return {
		layer: layerIn(options?.scope ?? DEFAULT_STORAGE_SCOPE),
		layerIn,
		objects,
		marks,
		upload: (key: string, body: string) => {
			objects.set(key, encoder.encode(body))
		},
		putCount: (key: string) => puts.get(key) ?? 0,
		blobReads: () => blobReads,
		blobChecks: () => blobChecks,
		setFailing: (value: boolean) => {
			failing = value
		},
		setFailManifest: (value: boolean) => {
			failManifest = value
		},
		setBeforePut: (effect: Effect.Effect<void>) => {
			beforePut = effect
		},
		setBeforeGet: (effect: Effect.Effect<void>) => {
			beforeGet = effect
		},
		setBeforeDelete: (effect: Effect.Effect<void>) => {
			beforeDelete = effect
		},
		setAfterStage: (effect: Effect.Effect<void>) => {
			afterStage = effect
		},
	}
}
