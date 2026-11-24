import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { Artifact } from "./Artifact.aggregate.ts"
import { ArtifactId } from "./Artifact.id.ts"
import { ManifestHash, NonEmptyString, NonNegativeInt, PositiveInt } from "./ArtifactTypes.ts"

export const ArtifactSnapshot = Schema.Struct({
	id: ArtifactId,
	type: Schema.Literal("artifact"),
	name: NonEmptyString,
	version: PositiveInt,
	manifest: ManifestHash,
	file_count: PositiveInt,
	total_bytes: NonNegativeInt,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
})
export type ArtifactSnapshot = typeof ArtifactSnapshot.Type

export class ArtifactView extends Domain.View("ArtifactView", {
	from: [Artifact],
	key: Artifact,
	state: Schema.NullOr(ArtifactSnapshot),
	initial: null,
	evolve: {
		"artifact.created": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.key.id,
						type: "artifact" as const,
						name: e.name,
						version: e.version,
						manifest: e.manifest,
						file_count: e.file_count,
						total_bytes: e.total_bytes,
						created_at: ctx.at,
						updated_at: ctx.at,
					},
		"artifact.version_added": (state, e, ctx) =>
			state === null
				? null
				: {
						...state,
						version: e.version,
						manifest: e.manifest,
						file_count: e.file_count,
						total_bytes: e.total_bytes,
						updated_at: ctx.at,
					},
		"artifact.deleted": () => null,
	},
}) {}
