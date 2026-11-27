import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { SessionSnapshot, SessionView } from "@checkfu/domain/Session/SessionView.view"
import { MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_FILES } from "@checkfu/sdk/Limits"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { ArtifactManifest } from "../../src/Artifacts/ArtifactFiles.ts"
import { ArtifactStore } from "../../src/Artifacts/ArtifactStore.ts"
import { SessionArtifactAccess } from "../../src/SessionArtifactAccess.ts"
import { makeArtifactMount } from "../../src/Workspace/ArtifactMount.ts"
import type { ArtifactReaderService } from "../../src/Artifacts/ArtifactStore.ts"

export const mountReadChunkBytes = 256 * 1024
const smallFileBytes = 32 * 1024
export const mountFixtureArtifactId = ArtifactId.make("art_mount_measurement")
const mountPath = "/mnt/artifacts/fixture"
const filePath = "z-data.bin"
export const mountFixturePinHash = "a".repeat(64)
export const mountFixtureBlobHash = "b".repeat(64)
const headHash = "c".repeat(64)
const pattern = Uint8Array.from({ length: mountReadChunkBytes + 251 }, (_, index) => index % 251)

type ReadMode =
	| "full"
	| "random"
	| "edge"
	| "eof"
	| "cancel"
	| "revoke"
	| "cancelInFlight"
	| "revokeInFlight"

export const mountFixtureBytes = (offset: number, length: number) => {
	const start = offset % 251
	return pattern.slice(start, start + length)
}

export const mountFixtureManifest = (size: number, manifestFiles: number): ArtifactManifest => ({
	files: [
		...Array.from({ length: manifestFiles - 1 }, (_, index) => ({
			path: `a-metadata-${index}.bin`,
			sha256: "d".repeat(64),
			size: 1,
			content_type: "application/octet-stream",
		})),
		{
			path: filePath,
			size,
			sha256: mountFixtureBlobHash,
			content_type: "application/octet-stream",
		},
	],
})

type Reader = Pick<ArtifactReaderService, "getManifest" | "getBlob">

const holdNextRange = () => ({
	started: Promise.withResolvers<void>(),
	release: Promise.withResolvers<void>(),
})

const newReadCounts = () => ({
	mountLists: 0,
	fileLists: 0,
	pinReads: 0,
	artifactStateReads: 0,
	manifestLoads: 0,
	blobReads: 0,
	requestedBytes: 0,
	returnedBytes: 0,
	consumedBytes: 0,
	peakBufferedBytes: 0,
})

export const mountReadFixture = (size: number, manifestFiles: number, backing?: Reader) =>
	Effect.gen(function* () {
		const sessions = yield* SessionView
		const artifacts = yield* Artifact
		const store = yield* ArtifactStore
		const session = yield* Schema.decodeEffect(Schema.toCodecJson(SessionSnapshot))({
			id: "sess_mount_measurement",
			type: "session",
			status: "idle",
			agent_id: "agent_mount_measurement",
			agent_version: 1,
			environment_id: "env_mount_measurement",
			title: null,
			resources: [
				{
					id: "sesrsc_mount_measurement",
					type: "artifact",
					artifact_id: mountFixtureArtifactId,
					version: 1,
					manifest: mountFixturePinHash,
					name: "Fixture",
					mount_path: mountPath,
				},
			],
			turn: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			mcp_server_credentials: [],
			created_at: "2026-11-26T00:00:00.000Z",
			updated_at: "2026-11-26T00:00:00.000Z",
			archived_at: null,
		})
		const current = {
			...(yield* artifacts.get(mountFixtureArtifactId)),
			status: "active",
			version: 2,
			manifest: headHash,
		}
		const manifest = mountFixtureManifest(size, manifestFiles)
		let granted = true
		let counts = newReadCounts()
		let requested: Array<readonly [number, number]> = []
		let nextRange: ReturnType<typeof holdNextRange> | undefined
		let pending: Promise<Uint8Array | null> | undefined
		const access = yield* SessionArtifactAccess.pipe(
			Effect.provideService(SessionView, {
				...sessions,
				get: () =>
					Effect.sync(() => {
						counts.pinReads++
						return Option.some(granted ? session : { ...session, resources: [] })
					}),
			}),
			Effect.provideService(Artifact, {
				...artifacts,
				get: () =>
					Effect.sync(() => {
						counts.artifactStateReads++
						return current
					}),
			}),
			Effect.provideService(ArtifactStore, {
				...store,
				getManifest: (id, key) =>
					Effect.suspend(() => {
						counts.manifestLoads++
						if (id !== mountFixtureArtifactId || key !== mountFixturePinHash) {
							throw new Error("The lookup used a manifest other than the mounted version.")
						}
						return backing?.getManifest(id, key) ?? Effect.succeed(manifest)
					}),
				getBlob: (id, key, range) =>
					Effect.gen(function* () {
						counts.blobReads++
						if (
							id !== mountFixtureArtifactId ||
							key !== mountFixtureBlobHash ||
							range === undefined ||
							range.length > mountReadChunkBytes
						) {
							throw new Error("The blob read did not use a bounded range from the mounted version.")
						}
						const held = range.offset === mountReadChunkBytes ? nextRange : undefined
						if (held !== undefined) {
							held.started.resolve()
							yield* Effect.promise(() => held.release.promise)
						}
						return backing === undefined
							? mountFixtureBytes(range.offset, range.length)
							: yield* backing.getBlob(id, key, range)
					}),
			}),
		)
		const run = Effect.runPromiseWith(yield* Effect.context<never>())
		const mount = makeArtifactMount(
			"/mnt/artifacts",
			{
				mounts: () => {
					counts.mountLists++
					return run(access.artifactMounts(session.id))
				},
				files: (root) => {
					counts.fileLists++
					return run(access.artifactFiles(session.id, root))
				},
				read: (root, path, offset, length) => {
					requested.push([offset, length])
					counts.requestedBytes += length
					const result = run(access.artifactRead(session.id, root, path, offset, length))
					pending = result.then((bytes) => {
						counts.returnedBytes += bytes?.byteLength ?? 0
						counts.peakBufferedBytes = Math.max(
							counts.peakBufferedBytes,
							counts.returnedBytes - counts.consumedBytes,
						)
						return bytes
					})
					return pending
				},
			},
			100_000,
		)
		return {
			read: async (mode: ReadMode) => {
				granted = true
				counts = newReadCounts()
				requested = []
				const held =
					mode === "cancelInFlight" || mode === "revokeInFlight" ? holdNextRange() : undefined
				nextRange = held
				const range =
					mode === "random"
						? { offset: Math.floor(size / 2) + 17, length: 4096 }
						: mode === "edge"
							? { offset: mountReadChunkBytes - 8, length: mountReadChunkBytes + 24 }
							: mode === "eof"
								? { offset: size }
								: undefined
				const openedAt = performance.now()
				const opened = await mount.readFile(
					`fixture/${filePath}`,
					range === undefined ? undefined : { range },
				)
				if (opened === null) {
					throw new Error("The fixture file was not mounted.")
				}
				const reader = opened.body.getReader()
				let firstByteMs: number | null = null
				let offset = opened.offset
				let revoked = false
				try {
					for (;;) {
						const next = await reader.read()
						if (next.done) {
							break
						}
						firstByteMs ??= performance.now() - openedAt
						const length = next.value.byteLength
						if (
							next.value[0] !== offset % 251 ||
							next.value[length - 1] !== (offset + length - 1) % 251
						) {
							throw new Error("The returned chunk did not match its requested offset.")
						}
						counts.consumedBytes += length
						offset += length
						if (held !== undefined && offset === mountReadChunkBytes) {
							await held.started.promise
							if (mode === "cancelInFlight") {
								await reader.cancel()
								if (!(await reader.read()).done) {
									throw new Error("A cancelled reader delivered data from the in-flight range.")
								}
							} else {
								granted = false
							}
							held.release.resolve()
						}
						if (mode === "cancelInFlight") {
							break
						}
						if (mode === "cancel") {
							await reader.cancel()
							break
						}
						if (mode === "revoke") {
							granted = false
						}
					}
				} catch (error) {
					if (
						(mode !== "revoke" && mode !== "revokeInFlight") ||
						!(error instanceof Error) ||
						!("code" in error) ||
						error.code !== "EIO"
					) {
						await reader.cancel().catch(() => undefined)
						throw error
					}
					revoked = true
				} finally {
					held?.release.resolve()
					reader.releaseLock()
				}
				const totalMs = performance.now() - openedAt
				// Cancellation can close the reader while an authorized read is still returning.
				await pending
				pending = undefined
				return { mode, size, manifestFiles, firstByteMs, totalMs, requested, revoked, ...counts }
			},
		}
	})

export const mountReadCases: ReadonlyArray<readonly [ReadMode, number, number]> = [
	["full", smallFileBytes, 1],
	["full", smallFileBytes, MAX_ARTIFACT_FILES],
	["full", MAX_ARTIFACT_FILE_BYTES, 1],
	["full", MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_FILES],
	["random", MAX_ARTIFACT_FILE_BYTES, 1],
	["random", MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_FILES],
	["cancel", MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_FILES],
	["revoke", MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_FILES],
]

export const measureMountReads = (
	[mode, size, files]: (typeof mountReadCases)[number],
	backing?: Reader,
) =>
	Effect.gen(function* () {
		const samples = []
		for (let repetition = 1; repetition <= 5; repetition++) {
			const fixture = yield* mountReadFixture(size, files, backing)
			for (const cache of ["cold", "warm"] as const) {
				const { requested, ...sample } = yield* Effect.promise(() => fixture.read(mode))
				samples.push({
					...sample,
					cache,
					repetition,
					rangeReads: requested.length,
					firstByteMs: sample.firstByteMs === null ? null : Number(sample.firstByteMs.toFixed(3)),
					totalMs: Number(sample.totalMs.toFixed(3)),
				})
			}
		}
		return samples
	})
