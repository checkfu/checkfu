import { ArtifactBytes } from "@checkfu/domain/Artifact/ArtifactBytes.external"
import * as Effect from "effect/Effect"
import { ArtifactDatabase } from "../ArtifactData/ArtifactDatabase.ts"
import { ArtifactStore } from "./ArtifactStore.ts"

export const ArtifactBytesLive = ArtifactBytes.toLayer(
	Effect.gen(function* () {
		const store = yield* ArtifactStore
		const database = yield* ArtifactDatabase
		return {
			purge: ({ artifact_id }) =>
				Effect.orDie(Effect.andThen(database.erase(artifact_id), store.purge(artifact_id))),
			release: ({ artifact_id, reservation }) =>
				Effect.orDie(store.release(artifact_id, reservation)),
		}
	}),
)
