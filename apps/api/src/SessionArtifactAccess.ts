import { artifactsOf, skillsOf } from "@checkfu/domain/Session/SessionResource"
import type { ArtifactMount } from "@checkfu/domain/Session/SessionResource"
import * as Effect from "effect/Effect"
import { PinnedArtifact } from "./Artifacts/PinnedArtifact.ts"
import { SessionResources } from "./SessionResources.ts"
import type { ArtifactFileInfo } from "./Workspace/SessionArtifacts.ts"

type Pinned = Pick<ArtifactMount, "artifact_id" | "manifest" | "mount_path">

export const SessionArtifactAccess = Effect.gen(function* () {
	const pinned = yield* PinnedArtifact
	const resourcesOf = yield* SessionResources

	const pinnedBy = (sessionId: string) =>
		Effect.map(
			resourcesOf(sessionId),
			(resources) =>
				new Map<string, Pinned>(
					[...artifactsOf(resources), ...skillsOf(resources)].map((pin) => [pin.mount_path, pin]),
				),
		)

	const filesOf = (pin: Pinned) =>
		Effect.map(pinned.manifest(pin.artifact_id, pin.manifest), (manifest) => manifest?.files ?? [])

	return {
		artifactMounts: (sessionId: string) =>
			Effect.map(pinnedBy(sessionId), (pins) => [...pins.keys()]),
		artifactFiles: (sessionId: string, mountPath: string) =>
			Effect.gen(function* () {
				const pin = (yield* pinnedBy(sessionId)).get(mountPath)
				return pin === undefined
					? []
					: (yield* filesOf(pin)).map(({ path, size }): ArtifactFileInfo => ({ path, size }))
			}),
		artifactRead: (
			sessionId: string,
			mountPath: string,
			path: string,
			offset: number,
			length: number,
		) =>
			Effect.gen(function* () {
				const pin = (yield* pinnedBy(sessionId)).get(mountPath)
				if (pin === undefined) {
					return null
				}
				const file = (yield* filesOf(pin)).find((entry) => entry.path === path)
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
