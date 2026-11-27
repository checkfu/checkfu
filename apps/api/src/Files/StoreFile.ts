import { CreateFile } from "@checkfu/domain/File/CreateFile.command"
import { File } from "@checkfu/domain/File/File.aggregate"
import type { FileState } from "@checkfu/domain/File/File.aggregate"
import type { FileId } from "@checkfu/domain/File/File.id"
import { ReserveFile } from "@checkfu/domain/File/ReserveFile.command"
import * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import { FileStore } from "./FileStore.ts"
import type { FileStoreError } from "./FileStore.ts"

export interface FileOrigin {
	readonly session_id: string
	readonly turn: number
	readonly path: string
}

export interface NewFile {
	readonly id: FileId
	readonly filename: string
	readonly content_type: string
	readonly origin: FileOrigin | null
	readonly body: Stream.Stream<Uint8Array, FileStoreError>
	readonly size: number
}

export type StoreFileOutcome =
	| { readonly _tag: "Stored"; readonly state: FileState }
	| { readonly _tag: "Taken" }
	| { readonly _tag: "Busy" }
	| { readonly _tag: "SizeMismatch"; readonly declared: number; readonly received: number }

const busy: StoreFileOutcome = { _tag: "Busy" }
const taken: StoreFileOutcome = { _tag: "Taken" }

export const makeStoreFile = Effect.gen(function* () {
	const files = yield* File
	const store = yield* FileStore

	return Effect.fn("Files.store")(function* (file: NewFile) {
		const { id, origin } = file
		const existing = yield* files.get(id)
		if (existing.status === "deleted") {
			return taken
		}
		const reservation =
			existing.status === "ready"
				? null
				: yield* files.send(new ReserveFile({ file_id: id })).pipe(
						Effect.map((reserved): number | null => reserved.reply.reservation),
						Effect.catchTag("FileAlreadyExists", () => Effect.succeed(null)),
					)
		const written = yield* (
			reservation === null
				? store.measure(file.body)
				: store.put(id, reservation, file.body, file.size)
		).pipe(
			Effect.map((bytes) => ({ _tag: "Written" as const, bytes })),
			Effect.catchTags({
				BytesPurged: () => Effect.succeed(busy),
				ReservationStale: () => Effect.succeed(busy),
				FileSizeMismatch: ({ declared, received }) =>
					Effect.succeed<StoreFileOutcome>({ _tag: "SizeMismatch", declared, received }),
			}),
		)
		if (written._tag !== "Written") {
			return written
		}
		const { bytes } = written
		if (bytes.size !== file.size) {
			const mismatch: StoreFileOutcome = {
				_tag: "SizeMismatch",
				declared: file.size,
				received: bytes.size,
			}
			return mismatch
		}
		if (reservation !== null) {
			const created = yield* files
				.send(
					new CreateFile({
						file_id: id,
						filename: file.filename,
						content_type: file.content_type,
						size: bytes.size,
						sha256: bytes.sha256,
						origin_session_id: origin?.session_id ?? "",
						origin_turn: origin?.turn ?? 0,
						origin_path: origin?.path ?? "",
						reservation,
					}),
					{ commandId: `create-file:${id}:${reservation}` },
				)
				.pipe(
					Effect.as(null),
					Effect.catchTags({
						FileReservationLapsed: () => Effect.succeed(busy),
						FileAlreadyExists: () => Effect.succeed(null),
						FileOriginIncomplete: () => Effect.succeed(taken),
					}),
				)
			if (created !== null) {
				return created
			}
		}
		const state = yield* files.get(id)
		if (
			state.status !== "ready" ||
			state.sha256 !== bytes.sha256 ||
			state.filename !== file.filename ||
			state.content_type !== file.content_type
		) {
			return taken
		}
		const stored: StoreFileOutcome = { _tag: "Stored", state }
		return stored
	})
})
