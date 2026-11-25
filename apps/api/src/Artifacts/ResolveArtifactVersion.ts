import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import type { ArtifactState } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import {
	ArtifactVersionView,
	artifactVersionLookupKey,
} from "@checkfu/domain/Artifact/ArtifactVersionView.view"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ArtifactVersionNotReady } from "../Api.ts"
import { ArtifactReadWaitTimeout } from "../Http/ArtifactsHandlers.ts"

const has = (state: ArtifactState, version: number) =>
	state.status === "active" && version <= state.version

export const ArtifactManifestAt = Effect.gen(function* () {
	const artifacts = yield* Artifact
	const versionViews = yield* ArtifactVersionView
	return (
		id: ArtifactId,
		state: ArtifactState,
		version: number,
	): Effect.Effect<string | null, ArtifactVersionNotReady> =>
		Effect.gen(function* () {
			if (!has(state, version)) {
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
			return has(yield* Effect.orDie(artifacts.get(id)), version)
				? yield* new ArtifactVersionNotReady({ artifactId: id, version })
				: null
		})
})

export const ArtifactVersionResolver = Effect.gen(function* () {
	const artifacts = yield* Artifact
	const manifestAt = yield* ArtifactManifestAt
	return (
		artifactId: string,
		version: number,
	): Effect.Effect<string | null, ArtifactVersionNotReady> =>
		Effect.gen(function* () {
			if (artifactId === "" || !Number.isSafeInteger(version) || version < 1) {
				return null
			}
			const id = ArtifactId.make(artifactId)
			return yield* manifestAt(id, yield* Effect.orDie(artifacts.get(id)), version)
		})
})
