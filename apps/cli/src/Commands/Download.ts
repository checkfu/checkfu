import { createHash } from "node:crypto"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { formatClientError, usageError } from "../Errors.ts"

type DownloadError = Parameters<typeof formatClientError>[0]

export const downloadTo = <R>(
	target: string,
	file: { readonly size: number; readonly sha256: string },
	read: Effect.Effect<Stream.Stream<Uint8Array, DownloadError>, DownloadError, R>,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const unwritable = (error: PlatformError.PlatformError) =>
			usageError(`${target}: ${error.message}`)
		const targetExists = () =>
			usageError(`${target} already exists; pass --output to write somewhere else.`)
		if (yield* Effect.mapError(fs.exists(target), unwritable)) {
			return yield* targetExists()
		}
		const body = yield* read.pipe(Effect.mapError(formatClientError))
		const random = yield* SecureRandom.SecureRandom
		const suffix = Hex.encode(yield* random.randomBytes(12))
		const parent = path.dirname(target)
		const separator = parent.endsWith(path.sep) ? "" : path.sep
		// Preserve the destination's parent through symlinks and `..` segments.
		const temporary = `${parent}${separator}checkfu-download-${suffix}`
		yield* Effect.acquireRelease(fs.makeDirectory(temporary, { mode: 0o700 }), () =>
			Effect.orDie(fs.remove(temporary, { recursive: true, force: true })),
		).pipe(Effect.mapError(unwritable))
		const partial = `${temporary}${path.sep}content`
		const mismatch = (reason: string) =>
			usageError(`${target}: downloaded file failed integrity verification. ${reason}`)
		const hash = createHash("sha256")
		let received = 0
		const verified = body.pipe(
			Stream.mapError(formatClientError),
			Stream.tap((chunk) =>
				Effect.suspend(() => {
					received += chunk.byteLength
					if (received > file.size) {
						return mismatch(`The response exceeds the expected ${file.size} bytes.`)
					}
					hash.update(chunk)
					return Effect.void
				}),
			),
		)
		yield* Stream.run(verified, Sink.mapError(fs.sink(partial, { flag: "wx" }), unwritable))
		if (received !== file.size) {
			return yield* mismatch(`Expected ${file.size} bytes and received ${received}.`)
		}
		if (hash.digest("hex") !== file.sha256) {
			return yield* mismatch("The SHA-256 digest differs from the file metadata.")
		}
		yield* fs
			.link(partial, target)
			.pipe(
				Effect.mapError((error) =>
					error.reason._tag === "AlreadyExists" ? targetExists() : unwritable(error),
				),
			)
		return received
	}).pipe(Effect.scoped)
