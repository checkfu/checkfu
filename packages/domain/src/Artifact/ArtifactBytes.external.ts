import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactWriteId } from "./ArtifactTypes.ts"

export class ArtifactBytes extends Domain.ExternalSystem("ArtifactBytes", {
	purge: { args: { artifact_id: ArtifactId } },
	release: { args: { artifact_id: ArtifactId, write_id: ArtifactWriteId } },
}) {}

export const ArtifactBytesKept = ArtifactBytes.toLayer(
	Effect.succeed({ purge: () => Effect.void, release: () => Effect.void }),
)
