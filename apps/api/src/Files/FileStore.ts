import type * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { BytesPurged, ReservationStale } from "./ByteOwner.ts"

export class FileStoreError extends Schema.TaggedError<
	FileStoreError,
	{ readonly brand: unique symbol }
>()("FileStoreError", { cause: Schema.Unknown }) {}

export class FileSizeMismatch extends Schema.TaggedError<
	FileSizeMismatch,
	{ readonly brand: unique symbol }
>()("FileSizeMismatch", { declared: Schema.Int, received: Schema.Int }) {}

export interface StoredBytes {
	readonly sha256: string
	readonly size: number
}

export interface FileStoreService {
	readonly put: (
		fileId: string,
		reservation: number,
		body: Stream.Stream<Uint8Array, FileStoreError>,
		size: number,
	) => Effect.Effect<
		StoredBytes,
		FileStoreError | FileSizeMismatch | BytesPurged | ReservationStale
	>
	readonly measure: (
		body: Stream.Stream<Uint8Array, FileStoreError>,
	) => Effect.Effect<StoredBytes, FileStoreError>
	readonly content: (
		fileId: string,
	) => Effect.Effect<Stream.Stream<Uint8Array, FileStoreError> | null, FileStoreError>
	readonly purge: (fileId: string) => Effect.Effect<void, FileStoreError>
	readonly release: (fileId: string, reservation: number) => Effect.Effect<void, FileStoreError>
}

export class FileStore extends Context.Service<FileStore, FileStoreService>()(
	"@checkfu/api/FileStore",
) {}

export const filePrefix = (scope: string, fileId: string) => `files/${scope}/${fileId}/`
export const fileContentKey = (scope: string, fileId: string) =>
	`${filePrefix(scope, fileId)}content`

export const fileContent =
	(
		scope: string,
		bucket: Pick<Cloudflare.R2.ReadBucketClient, "get">,
		runtime: RuntimeContext["Service"],
	): FileStoreService["content"] =>
	(fileId) =>
		bucket.get(fileContentKey(scope, fileId)).pipe(
			Effect.mapBoth({
				onSuccess: (object) =>
					object === null
						? null
						: object.body.pipe(Stream.mapError((cause) => new FileStoreError({ cause }))),
				onFailure: (cause) => new FileStoreError({ cause }),
			}),
			Effect.provideService(RuntimeContext, runtime),
		)
