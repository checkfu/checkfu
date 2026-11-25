import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import * as Effect from "effect/Effect"
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

export const PinnedArtifact = Effect.gen(function* () {
	const artifacts = yield* Artifact
	const store = yield* ArtifactStore

	const active = (artifactId: string) =>
		Effect.map(artifacts.get(ArtifactId.make(artifactId)), ({ status }) => status === "active")

	return {
		manifest: Effect.fn(function* (artifactId: string, manifest: string) {
			const found = yield* store.getManifest(artifactId, manifest)
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
