import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { ArtifactBucket, deleteUntilEmpty } from "../Artifacts/ArtifactStore.ts"
import { placedStub, placement, storageScope, storageScopeOf } from "../Placement.ts"
import { BytesPurged, ReservationStale, UNMARKED, makeByteOwner } from "./ByteOwner.ts"
import type { OwnerMarks } from "./ByteOwner.ts"
import {
	FileSizeMismatch,
	FileStore,
	FileStoreError,
	fileContent,
	fileContentKey,
	filePrefix,
} from "./FileStore.ts"
import type { StoredBytes } from "./FileStore.ts"

const LIST_PAGE_SIZE = 1000

const MARKS_KEY = "marks"

const storeError = (cause: unknown) => new FileStoreError({ cause })

declare global {
	interface Crypto {
		readonly DigestStream: new (
			algorithm: string,
		) => WritableStream<ArrayBufferView> & { readonly digest: Promise<ArrayBuffer> }
	}
}

const measuring = () => {
	const sink = new crypto.DigestStream("SHA-256")
	const writer = sink.getWriter()
	let size = 0
	const through = new TransformStream<Uint8Array, Uint8Array>({
		transform: async (chunk, controller) => {
			size += chunk.byteLength
			await writer.write(chunk)
			controller.enqueue(chunk)
		},
		flush: () => writer.close(),
	})
	return {
		through,
		received: () => size,
		stored: async (): Promise<StoredBytes> => ({
			sha256: Hex.encode(new Uint8Array(await sink.digest)),
			size,
		}),
	}
}

const measure = (body: ReadableStream<Uint8Array>) =>
	Effect.tryPromise({
		try: async () => {
			const measured = measuring()
			await body.pipeThrough(measured.through).pipeTo(new WritableStream())
			return measured.stored()
		},
		catch: storeError,
	})

type PutOutcome = StoredBytes | "purged" | "stale" | { readonly received: number }

interface FileObjectsShape {
	readonly put: (
		fileId: string,
		reservation: number | null,
		body: ReadableStream<Uint8Array>,
		size: number,
	) => Effect.Effect<PutOutcome, FileStoreError, RuntimeContext>
	readonly release: (
		fileId: string,
		reservation: number,
	) => Effect.Effect<void, FileStoreError, RuntimeContext>
	readonly purge: (fileId: string) => Effect.Effect<void, FileStoreError, RuntimeContext>
}

export class FileObjects extends Cloudflare.DurableObject<FileObjects, FileObjectsShape>()(
	"FileObjects",
) {}

const overWire = <A, R>(effect: Effect.Effect<A, FileStoreError, R>) =>
	Effect.mapError(effect, (error) => storeError(String(error.cause)))

export const FileObjectsLive = FileObjects.make(
	Effect.map(
		Effect.gen(function* () {
			const bucket = yield* Cloudflare.R2.ReadWriteBucket(yield* Effect.orDie(ArtifactBucket))
			const state = yield* Cloudflare.DurableObjectState
			const scope = yield* Effect.orDie(storageScope)
			return { bucket, state, scope }
		}),
		({ state, bucket, scope }) => {
			const ownerOf = (fileId: string) =>
				makeByteOwner({
					marks: state.storage
						.get<OwnerMarks>(MARKS_KEY)
						.pipe(
							Effect.mapBoth({ onSuccess: (marks) => marks ?? UNMARKED, onFailure: storeError }),
						),
					saveMarks: (marks) =>
						state.storage.put(MARKS_KEY, marks).pipe(Effect.mapError(storeError)),
					removeAll: deleteUntilEmpty(
						bucket.list({ prefix: filePrefix(scope, fileId), limit: LIST_PAGE_SIZE }).pipe(
							Effect.mapBoth({
								onSuccess: (page) => page.objects.map((object) => object.key),
								onFailure: storeError,
							}),
						),
						(keys) => bucket.delete(keys).pipe(Effect.mapError(storeError)),
					),
				})
			const store = (key: string, body: ReadableStream<Uint8Array>, size: number) =>
				Effect.gen(function* () {
					if (size === 0) {
						const empty = yield* measure(body)
						if (empty.size !== 0) {
							return { received: empty.size }
						}
						yield* bucket.put(key, new Uint8Array(0)).pipe(Effect.mapError(storeError))
						return empty
					}
					const measured = measuring()
					const written = yield* Effect.exit(
						bucket.put(
							key,
							Stream.fromReadableStream({
								evaluate: () => body.pipeThrough(measured.through),
								onError: storeError,
							}),
							{ contentLength: size },
						),
					)
					if (measured.received() !== size) {
						yield* bucket.delete(key).pipe(Effect.mapError(storeError))
						return { received: measured.received() }
					}
					if (written._tag === "Failure") {
						return yield* storeError(Cause.squash(written.cause))
					}
					return yield* Effect.tryPromise({ try: measured.stored, catch: storeError })
				})
			return Effect.sync((): FileObjectsShape => {
				let owner: ReturnType<typeof ownerOf> | undefined
				const owning = (fileId: string) => (owner ??= ownerOf(fileId))

				return {
					put: (fileId, reservation, body, size) => {
						const key = fileContentKey(scope, fileId)
						const owner = owning(fileId)
						const written: Effect.Effect<
							PutOutcome,
							FileStoreError | BytesPurged | ReservationStale,
							RuntimeContext
						> =
							reservation === null
								? owner.write(null, measure(body))
								: owner.writeAlone(reservation, store(key, body, size))
						return overWire(
							written.pipe(
								Effect.catchTags({
									BytesPurged: () => Effect.succeed("purged" as const),
									ReservationStale: () => Effect.succeed("stale" as const),
								}),
							),
						)
					},
					release: (fileId, reservation) => overWire(owning(fileId).release(reservation)),
					purge: (fileId) => overWire(owning(fileId).purge),
				}
			})
		},
	),
)

export const FileStoreR2 = Layer.effect(
	FileStore,
	Effect.gen(function* () {
		const bucket = yield* Cloudflare.R2.ReadBucket(yield* ArtifactBucket)
		const placed = yield* placement
		const scope = storageScopeOf(placed)
		const owners = placedStub(yield* FileObjects, placed)
		const runtime = yield* Cloudflare.Worker
		const call = <A, E>(effect: () => Effect.Effect<A, E, RuntimeContext>) =>
			Effect.suspend(effect).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.fail(storeError(Cause.squash(cause))),
				),
				Effect.provideService(RuntimeContext, runtime),
			)
		return {
			put: (fileId, reservation, body, size) =>
				call(() =>
					owners(fileId).put(fileId, reservation, Stream.toReadableStream(body), size),
				).pipe(
					Effect.flatMap(
						(
							outcome,
						): Effect.Effect<StoredBytes, FileSizeMismatch | BytesPurged | ReservationStale> =>
							outcome === "purged"
								? Effect.fail(new BytesPurged())
								: outcome === "stale"
									? Effect.fail(new ReservationStale({ reservation: reservation ?? 0 }))
									: "received" in outcome
										? Effect.fail(
												new FileSizeMismatch({ declared: size, received: outcome.received }),
											)
										: Effect.succeed(outcome),
					),
				),
			content: fileContent(scope, bucket, runtime),
			purge: (fileId) => call(() => owners(fileId).purge(fileId)),
			release: (fileId, reservation) => call(() => owners(fileId).release(fileId, reservation)),
		}
	}),
)
