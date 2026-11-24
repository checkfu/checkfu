import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import {
	ArtifactVersionView,
	artifactVersionLookupKey,
} from "@checkfu/domain/Artifact/ArtifactVersionView.view"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ArtifactVersionNotReady } from "../Api.ts"
import { ArtifactReadWaitTimeout } from "../Http/ArtifactsHandlers.ts"

export const ArtifactVersionResolver = Effect.gen(function* () {
	const artifacts = yield* Artifact
	const versionViews = yield* ArtifactVersionView
	return (
		artifactId: string,
		version: number,
	): Effect.Effect<string | null, ArtifactVersionNotReady> =>
		Effect.gen(function* () {
			if (artifactId === "" || !Number.isSafeInteger(version) || version < 1) {
				return null
			}
			const id = ArtifactId.make(artifactId)
			const head = Effect.map(Effect.orDie(artifacts.get(id)), (state) =>
				state.status === "active" && version <= state.version ? state : null,
			)
			const state = yield* head
			if (state === null) {
				return null
			}
			if (version === state.version) {
				return state.manifest
			}
			const key = artifactVersionLookupKey(id, version)
			const row =
				Option.getOrNull(yield* Effect.orDie(versionViews.get(key))) ??
				(yield* versionViews
					.waitFor(key, { version: { gte: 1 } }, { timeout: yield* ArtifactReadWaitTimeout })
					.pipe(Effect.catchTag("WaitTimeout", () => Effect.succeed(null))))
			if (row !== null) {
				return row.manifest
			}
			return (yield* head) === null
				? null
				: yield* new ArtifactVersionNotReady({ artifactId, version })
		})
})
