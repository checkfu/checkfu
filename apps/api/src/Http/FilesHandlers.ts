import { CreateFile } from "@checkfu/domain/File/CreateFile.command"
import { DeleteFile } from "@checkfu/domain/File/DeleteFile.command"
import { File } from "@checkfu/domain/File/File.aggregate"
import type { FileState } from "@checkfu/domain/File/File.aggregate"
import { FileId } from "@checkfu/domain/File/File.id"
import { ReserveFile } from "@checkfu/domain/File/ReserveFile.command"
import { MAX_FILE_BYTES } from "@checkfu/sdk/Limits"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Mime from "effect/http/Mime"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { FileStore, FileStoreError } from "../Files/FileStore.ts"
import { CheckfuApi, FileResource, apiError } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import {
	currentRequestId,
	errorResponse,
	handled,
	idempotentId,
	randomId,
	reject,
	reusedKey,
} from "./HttpHelpers.ts"

const DEFAULT_CONTENT_TYPE = "application/octet-stream"

export const keyedFileId = (digest: Digest.Digest["Service"], idempotencyKey: string) =>
	Effect.map(idempotentId(digest, "file", ["upload", "file", "id", idempotencyKey]), (id) =>
		FileId.make(id.slice(0, "file_".length + 32)),
	)

const stored = <A, E extends { readonly _tag: string }, R>(
	effect: Effect.Effect<A, E | FileStoreError, R>,
) =>
	effect.pipe(
		Effect.catchTag("FileStoreError", (error) =>
			Effect.andThen(
				Effect.logError("File storage failed", error),
				reject(503, "File storage is unavailable. Retry the request."),
			),
		),
	)

const interrupted = reject(503, "The upload took too long; retry the request.")

const encodeFile = Schema.encodeEffect(FileResource)

const attachmentNamed = (filename: string) =>
	`attachment; filename*=UTF-8''${encodeURIComponent(filename)
		.replaceAll("'", "%27")
		.replaceAll("(", "%28")
		.replaceAll(")", "%29")
		.replaceAll("*", "%2A")}`

const fileResource = (id: FileId, state: FileState) => ({
	id,
	type: "file" as const,
	filename: state.filename,
	content_type: state.content_type,
	size: state.size,
	sha256: state.sha256,
	created_at: DateTime.makeUnsafe(state.created_at),
})

export const FilesLive = HttpApiBuilder.group(CheckfuApi, "files", (handlers) =>
	Effect.gen(function* () {
		const files = yield* File
		const store = yield* FileStore
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const list = yield* makeLister

		const requireReady = (id: FileId) =>
			files.get(id).pipe(
				Effect.filterOrElse(
					(state) => state.status === "ready",
					() => reject(404, `File ${id} not found.`),
				),
			)

		return handlers
			.handleRaw("upload", ({ query, headers, request }) =>
				Effect.gen(function* () {
					const size = Number(request.headers["content-length"] ?? Number.NaN)
					if (!Number.isSafeInteger(size) || size < 0) {
						return yield* reject(400, "Send the upload with a Content-Length header.")
					}
					if (size > MAX_FILE_BYTES) {
						return yield* errorResponse(
							apiError(
								413,
								`A file may be at most ${MAX_FILE_BYTES} bytes.`,
								yield* currentRequestId,
							),
						)
					}
					const filename = query.filename
					const content_type =
						query.content_type ??
						Option.getOrElse(Mime.getType(`./${filename}`), () => DEFAULT_CONTENT_TYPE)
					const idempotencyKey = headers["idempotency-key"]
					const id =
						idempotencyKey === undefined
							? FileId.make(yield* randomId(random, "file"))
							: yield* keyedFileId(digest, idempotencyKey)
					const existing = yield* files.get(id)
					if (existing.status === "deleted") {
						return yield* reusedKey
					}
					const reservation =
						existing.status === "ready"
							? null
							: yield* files.send(new ReserveFile({ file_id: id })).pipe(
									Effect.map((reserved): number | null => reserved.reply.reservation),
									Effect.catchTag("FileAlreadyExists", () => Effect.succeed(null)),
								)
					const body = request.stream.pipe(
						Stream.mapError((cause) => new FileStoreError({ cause })),
					)
					const bytes = yield* stored(
						reservation === null ? store.measure(body) : store.put(id, reservation, body, size),
					).pipe(
						Effect.catchTags({
							BytesPurged: () => interrupted,
							ReservationStale: () => interrupted,
							FileSizeMismatch: (mismatch) =>
								reject(
									400,
									`The body was ${mismatch.received} bytes, not the ${mismatch.declared} its Content-Length declared.`,
								),
						}),
					)
					if (reservation !== null) {
						yield* files
							.send(
								new CreateFile({
									file_id: id,
									filename,
									content_type,
									size: bytes.size,
									sha256: bytes.sha256,
									reservation,
								}),
								{ commandId: `create-file:${id}:${reservation}` },
							)
							.pipe(
								Effect.catchTags({
									FileReservationLapsed: () => interrupted,
									FileAlreadyExists: () => Effect.void,
								}),
							)
					}
					const state = yield* files.get(id)
					if (
						state.status !== "ready" ||
						state.sha256 !== bytes.sha256 ||
						state.filename !== filename ||
						state.content_type !== content_type
					) {
						return yield* reusedKey
					}
					return HttpServerResponse.jsonUnsafe(
						yield* Effect.orDie(encodeFile(fileResource(id, state))),
						{ status: 201 },
					)
				}).pipe(handled),
			)
			.handle("list", ({ query }) =>
				list("file", query, (id) =>
					Effect.map(requireReady(FileId.make(id)), (state) =>
						fileResource(FileId.make(id), state),
					),
				).pipe(handled),
			)
			.handle("get", ({ params }) =>
				Effect.map(requireReady(params.file_id), (state) =>
					fileResource(params.file_id, state),
				).pipe(handled),
			)
			.handleRaw("content", ({ params }) =>
				Effect.gen(function* () {
					const id = params.file_id
					const state = yield* requireReady(id)
					const body = yield* stored(store.content(id))
					if (body === null) {
						yield* requireReady(id)
						yield* Effect.logError("File bytes are missing", { file_id: id })
						return yield* reject(500, "Failed to load the file.")
					}
					return HttpServerResponse.stream(body, {
						contentType: state.content_type,
						contentLength: state.size,
						headers: {
							"content-disposition": attachmentNamed(state.filename),
							"content-security-policy": "sandbox",
							"x-content-type-options": "nosniff",
						},
					})
				}).pipe(handled),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const id = params.file_id
					const state = yield* files.get(id)
					if (state.status === "") {
						return yield* reject(404, `File ${id} not found.`)
					}
					if (state.status !== "deleted") {
						yield* files
							.send(new DeleteFile({ file_id: id }))
							.pipe(
								Effect.catchTag("FileNotFound", (refused) =>
									Effect.flatMap(files.get(id), (now) =>
										now.status === "deleted" ? Effect.void : Effect.fail(refused),
									),
								),
							)
					}
					yield* stored(store.purge(id))
					return { id, type: "file_deleted" as const }
				}).pipe(handled),
			)
	}),
)
