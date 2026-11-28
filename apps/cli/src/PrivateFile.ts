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

export const writePrivate = (
	file: string,
	contents: string,
): Effect.Effect<void, CliFailure, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = path.dirname(file)
		yield* Effect.scoped(
			Effect.gen(function* () {
				yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
				const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".checkfu-write-" })
				const temporary = path.join(staging, "value")
				yield* fs.writeFileString(temporary, contents, { flag: "wx", mode: 0o600 })
				yield* fs.rename(temporary, file)
			}),
		).pipe(Effect.mapError((error) => configError(`Could not write ${file}: ${error.message}`)))
	})
