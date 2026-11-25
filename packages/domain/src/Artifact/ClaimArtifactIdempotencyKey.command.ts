import * as Domain from "@alchemy.run/domain"
import { RequestFingerprint } from "../Session/ClaimIdempotencyKey.command.ts"
import { ArtifactId } from "./Artifact.id.ts"
import { ArtifactNotFound } from "./ArtifactNotFound.rejection.ts"

export class ArtifactIdempotencyKeyClaimed extends Domain.Event(
	"artifact.idempotency_key_claimed",
	{ fingerprint: RequestFingerprint },
) {}

// Sent under a command id derived from (artifact, key): a retry gets the first fingerprint back.
export class ClaimArtifactIdempotencyKey extends Domain.Command("ClaimArtifactIdempotencyKey", {
	input: {
		artifact_id: ArtifactId,
		fingerprint: RequestFingerprint,
	},
	events: [ArtifactIdempotencyKeyClaimed],
	rejects: [ArtifactNotFound],
}) {}
