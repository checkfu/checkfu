import {
	formatProjectLockfile,
	projectLockfileName,
	ProjectLockfile,
} from "@checkfu/authoring/lockfile"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { usageError } from "../Errors.ts"
import { readIfPresent, writePrivate } from "../PrivateFile.ts"
import { fileType } from "./Source.ts"

export const locateLockfile = (override: Option.Option<string>) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		if (Option.isSome(override)) {
			return path.resolve(override.value)
		}
		const cwd = path.resolve(".")
		let directory = cwd
		for (;;) {
			const file = path.join(directory, projectLockfileName)
			if ((yield* fileType(file)) !== undefined) {
				return file
			}
			const parent = path.dirname(directory)
			if (parent === directory) {
				return path.join(cwd, projectLockfileName)
			}
			directory = parent
		}
	})

export const readLockfile = (file: string) =>
	Effect.gen(function* () {
		const type = yield* fileType(file)
		if (type === undefined) {
			return undefined
		}
		if (type !== "File") {
			return yield* usageError(`${file}: expected a regular project lockfile.`)
		}
		const contents = yield* readIfPresent(file)
		if (Option.isNone(contents)) {
			return yield* usageError(`${file}: the project lockfile disappeared during the read.`)
		}
		return yield* Schema.decodeEffect(ProjectLockfile)(contents.value, {
			onExcessProperty: "error",
		}).pipe(
			Effect.mapError((error) =>
				usageError(`${file}: invalid lockfile for this version of Checkfu. ${error.message}`),
			),
		)
	})

export const writeLockfile = (file: string, state: ProjectLockfile) =>
	writePrivate(file, formatProjectLockfile(state))

export const withProjectLock = <A, E, R>(file: string, run: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const mutex = `${file}.apply-lock`
		yield* fs
			.makeDirectory(path.dirname(file), { recursive: true })
			.pipe(
				Effect.mapError((error) =>
					usageError(`Could not create the project lockfile directory: ${error.message}`),
				),
			)
		return yield* Effect.acquireUseRelease(
			fs
				.writeFileString(mutex, "", { flag: "wx", mode: 0o600 })
				.pipe(
					Effect.mapError((error) =>
						error.reason._tag === "AlreadyExists"
							? usageError(
									`Another apply holds ${mutex}. If that process has exited, remove the empty lock file and retry.`,
								)
							: usageError(`Could not acquire ${mutex}: ${error.message}`),
					),
				),
			() => run,
			() =>
				fs
					.remove(mutex, { force: true })
					.pipe(
						Effect.mapError((error) => usageError(`Could not release ${mutex}: ${error.message}`)),
					),
		)
	})
