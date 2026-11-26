import * as Schema from "effect/Schema"

export const ArtifactFileInfo = Schema.Struct({
	path: Schema.String,
	size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ArtifactFileInfo = typeof ArtifactFileInfo.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Session = Schema.String
const MountPath = Schema.String
const Path = Schema.String

export const SessionArtifactCalls = {
	artifactMounts: { args: Schema.Tuple([Session]), result: Schema.Array(MountPath) },
	artifactFiles: {
		args: Schema.Tuple([Session, MountPath]),
		result: Schema.Array(ArtifactFileInfo),
	},
	artifactRead: {
		args: Schema.Tuple([Session, MountPath, Path, Count, Count]),
		result: Schema.NullOr(Schema.Uint8Array),
	},
}

export interface SessionArtifacts {
	readonly mounts: () => Promise<ReadonlyArray<string>>
	readonly files: (mountPath: string) => Promise<ReadonlyArray<ArtifactFileInfo>>
	readonly read: (
		mountPath: string,
		path: string,
		offset: number,
		length: number,
	) => Promise<Uint8Array | null>
}
