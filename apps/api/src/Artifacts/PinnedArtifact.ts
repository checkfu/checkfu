import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import * as Cache from "effect/Cache"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { ArtifactStore } from "./ArtifactStore.ts"
import type { ByteRange } from "./ArtifactStore.ts"

export class ArtifactBytesMissing extends Schema.TaggedError<
	ArtifactBytesMissing,
	{ readonly brand: unique symbol }
>()("ArtifactBytesMissing", { artifact_id: Schema.String, missing: Schema.String }) {}

const missing = (artifactId: string, what: string) =>
	Effect.andThen(
		Effect.logError("Artifact bytes are missing", { artifact_id: artifactId, missing: what }),
		Effect.fail(new ArtifactBytesMissing({ artifact_id: artifactId, missing: what })),
	)

const MANIFESTS_KEPT = 64

export const PinnedArtifact = Effect.gen(function* () {
	const artifacts = yield* Artifact
	const store = yield* ArtifactStore

	const manifests = yield* Cache.makeWith(
		(key: string) =>
			store.getManifest(key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)),
		{
			capacity: MANIFESTS_KEPT,
			timeToLive: (exit) =>
				Exit.isSuccess(exit) && exit.value !== null ? Duration.infinity : Duration.zero,
		},
	)

	const active = (artifactId: string) =>
		Effect.map(artifacts.get(ArtifactId.make(artifactId)), ({ status }) => status === "active")

	return {
		manifest: Effect.fn(function* (artifactId: string, manifest: string) {
			const found = yield* Cache.get(manifests, `${artifactId}/${manifest}`)
			if (!(yield* active(artifactId))) {
				return null
			}
			return found ?? (yield* missing(artifactId, `manifest ${manifest}`))
		}),
		blob: Effect.fn(function* (artifactId: string, sha256: string, range?: ByteRange) {
			const found = yield* store.getBlob(artifactId, sha256, range)
			if (found !== null) {
				return found
			}
			return (yield* active(artifactId)) ? yield* missing(artifactId, `blob ${sha256}`) : null
		}),
	}
})
