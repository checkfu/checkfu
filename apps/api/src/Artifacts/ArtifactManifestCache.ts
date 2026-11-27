import * as Cache from "effect/Cache"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type { ArtifactReaderService } from "./ArtifactStore.ts"

const MAX_CACHED_MANIFESTS = 8

class ManifestKey extends Data.Class<{ readonly artifactId: string; readonly hash: string }> {}

export const cacheArtifactManifests = (store: ArtifactReaderService) =>
	Effect.gen(function* () {
		const manifests = yield* Cache.makeWith(
			({ artifactId, hash }: ManifestKey) => store.getManifest(artifactId, hash),
			{
				capacity: MAX_CACHED_MANIFESTS,
				timeToLive: (exit) =>
					Exit.isSuccess(exit) && exit.value !== null ? Duration.infinity : Duration.zero,
			},
		)
		return {
			...store,
			getManifest: (artifactId: string, hash: string) =>
				Cache.get(manifests, new ManifestKey({ artifactId, hash })),
		}
	})
