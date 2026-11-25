import { ArtifactBytes } from "@checkfu/domain/Artifact/ArtifactBytes.external"
import * as Effect from "effect/Effect"
import { ArtifactStore } from "./ArtifactStore.ts"

export const ArtifactBytesLive = ArtifactBytes.toLayer(
	Effect.map(ArtifactStore, (store) => ({
		purge: ({ artifact_id }) => Effect.orDie(store.purge(artifact_id)),
		release: ({ artifact_id, reservation }) =>
			Effect.orDie(store.release(artifact_id, reservation)),
	})),
)
