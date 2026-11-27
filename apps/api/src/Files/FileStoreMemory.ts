import { initialOwnerMarks } from "@checkfu/domain/Bytes/ByteOwnership"
import type { OwnerMarks } from "@checkfu/domain/Bytes/ByteOwnership"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { DEFAULT_STORAGE_SCOPE } from "../Placement.ts"
import { makeByteOwner } from "./ByteOwner.ts"
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

const hashed = (body: Stream.Stream<Uint8Array, FileStoreError>) =>
	Effect.gen(function* () {
		const digest = yield* Digest.Digest
		const bytes = yield* collect(body)
		return { bytes, sha256: yield* digest.digestHex(Digest.sha256, bytes) }
	}).pipe(Effect.provide(Digest.layerWebCrypto))

export const makeFileStoreMemory = (options?: { readonly scope?: string }) => {
	const scope = options?.scope ?? DEFAULT_STORAGE_SCOPE
	const objects = new Map<string, Uint8Array>()
	const marks = new Map<string, OwnerMarks>()
	const owners = new Map<string, ReturnType<typeof ownerOf>>()
	let failing = false
	let beforeStore: Effect.Effect<void, FileStoreError> = Effect.void
	let afterPut: Effect.Effect<void> = Effect.void
	let writes = 0

	const online = Effect.suspend(() => (failing ? Effect.fail(offline()) : Effect.void))

	const ownerOf = (fileId: string) =>
		makeByteOwner({
			marks: Effect.sync(() => marks.get(fileId) ?? initialOwnerMarks),
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
			return owning(fileId)
				.writeAlone(
					reservation,
					Effect.gen(function* () {
						yield* online
						const { bytes, sha256 } = yield* hashed(body)
						if (bytes.byteLength !== size) {
							objects.delete(key)
							return yield* new FileSizeMismatch({ declared: size, received: bytes.byteLength })
						}
						yield* Effect.suspend(() => beforeStore)
						objects.set(key, bytes)
						writes += 1
						return { sha256, size: bytes.byteLength }
					}),
				)
				.pipe(Effect.tap(() => Effect.suspend(() => afterPut)))
		},
		measure: (body) =>
			Effect.map(hashed(body), ({ bytes, sha256 }) => ({ sha256, size: bytes.byteLength })),
		content: (fileId, range) =>
			Effect.andThen(
				online,
				Effect.sync(() => {
					const bytes = objects.get(fileContentKey(scope, fileId))
					return bytes === undefined
						? null
						: Stream.make(
								range === undefined
									? bytes
									: bytes.subarray(range.offset, range.offset + range.length),
							)
				}),
			),
		read: (fileId, range) =>
			Effect.andThen(
				online,
				Effect.sync(() => {
					const bytes = objects.get(fileContentKey(scope, fileId))
					return bytes === undefined ? null : bytes.slice(range.offset, range.offset + range.length)
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
		setBeforeStore: (effect: Effect.Effect<void, FileStoreError>) => {
			beforeStore = effect
		},
		setAfterPut: (effect: Effect.Effect<void>) => {
			afterPut = effect
		},
	}
}
