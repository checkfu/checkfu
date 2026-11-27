import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import type { ArtifactState } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import type { ArtifactVersionNotReady, ResolvedPublication } from "../Api.ts"
import { parsePublicationAddress } from "../Content/ArtifactLink.ts"
import { ArtifactManifestAt } from "./ResolveArtifactVersion.ts"

const utf8 = new TextEncoder()

export interface PublishedArtifact {
	readonly id: ArtifactId
	readonly state: ArtifactState
	readonly version: number
}

export const PublishedAt = Effect.gen(function* () {
	const artifacts = yield* Artifact
	return (address: string): Effect.Effect<PublishedArtifact | null> =>
		Effect.gen(function* () {
			const parsed = parsePublicationAddress(address)
			if (parsed === null) {
				return null
			}
			const id = ArtifactId.make(parsed.artifactId)
			const state = yield* Effect.orDie(artifacts.get(id))
			const held = utf8.encode(state.publication_token)
			if (state.publication_token === "" || !Mac.timingSafeEqual(held, utf8.encode(parsed.token))) {
				return null
			}
			return {
				id,
				state,
				version: state.pinned_version === 0 ? state.version : state.pinned_version,
			}
		})
})

export const PublicationResolver = Effect.gen(function* () {
	const publishedAt = yield* PublishedAt
	const manifestAt = yield* ArtifactManifestAt
	return (address: string): Effect.Effect<ResolvedPublication | null, ArtifactVersionNotReady> =>
		Effect.gen(function* () {
			const found = yield* publishedAt(address)
			if (found === null) {
				return null
			}
			const manifest = yield* manifestAt(found.id, found.state, found.version)
			return manifest === null ? null : { artifact_id: found.id, manifest }
		})
})
