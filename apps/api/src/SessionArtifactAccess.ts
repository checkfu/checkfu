import { File } from "@checkfu/domain/File/File.aggregate"
import { FileId } from "@checkfu/domain/File/File.id"
import {
	FILE_MOUNT_ROOT,
	artifactsOf,
	filesOf,
	skillsOf,
} from "@checkfu/domain/Session/SessionResource"
import type { ArtifactMount, FileMount } from "@checkfu/domain/Session/SessionResource"
import * as Effect from "effect/Effect"
import { PinnedArtifact } from "./Artifacts/PinnedArtifact.ts"
import { FileStore } from "./Files/FileStore.ts"
import { SessionResources } from "./SessionResources.ts"
import type { ArtifactFileInfo } from "./Workspace/SessionArtifacts.ts"

type Pinned = Pick<ArtifactMount, "artifact_id" | "manifest" | "mount_path">

const uploadPath = (file: FileMount) => file.mount_path.slice(FILE_MOUNT_ROOT.length + 1)

const inSubtree = (entry: string, path: string | null) =>
	path === null || entry === path || entry.startsWith(`${path}/`)

export const SessionArtifactAccess = Effect.gen(function* () {
	const pinned = yield* PinnedArtifact
	const files = yield* File
	const fileStore = yield* FileStore
	const resourcesOf = yield* SessionResources

	const pinnedBy = (sessionId: string) =>
		Effect.map(
			resourcesOf(sessionId),
			(resources) =>
				new Map<string, Pinned>(
					[...artifactsOf(resources), ...skillsOf(resources)].map((pin) => [pin.mount_path, pin]),
				),
		)

	const uploadsOf = (sessionId: string) => Effect.map(resourcesOf(sessionId), filesOf)

	const filesOfPin = (pin: Pinned) =>
		Effect.map(pinned.manifest(pin.artifact_id, pin.manifest), (manifest) => manifest?.files ?? [])

	const readUpload = (file: FileMount, offset: number, length: number) =>
		Effect.gen(function* () {
			if ((yield* files.get(FileId.make(file.file_id))).status !== "ready") {
				return null
			}
			const available = Math.min(length, file.size - offset)
			return available <= 0
				? new Uint8Array()
				: yield* fileStore.read(file.file_id, { offset, length: available })
		})

	return {
		artifactMounts: (sessionId: string) =>
			Effect.map(resourcesOf(sessionId), (resources) => {
				const mounts = [...artifactsOf(resources), ...skillsOf(resources)].map(
					(pin) => pin.mount_path,
				)
				return filesOf(resources).length === 0 ? mounts : [...mounts, FILE_MOUNT_ROOT]
			}),
		artifactFiles: (sessionId: string, mountPath: string, path: string | null) =>
			Effect.gen(function* () {
				if (mountPath === FILE_MOUNT_ROOT) {
					const uploads = (yield* uploadsOf(sessionId)).filter((file) =>
						inSubtree(uploadPath(file), path),
					)
					const ready = yield* Effect.filter(
						uploads,
						(file) =>
							Effect.map(files.get(FileId.make(file.file_id)), ({ status }) => status === "ready"),
						{ concurrency: 8 },
					)
					return ready.map((file): ArtifactFileInfo => ({
						path: uploadPath(file),
						size: file.size,
					}))
				}
				const pin = (yield* pinnedBy(sessionId)).get(mountPath)
				return pin === undefined
					? []
					: (yield* filesOfPin(pin))
							.filter((file) => inSubtree(file.path, path))
							.map(({ path, size }): ArtifactFileInfo => ({ path, size }))
			}),
		artifactRead: (
			sessionId: string,
			mountPath: string,
			path: string,
			offset: number,
			length: number,
		) =>
			Effect.gen(function* () {
				if (mountPath === FILE_MOUNT_ROOT) {
					const file = (yield* uploadsOf(sessionId)).find((entry) => uploadPath(entry) === path)
					return file === undefined ? null : yield* readUpload(file, offset, length)
				}
				const pin = (yield* pinnedBy(sessionId)).get(mountPath)
				if (pin === undefined) {
					return null
				}
				const file = (yield* filesOfPin(pin)).find((entry) => entry.path === path)
				if (file === undefined) {
					return null
				}
				const available = Math.min(length, file.size - offset)
				return available <= 0
					? new Uint8Array()
					: yield* pinned.blob(pin.artifact_id, file.sha256, { offset, length: available })
			}),
	}
})
