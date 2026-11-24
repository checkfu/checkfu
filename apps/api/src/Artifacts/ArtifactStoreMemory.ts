import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { DEFAULT_STORAGE_SCOPE } from "../Placement.ts"
import { ArtifactManifestJson } from "./ArtifactFiles.ts"
import type { BuiltArtifactVersion } from "./ArtifactFiles.ts"
import { ARTIFACT_WRITE_GRACE_MS, makeArtifactOwner } from "./ArtifactOwnership.ts"
import type {
	ArtifactBucketWriter,
	ArtifactLedger,
	ArtifactOwner,
	ArtifactWrite,
} from "./ArtifactOwnership.ts"
import {
	ARTIFACT_DELETE_PREFIX,
	ARTIFACT_MARKER_ROOT,
	ArtifactStore,
	ArtifactStoreError,
	ArtifactWriteMarkerJson,
	listedMarkers,
	artifactBlobKey,
	artifactManifestKey,
	artifactMarkerKey,
	artifactMarkerPrefix,
	artifactPrefix,
	artifactReconcileCursorKey,
	committedOrFailed,
} from "./ArtifactStore.ts"
import type { StagedWrite } from "./ArtifactStore.ts"

const decodeManifest = Schema.decodeUnknownSync(ArtifactManifestJson)
const decodeMarker = Schema.decodeUnknownSync(ArtifactWriteMarkerJson)

const LIST_PAGE_SIZE = 1000

const offline = (cause: string) => new ArtifactStoreError({ cause: new Error(cause) })

export const makeMemoryLedger = (): ArtifactLedger => {
	const writes = new Map<string, ArtifactWrite>()
	const keys = new Map<string, boolean>()
	const refs = new Map<string, Map<string, boolean>>()
	const candidates = new Set<string>()
	const retained = new Set<string>()
	return {
		transaction: (run) => run(),
		findWrite: (writeId) => writes.get(writeId),
		saveWrite: (write) => {
			writes.set(write.write_id, write)
		},
		stagedWrites: () => [...writes.values()].filter((write) => write.status === "staged"),
		oldestAbandoned: () => {
			const times = [...writes.values()].flatMap((write) =>
				write.status === "abandoned" ? [write.staged_at] : [],
			)
			return times.length === 0 ? undefined : Math.min(...times)
		},
		dropAbandoned: (stagedBefore) => {
			for (const write of writes.values()) {
				if (write.status === "abandoned" && write.staged_at <= stagedBefore) {
					writes.delete(write.write_id)
				}
			}
		},
		isStored: (key) => keys.get(key) === true,
		saveKey: (key, stored) => {
			keys.set(key, stored)
		},
		hold: (key, writeId) => {
			const holders = refs.get(key) ?? new Map<string, boolean>()
			if (!holders.has(writeId)) {
				holders.set(writeId, false)
			}
			refs.set(key, holders)
			candidates.delete(key)
		},
		commit: (writeId) => {
			for (const holders of refs.values()) {
				if (holders.has(writeId)) {
					holders.set(writeId, true)
				}
			}
		},
		retain: (writeId) => {
			for (const [key, holders] of refs) {
				if (holders.delete(writeId)) {
					retained.add(key)
					if (holders.size === 0) {
						refs.delete(key)
					}
				}
			}
			writes.delete(writeId)
		},
		release: (writeId) => {
			for (const [key, holders] of refs) {
				if (holders.delete(writeId) && holders.size === 0) {
					refs.delete(key)
					if (!retained.has(key)) {
						candidates.add(key)
					}
				}
			}
		},
		hasUnreferenced: () => candidates.size > 0,
		unreferenced: () => [...candidates],
		dropKeys: (dropped) => {
			for (const key of dropped) {
				if (!refs.has(key)) {
					keys.delete(key)
				}
				candidates.delete(key)
			}
		},
		isEmpty: () => [writes, keys, refs, candidates, retained].every((table) => table.size === 0),
		clear: Effect.sync(() => {
			writes.clear()
			keys.clear()
			refs.clear()
			candidates.clear()
			retained.clear()
		}),
	}
}

export const makeArtifactStoreMemory = (options?: {
	readonly grace?: number
	readonly scope?: string
}) => {
	const grace = options?.grace ?? ARTIFACT_WRITE_GRACE_MS
	const objects = new Map<string, Uint8Array>()
	const puts = new Map<string, number>()
	const uploadedAt = new Map<string, number>()
	const alarms = new Map<string, number>()
	const owners = new Map<string, ArtifactOwner<never>>()
	const ledgers = new Map<string, ArtifactLedger>()
	const encoder = new TextEncoder()
	const decoder = new TextDecoder()
	let failing = false
	let failManifest = false
	let beforePut: Effect.Effect<void> = Effect.void
	let beforeGet: Effect.Effect<void> = Effect.void
	let beforeDelete: Effect.Effect<void> = Effect.void
	let afterStage: Effect.Effect<void> = Effect.void
	let clock = 0
	let writeCount = 0
	let deleteCount = 0
	let blobReads = 0
	let blobChecks = 0

	const now = Effect.sync(() => clock)
	const online = Effect.suspend(() =>
		failing ? Effect.fail(offline("store offline")) : Effect.void,
	)

	const bucket: ArtifactBucketWriter<never> = {
		put: (key, body, options) =>
			Effect.gen(function* () {
				yield* online
				if (failManifest && key.includes("/manifests/")) {
					return yield* offline("manifest write failed")
				}
				const bytes = typeof body === "string" ? encoder.encode(body) : body
				if (options?.sha256 !== undefined) {
					const digest = yield* Digest.Digest
					if ((yield* digest.digestHex(Digest.sha256, bytes)) !== options.sha256) {
						return yield* offline(`${key} does not match its sha256`)
					}
				}
				objects.set(key, bytes)
				uploadedAt.set(key, clock)
				puts.set(key, (puts.get(key) ?? 0) + 1)
			}).pipe(Effect.provide(Digest.layerWebCrypto)),
		delete: (keys) =>
			Effect.suspend(() => beforeDelete).pipe(
				Effect.andThen(online),
				Effect.andThen(
					Effect.sync(() => {
						for (const key of keys) {
							objects.delete(key)
						}
					}),
				),
			),
		list: (prefix) =>
			Effect.andThen(
				online,
				Effect.sync(() =>
					[...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, LIST_PAGE_SIZE),
				),
			),
	}

	const ownerOf = (scope: string, artifactId: string) => {
		const owned = artifactPrefix(scope, artifactId)
		const existing = owners.get(owned)
		if (existing !== undefined) {
			return existing
		}
		const ledger = makeMemoryLedger()
		ledgers.set(owned, ledger)
		const owner = makeArtifactOwner({
			scope,
			ledger,
			bucket,
			now,
			grace,
			alarm: Effect.sync(() => alarms.get(owned) ?? null),
			setAlarm: (at) =>
				Effect.sync(() => {
					if (at === null) {
						alarms.delete(owned)
					} else {
						alarms.set(owned, at)
					}
				}),
		})
		owners.set(owned, owner)
		return owner
	}

	const read = <A>(run: () => A) =>
		Effect.andThen(
			online,
			Effect.try({ try: run, catch: (cause) => new ArtifactStoreError({ cause }) }),
		)

	const layerIn = (scope: string) => {
		const writeOf = (artifactId: string, writeId: string): StagedWrite => {
			const owner = ownerOf(scope, artifactId)
			return {
				id: writeId,
				markCommitted: (check) =>
					owner.markCommitted(
						writeId,
						check === null ? null : { artifact_id: artifactId, write_id: writeId, check },
					),
				confirm: owner.confirm(artifactId, writeId),
				abandon: owner.abandon(artifactId, writeId),
			}
		}

		const stage = (artifactId: string, version: BuiltArtifactVersion) =>
			Effect.gen(function* () {
				yield* Effect.suspend(() => beforePut)
				const owner = ownerOf(scope, artifactId)
				writeCount += 1
				const writeId = `write_${writeCount}`
				yield* owner.stage(artifactId, writeId, version)
				yield* Effect.suspend(() => afterStage)
				return writeOf(artifactId, writeId)
			})

		const markerPrefix = artifactMarkerPrefix(scope)
		const cursorKey = artifactReconcileCursorKey(scope)

		return Layer.succeed(ArtifactStore, {
			stage,
			putVersion: (artifactId, version) =>
				Effect.flatMap(stage(artifactId, version), (write) => committedOrFailed(write)),
			getManifest: (artifactId, manifestHash) =>
				Effect.andThen(
					Effect.suspend(() => beforeGet),
					read(() => {
						const bytes = objects.get(artifactManifestKey(scope, artifactId, manifestHash))
						return bytes === undefined ? null : decodeManifest(decoder.decode(bytes))
					}),
				),
			getBlob: (artifactId, sha256) =>
				read(() => {
					blobReads += 1
					return objects.get(artifactBlobKey(scope, artifactId, sha256)) ?? null
				}),
			hasBlob: (artifactId, sha256) =>
				read(() => {
					blobChecks += 1
					return objects.has(artifactBlobKey(scope, artifactId, sha256))
				}),
			markDeleting: (artifactId) =>
				Effect.suspend(() => {
					deleteCount += 1
					return bucket.put(
						artifactMarkerKey(scope, artifactId, `${ARTIFACT_DELETE_PREFIX}${deleteCount}`),
						"",
					)
				}),
			purge: (artifactId) => ownerOf(scope, artifactId).purge(artifactId),
			unconfirmedWrites: (startAfter, limit) =>
				read(() => {
					const listed = [...objects.keys()]
						.filter(
							(key) => key.startsWith(markerPrefix) && (startAfter === null || key > startAfter),
						)
						.sort()
					const page = listed.slice(0, limit)
					return {
						writes: listedMarkers(
							scope,
							page.map((key) => ({ key, uploaded: new Date(uploadedAt.get(key) ?? clock) })),
							clock,
						).map((marker) => {
							const write = writeOf(marker.artifact_id, marker.write_id)
							return {
								key: marker.key,
								artifact_id: marker.artifact_id,
								write_id: marker.write_id,
								age: marker.age,
								marker: read(() => {
									const bytes = objects.get(marker.key)
									return bytes === undefined ? null : decodeMarker(decoder.decode(bytes))
								}),
								confirm: write.confirm,
								abandon: write.abandon,
							}
						}),
						next: listed.length > limit ? (page.at(-1) ?? null) : null,
					}
				}),
			reconcileCursor: read(() => {
				const bytes = objects.get(cursorKey)
				return bytes === undefined ? null : decoder.decode(bytes)
			}),
			saveReconcileCursor: (cursor) =>
				cursor === null ? bucket.delete([cursorKey]) : bucket.put(cursorKey, cursor),
		})
	}

	return {
		layer: layerIn(options?.scope ?? DEFAULT_STORAGE_SCOPE),
		layerIn,
		objects,
		markers: () => [...objects.keys()].filter((key) => key.startsWith(ARTIFACT_MARKER_ROOT)),
		upload: (key: string, body: string) => {
			objects.set(key, encoder.encode(body))
			uploadedAt.set(key, clock)
		},
		putCount: (key: string) => puts.get(key) ?? 0,
		blobReads: () => blobReads,
		blobChecks: () => blobChecks,
		ledgers,
		alarms,
		advanceClock: (millis: number) => {
			clock += millis
		},
		runDueAlarms: Effect.gen(function* () {
			const at = yield* now
			for (const [owned, due] of Array.from(alarms)) {
				const owner = owners.get(owned)
				if (due <= at && owner !== undefined) {
					alarms.delete(owned)
					if (Exit.isFailure(yield* Effect.exit(owner.alarm))) {
						alarms.set(owned, Math.min(alarms.get(owned) ?? due, due))
					}
				}
			}
		}),
		setFailing: (value: boolean) => {
			failing = value
		},
		setFailManifest: (value: boolean) => {
			failManifest = value
		},
		setBeforePut: (effect: Effect.Effect<void>) => {
			beforePut = effect
		},
		setBeforeGet: (effect: Effect.Effect<void>) => {
			beforeGet = effect
		},
		setBeforeDelete: (effect: Effect.Effect<void>) => {
			beforeDelete = effect
		},
		setAfterStage: (effect: Effect.Effect<void>) => {
			afterStage = effect
		},
	}
}
