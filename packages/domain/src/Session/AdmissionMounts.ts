import type { Read } from "@alchemy.run/domain/Decision"
import * as Boolean from "effect/Boolean"
import type { Artifact } from "../Artifact/Artifact.aggregate.ts"
import { ArtifactId } from "../Artifact/Artifact.id.ts"
import { ArtifactNotFound } from "../Artifact/ArtifactNotFound.rejection.ts"
import { ArtifactVersionNotFound } from "../Artifact/PublishArtifact.command.ts"
import type { File } from "../File/File.aggregate.ts"
import { FileId } from "../File/File.id.ts"
import { FileNotFound } from "../File/FileNotFound.rejection.ts"
import type { MemoryStore } from "../Memory/MemoryStore.aggregate.ts"
import { MemoryStoreId } from "../Memory/MemoryStore.id.ts"
import { MemoryStoreArchivedError } from "../Memory/MemoryStoreArchived.rejection.ts"
import { MemoryStoreNotFound } from "../Memory/MemoryStoreNotFound.rejection.ts"
import { filesOf, memoryStoresOf } from "./SessionResource.ts"
import type { SessionResources } from "./SessionResource.ts"

export const artifactMounts = (resources: SessionResources) =>
	resources.filter((r) => r.type === "artifact" || r.type === "skill")

export const mountedKeys = (resources: SessionResources) => ({
	files: filesOf(resources).map((mount) => FileId.make(mount.file_id)),
	artifacts: artifactMounts(resources).map((mount) => ArtifactId.make(mount.artifact_id)),
	memoryStores: memoryStoresOf(resources).map((mount) => MemoryStoreId.make(mount.memory_store_id)),
})

export const mountedRefusal = (
	resources: SessionResources,
	files: ReadonlyArray<Read<typeof File>>,
	artifacts: ReadonlyArray<Read<typeof Artifact>>,
	memoryStores: ReadonlyArray<Read<typeof MemoryStore>>,
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
	for (const mount of memoryStoresOf(resources)) {
		const memory_store_id = MemoryStoreId.make(mount.memory_store_id)
		const status = memoryStores.find((store) => store.id === memory_store_id)?.state.status
		if (status === "archived") {
			return new MemoryStoreArchivedError({ memory_store_id })
		}
		if (status !== "active") {
			return new MemoryStoreNotFound({ memory_store_id })
		}
	}
}
