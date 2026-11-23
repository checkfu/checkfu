import * as Config from "effect/Config"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { configError } from "./Errors.ts"
import type { CliFailure } from "./Errors.ts"
import { readIfPresent, removeIfPresent, writePrivate } from "./PrivateFile.ts"
import { COMMAND } from "./Standalone.ts"

export const SavedConnection = Schema.Struct({
	url: Schema.String,
	api_key: Schema.String,
})
export type SavedConnection = typeof SavedConnection.Type

const envDirectory = (name: string): Effect.Effect<Option.Option<string>> =>
	Config.option(Config.String(name)).pipe(
		Effect.map(Option.filter((value) => value.trim().length > 0)),
		Effect.orElseSucceed(() => Option.none()),
	)

const configDirectory: Effect.Effect<Option.Option<string>, CliFailure, Path.Path> = Effect.gen(
	function* () {
		const path = yield* Path.Path
		const explicit = yield* envDirectory("CHECKFU_CONFIG_DIR")
		if (Option.isSome(explicit)) {
			if (!path.isAbsolute(explicit.value)) {
				return yield* configError("CHECKFU_CONFIG_DIR must be an absolute path.")
			}
			return explicit
		}
		for (const [name, ...segments] of [
			["XDG_CONFIG_HOME", "checkfu"],
			["APPDATA", "checkfu"],
			["HOME", ".config", "checkfu"],
			["USERPROFILE", ".config", "checkfu"],
		] as const) {
			const base = yield* envDirectory(name)
			if (Option.isSome(base) && path.isAbsolute(base.value)) {
				return Option.some(path.join(base.value, ...segments))
			}
		}
		return Option.none()
	},
)

const store = <A>(fileName: string, schema: Schema.Codec<A, unknown>) => {
	const json = Schema.fromJsonString(schema, { space: "\t" })
	const file = Effect.gen(function* () {
		const path = yield* Path.Path
		return Option.map(yield* configDirectory, (directory) => path.join(directory, fileName))
	})
	const read: Effect.Effect<
		Option.Option<A>,
		CliFailure,
		FileSystem.FileSystem | Path.Path
	> = Effect.gen(function* () {
		const location = yield* file
		const contents = Option.isSome(location)
			? yield* readIfPresent(location.value)
			: Option.none<string>()
		if (Option.isNone(location) || Option.isNone(contents)) {
			return Option.none()
		}
		return yield* Schema.decodeEffect(json)(contents.value).pipe(
			Effect.mapBoth({
				onSuccess: Option.some,
				onFailure: () =>
					configError(
						`${location.value} is not valid. Fix or delete it, then run \`${COMMAND} login\`.`,
					),
			}),
		)
	})
	const write = (
		value: A,
	): Effect.Effect<
		string,
		CliFailure,
		FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
	> =>
		Effect.gen(function* () {
			const location = yield* file
			if (Option.isNone(location)) {
				return yield* configError(
					"Cannot locate a config directory. Set CHECKFU_CONFIG_DIR to an absolute path.",
				)
			}
			const contents = yield* Schema.encodeEffect(json)(value).pipe(Effect.orDie)
			yield* writePrivate(location.value, `${contents}\n`)
			return location.value
		})
	const remove: Effect.Effect<
		Option.Option<string>,
		CliFailure,
		FileSystem.FileSystem | Path.Path
	> = Effect.gen(function* () {
		const location = yield* file
		return Option.isSome(location) && (yield* removeIfPresent(location.value))
			? location
			: Option.none()
	})
	return { read, write, remove }
}

const connection = store("config.json", SavedConnection)

export const readSavedConnection = connection.read
export const writeSavedConnection = connection.write
export const removeSavedConnection = connection.remove
