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

export interface VersionAt {
	readonly manifest: string
	readonly capabilities: string
}

export const ArtifactVersionAt = Effect.gen(function* () {
	const artifacts = yield* Artifact
	const versionViews = yield* ArtifactVersionView
	return (
		id: ArtifactId,
		state: ArtifactState,
		version: number,
	): Effect.Effect<VersionAt | null, ArtifactVersionNotReady> =>
		Effect.gen(function* () {
			if (!has(state, version)) {
				return null
			}
			if (version === state.version) {
				return { manifest: state.manifest, capabilities: state.capabilities }
			}
			const key = artifactVersionLookupKey(id, version)
			const row =
				Option.getOrNull(yield* Effect.orDie(versionViews.get(key))) ??
				(yield* versionViews
					.waitFor(key, { version: { gte: 1 } }, { timeout: yield* ArtifactReadWaitTimeout })
					.pipe(Effect.catchTag("WaitTimeout", () => Effect.succeed(null))))
			if (row !== null) {
				return { manifest: row.manifest, capabilities: row.capabilities }
			}
			return has(yield* Effect.orDie(artifacts.get(id)), version)
				? yield* new ArtifactVersionNotReady({ artifactId: id, version })
				: null
		})
})

export const ArtifactManifestAt = Effect.map(
	ArtifactVersionAt,
	(versionAt) => (id: ArtifactId, state: ArtifactState, version: number) =>
		Effect.map(versionAt(id, state, version), (found) => found?.manifest ?? null),
)

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
