import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { Artifact } from "./Artifact.aggregate.ts"
import { ArtifactId } from "./Artifact.id.ts"
import { CapabilitiesText } from "./ArtifactCapabilities.ts"
import { ManifestHash, NonNegativeInt, PositiveInt } from "./ArtifactTypes.ts"

export const ArtifactVersionLookupId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("ArtifactVersionLookupId"),
)
export type ArtifactVersionLookupId = typeof ArtifactVersionLookupId.Type

export const artifactVersionLookupKey = (
	artifactId: string,
	version: number,
): ArtifactVersionLookupId => ArtifactVersionLookupId.make(`${artifactId}@${version}`)

export const ArtifactVersionSnapshot = Schema.Struct({
	artifact_id: ArtifactId,
	type: Schema.Literal("artifact_version"),
	version: PositiveInt,
	manifest: ManifestHash,
	file_count: PositiveInt,
	total_bytes: NonNegativeInt,
	capabilities: CapabilitiesText,
	created_at: Schema.DateTimeUtc,
})
export type ArtifactVersionSnapshot = typeof ArtifactVersionSnapshot.Type

export class ArtifactVersionView extends Domain.View("ArtifactVersionView", {
	version: 2,
	from: [Artifact],
	key: ArtifactVersionLookupId,
	keyOf: {
		"artifact.created": ({ event, source }) => artifactVersionLookupKey(source.id, event.version),
		"artifact.version_added": ({ event, source }) =>
			artifactVersionLookupKey(source.id, event.version),
	},
	state: Schema.NullOr(ArtifactVersionSnapshot),
	initial: null,
	evolve: {
		"artifact.created": (state, e, ctx) =>
			state !== null
				? state
				: {
						artifact_id: ctx.source.id,
						type: "artifact_version" as const,
						version: e.version,
						manifest: e.manifest,
						file_count: e.file_count,
						total_bytes: e.total_bytes,
						capabilities: e.capabilities,
						created_at: ctx.at,
					},
		"artifact.version_added": (state, e, ctx) =>
			state !== null
				? state
				: {
						artifact_id: ctx.source.id,
						type: "artifact_version" as const,
						version: e.version,
						manifest: e.manifest,
						file_count: e.file_count,
						total_bytes: e.total_bytes,
						capabilities: e.capabilities,
						created_at: ctx.at,
					},
	},
}) {}
