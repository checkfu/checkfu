import * as Domain from "@alchemy.run/domain"
import { RequestFingerprint } from "../Session/ClaimIdempotencyKey.command.ts"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"

export class ArtifactIdempotencyKeyClaimed extends Domain.Event(
	"artifact.idempotency_key_claimed",
	{ fingerprint: RequestFingerprint },
) {}

export class ClaimArtifactIdempotencyKey extends Domain.Command("ClaimArtifactIdempotencyKey", {
	input: {
		artifact_id: ArtifactId,
		fingerprint: RequestFingerprint,
	},
	events: [ArtifactIdempotencyKeyClaimed],
	rejects: [ArtifactNotFound],
}) {}
