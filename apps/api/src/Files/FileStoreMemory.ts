import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { DEFAULT_STORAGE_SCOPE } from "../Placement.ts"
import { UNMARKED, makeByteOwner } from "./ByteOwner.ts"
import type { OwnerMarks } from "./ByteOwner.ts"
import {
	FileSizeMismatch,
	FileStore,
	FileStoreError,
	fileContentKey,
	filePrefix,
} from "./FileStore.ts"

const offline = () => new FileStoreError({ cause: new Error("store offline") })

const collect = (body: Stream.Stream<Uint8Array, FileStoreError>) =>
	Effect.map(Stream.runCollect(body), (chunks) => {
		const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return bytes
	})

export const makeFileStoreMemory = (options?: { readonly scope?: string }) => {
	const scope = options?.scope ?? DEFAULT_STORAGE_SCOPE
	const objects = new Map<string, Uint8Array>()
	const marks = new Map<string, OwnerMarks>()
	const owners = new Map<string, ReturnType<typeof ownerOf>>()
	let failing = false
	let beforeStore: Effect.Effect<void> = Effect.void
	let writes = 0

	const online = Effect.suspend(() => (failing ? Effect.fail(offline()) : Effect.void))

	const ownerOf = (fileId: string) =>
		makeByteOwner({
			marks: Effect.sync(() => marks.get(fileId) ?? UNMARKED),
			saveMarks: (next) =>
				Effect.andThen(
					online,
					Effect.sync(() => {
						marks.set(fileId, next)
					}),
				),
			removeAll: Effect.andThen(
				online,
				Effect.sync(() => {
					for (const key of objects.keys()) {
						if (key.startsWith(filePrefix(scope, fileId))) {
							objects.delete(key)
						}
					}
				}),
			),
		})

	const owning = (fileId: string) => {
		const existing = owners.get(fileId)
		if (existing !== undefined) {
			return existing
		}
		const owner = ownerOf(fileId)
		owners.set(fileId, owner)
		return owner
	}

	const layer = Layer.succeed(FileStore, {
		put: (fileId, reservation, body, size) => {
			const key = fileContentKey(scope, fileId)
			const owner = owning(fileId)
			const measured = Effect.gen(function* () {
				yield* online
				const digest = yield* Digest.Digest
				const bytes = yield* collect(body)
				return { bytes, sha256: yield* digest.digestHex(Digest.sha256, bytes) }
			})
			const written =
				reservation === null
					? owner.write(
							null,
							Effect.map(measured, ({ bytes, sha256 }) => ({ sha256, size: bytes.byteLength })),
						)
					: owner.writeAlone(
							reservation,
							Effect.gen(function* () {
								const { bytes, sha256 } = yield* measured
								if (bytes.byteLength !== size) {
									objects.delete(key)
									return yield* new FileSizeMismatch({
										declared: size,
										received: bytes.byteLength,
									})
								}
								yield* Effect.suspend(() => beforeStore)
								objects.set(key, bytes)
								writes += 1
								return { sha256, size: bytes.byteLength }
							}),
						)
			return written.pipe(Effect.provide(Digest.layerWebCrypto))
		},
		content: (fileId) =>
			Effect.andThen(
				online,
				Effect.sync(() => {
					const bytes = objects.get(fileContentKey(scope, fileId))
					return bytes === undefined ? null : Stream.make(bytes)
				}),
			),
		purge: (fileId) => owning(fileId).purge,
		release: (fileId, reservation) => owning(fileId).release(reservation),
	})

	return {
		layer,
		objects,
		marks,
		writes: () => writes,
		setFailing: (value: boolean) => {
			failing = value
		},
		setBeforeStore: (effect: Effect.Effect<void>) => {
			beforeStore = effect
		},
	}
}
