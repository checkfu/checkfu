import type { Read } from "@alchemy.run/domain/Decision"
import * as Boolean from "effect/Boolean"
import type { Artifact } from "../Artifact/Artifact.aggregate.ts"
import { ArtifactId } from "../Artifact/Artifact.id.ts"
import { ArtifactNotFound } from "../Artifact/ArtifactNotFound.rejection.ts"
import { ArtifactVersionNotFound } from "../Artifact/PublishArtifact.command.ts"
import type { File } from "../File/File.aggregate.ts"
import { FileId } from "../File/File.id.ts"
import { FileNotFound } from "../File/FileNotFound.rejection.ts"
import { filesOf } from "./SessionResource.ts"
import type { SessionResources } from "./SessionResource.ts"

export const artifactMounts = (resources: SessionResources) =>
	resources.filter((r) => r.type === "artifact" || r.type === "skill")

export const mountedKeys = (resources: SessionResources) => ({
	files: filesOf(resources).map((mount) => FileId.make(mount.file_id)),
	artifacts: artifactMounts(resources).map((mount) => ArtifactId.make(mount.artifact_id)),
})

export const mountedRefusal = (
	resources: SessionResources,
	files: ReadonlyArray<Read<typeof File>>,
	artifacts: ReadonlyArray<Read<typeof Artifact>>,
) => {
	const invalidFile = filesOf(resources).find(
		(mount) =>
			!files.some((file) =>
				Boolean.every([
					file.id === mount.file_id,
					file.state.status === "ready",
					file.state.sha256 === mount.sha256,
					file.state.size === mount.size,
				]),
			),
	)
	if (invalidFile !== undefined) {
		return new FileNotFound({ file_id: FileId.make(invalidFile.file_id) })
	}
	const mounts = artifactMounts(resources)
	const invalidArtifact = mounts.find(
		(mount) =>
			!artifacts.some((artifact) =>
				Boolean.every([artifact.id === mount.artifact_id, artifact.state.status === "active"]),
			),
	)
	if (invalidArtifact !== undefined) {
		return new ArtifactNotFound({ artifact_id: ArtifactId.make(invalidArtifact.artifact_id) })
	}
	const invalidVersion = mounts.find(
		(mount) =>
			!artifacts.some((artifact) =>
				Boolean.every([artifact.id === mount.artifact_id, mount.version <= artifact.state.version]),
			),
	)
	if (invalidVersion !== undefined) {
		return new ArtifactVersionNotFound({
			artifact_id: ArtifactId.make(invalidVersion.artifact_id),
			version: invalidVersion.version,
		})
	}
}
