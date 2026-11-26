import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { MAX_ARTIFACT_NAME_LENGTH } from "@checkfu/domain/Artifact/ArtifactTypes"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"

const utf8Encoder = new TextEncoder()

export const outputsArtifactId = (
	digest: Digest.Digest["Service"],
	sessionId: string,
): Effect.Effect<ArtifactId> =>
	Effect.map(
		digest.digestHex(
			Digest.sha256,
			utf8Encoder.encode(JSON.stringify(["session", "outputs", sessionId])),
		),
		(hash) => ArtifactId.make(`art_${hash.slice(0, 32)}`),
	)

export const outputsArtifactName = (sessionId: string, title: string | null): string =>
	Array.from(title === null || title.trim().length === 0 ? `Session ${sessionId} outputs` : title)
		.slice(0, MAX_ARTIFACT_NAME_LENGTH)
		.join("")
