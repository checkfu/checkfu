import { FileId, FileName, MAX_FILE_BYTES } from "@checkfu/sdk/Schemas"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { formatClientError, usageError } from "../Errors.ts"
import { getClient, renderOutput } from "../RootCommand.ts"

const uploadCommand = Command.make(
	"upload",
	{
		path: Argument.String("path").pipe(Argument.withDescription("The local file to upload")),
		filename: Flag.String("filename").pipe(
			Flag.withMetavar("NAME"),
			Flag.withDescription("Name to store the file under (default: the local file's name)"),
			Flag.optional,
		),
		contentType: Flag.String("content-type").pipe(
			Flag.withMetavar("TYPE"),
			Flag.withDescription("Media type of the file (default: taken from the name)"),
			Flag.optional,
		),
		idempotencyKey: Flag.String("idempotency-key").pipe(
			Flag.withMetavar("KEY"),
			Flag.withDescription("Key that makes a retried upload answer with the same file"),
			Flag.optional,
		),
	},
	(input) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const named = Option.getOrElse(input.filename, () => path.basename(input.path))
			const filename = yield* Schema.decodeEffect(FileName)(named).pipe(
				Effect.mapError(() => usageError(`${named}: not a usable file name; pass --filename.`)),
			)
			const stat = yield* fs
				.stat(input.path)
				.pipe(Effect.mapError(() => usageError(`${input.path}: no such file.`)))
			if (stat.type !== "File") {
				return yield* usageError(`${input.path}: expected a file.`)
			}
			if (Number(stat.size) > MAX_FILE_BYTES) {
				return yield* usageError(`${input.path}: a file may be at most ${MAX_FILE_BYTES} bytes.`)
			}
			const chunks = yield* Stream.runCollect(fs.stream(input.path)).pipe(
				Effect.mapError((error) => usageError(`${input.path}: ${error.message}`)),
			)
			const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
			let offset = 0
			for (const chunk of chunks) {
				bytes.set(chunk, offset)
				offset += chunk.byteLength
			}
			const client = yield* getClient
			const key = Option.isSome(input.idempotencyKey)
				? input.idempotencyKey.value
				: yield* client.generateIdempotencyKey
			const file = yield* client.api.files
				.upload({
					query: {
						filename,
						...(Option.isSome(input.contentType) ? { content_type: input.contentType.value } : {}),
					},
					headers: { "idempotency-key": key },
					payload: bytes,
				})
				.pipe(Effect.mapError(formatClientError))
			yield* renderOutput(file)
		}),
).pipe(Command.withDescription("Upload a local file"))

const downloadCommand = Command.make(
	"download",
	{
		fileId: Flag.String("file-id").pipe(
			Flag.withMetavar("ID"),
			Flag.withDescription("The file to download"),
		),
		output: Flag.String("output").pipe(
			Flag.withAlias("o"),
			Flag.withMetavar("PATH"),
			Flag.withDescription("Where to write it (default: the file's name, in this directory)"),
			Flag.optional,
		),
	},
	(input) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const client = yield* getClient
			const file_id = yield* Schema.decodeEffect(FileId)(input.fileId).pipe(
				Effect.mapError(() => usageError("--file-id must not be empty.")),
			)
			const file = yield* client.api.files
				.get({ params: { file_id } })
				.pipe(Effect.mapError(formatClientError))
			const target = Option.getOrElse(input.output, () => file.filename)
			const body = yield* client.api.files
				.content({ params: { file_id } })
				.pipe(Effect.mapError(formatClientError))
			yield* Stream.run(
				Stream.mapError(body, (error) => formatClientError(error)),
				Sink.mapError(fs.sink(target, { flag: "wx" }), (error) =>
					usageError(
						error.reason._tag === "AlreadyExists"
							? `${target} already exists; pass --output to write somewhere else.`
							: `${target}: ${error.message}`,
					),
				),
			)
			yield* renderOutput({ id: file.id, path: target, size: file.size })
		}),
).pipe(Command.withDescription("Download a file's bytes to a local path"))

export const filesCommands = [uploadCommand, downloadCommand] as const
