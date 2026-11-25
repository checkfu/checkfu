import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import type { ArtifactVersionNotReady, ResolvedPublication } from "../Api.ts"
import { parsePublicationAddress } from "../Content/ArtifactLink.ts"
import { ArtifactManifestAt } from "./ResolveArtifactVersion.ts"

const utf8 = new TextEncoder()

// One read of the artifact the address names: it serves while the artifact is active and holds the
// address's token, so a token cleared by unpublishing never serves again.
export const PublicationResolver = Effect.gen(function* () {
	const artifacts = yield* Artifact
	const manifestAt = yield* ArtifactManifestAt
	return (address: string): Effect.Effect<ResolvedPublication | null, ArtifactVersionNotReady> =>
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
			const version = state.pinned_version === 0 ? state.version : state.pinned_version
			const manifest = yield* manifestAt(id, state, version)
			return manifest === null ? null : { artifact_id: id, manifest }
		})
})
