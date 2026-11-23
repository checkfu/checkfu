import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as Option from "effect/Option"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { configError } from "./Errors.ts"
import type { CliFailure } from "./Errors.ts"

const isMissing = (error: PlatformError.PlatformError): boolean => error.reason._tag === "NotFound"

export const readIfPresent = (
	file: string,
): Effect.Effect<Option.Option<string>, CliFailure, FileSystem.FileSystem> =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.readFileString(file).pipe(
			Effect.asSome,
			Effect.catchIf(isMissing, () => Effect.succeedNone),
			Effect.mapError((error) => configError(`Could not read ${file}: ${error.message}`)),
		),
	)

export const removeIfPresent = (
	file: string,
): Effect.Effect<boolean, CliFailure, FileSystem.FileSystem> =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.remove(file).pipe(
			Effect.as(true),
			Effect.catchIf(isMissing, () => Effect.succeed(false)),
			Effect.mapError((error) => configError(`Could not remove ${file}: ${error.message}`)),
		),
	)

/**
 * Makes an existing file readable and writable by its owner only. That is POSIX
 * permissions: on Windows the mode is ignored and the file keeps the access control
 * of its directory, so it is as private as the user profile or checkout it lives in.
 */
export const restrictToOwner = (
	file: string,
): Effect.Effect<void, CliFailure, FileSystem.FileSystem> =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs
			.chmod(file, 0o600)
			.pipe(
				Effect.mapError((error) =>
					configError(`Could not restrict ${file} to its owner: ${error.message}`),
				),
			),
	)

/**
 * Replaces `file` with an owner-only copy in one step: the contents are written to a
 * new 0600 file beside it and renamed over it, so they never sit in a file that
 * another local user can read and a crash never leaves a half-written file behind.
 */
export const writePrivate = (
	file: string,
	contents: string,
): Effect.Effect<void, CliFailure, FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const random = yield* SecureRandom.SecureRandom
		const suffix = Array.from(yield* random.randomBytes(6), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("")
		const temporary = `${file}.${suffix}.tmp`
		yield* Effect.gen(function* () {
			yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })
			yield* fs.writeFileString(temporary, contents, { flag: "wx", mode: 0o600 })
			yield* fs.rename(temporary, file)
		}).pipe(
			Effect.onError(() => Effect.ignore(fs.remove(temporary))),
			Effect.mapError((error) => configError(`Could not write ${file}: ${error.message}`)),
		)
	})
