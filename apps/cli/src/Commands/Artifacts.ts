import { ArtifactId, ArtifactPath, PositiveInt } from "@checkfu/sdk/Schemas"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { apiFailure, formatClientError } from "../Errors.ts"
import { getClient, renderOutput } from "../RootCommand.ts"
import { downloadTo } from "./Download.ts"

export const artifactsDownloadCommand = Command.make(
	"download",
	{
		artifactId: Flag.String("artifact-id").pipe(
			Flag.withSchema(ArtifactId),
			Flag.withMetavar("ID"),
			Flag.withDescription("The artifact whose file to download"),
		),
		file: Flag.String("file").pipe(
			Flag.withSchema(ArtifactPath),
			Flag.withMetavar("PATH"),
			Flag.withDescription("Path of the file inside the artifact version"),
		),
		version: Flag.Int("at-version").pipe(
			Flag.withSchema(PositiveInt),
			Flag.withMetavar("N"),
			Flag.withDescription("Version to download from (default: the current version)"),
			Flag.optional,
		),
		output: Flag.String("output").pipe(
			Flag.withAlias("o"),
			Flag.withMetavar("PATH"),
			Flag.withDescription("Where to write it (default: the file's name, in this directory)"),
			Flag.optional,
		),
	},
	({ artifactId: artifact_id, file: queryPath, version: atVersion, output }) =>
		Effect.gen(function* () {
			const client = yield* getClient
			const metadata = Option.isSome(atVersion)
				? yield* client.api.artifacts
						.getVersion({ params: { artifact_id, version: atVersion.value } })
						.pipe(Effect.mapError(formatClientError))
				: yield* client.api.artifacts
						.get({ params: { artifact_id } })
						.pipe(Effect.mapError(formatClientError))
			const { version } = metadata
			const file = metadata.files.find((entry) => entry.path === queryPath)
			if (file === undefined) {
				return yield* apiFailure(
					404,
					"not_found_error",
					`Artifact ${artifact_id} version ${version} has no file "${queryPath}".`,
				)
			}
			const target = Option.getOrElse(output, () => file.path.slice(file.path.lastIndexOf("/") + 1))
			const size = yield* downloadTo(
				target,
				file,
				client.api.artifacts.getFileContent({
					params: { artifact_id, version },
					query: { file: file.path },
				}),
			)
			yield* renderOutput({ artifact_id, version, file: file.path, path: target, size })
		}),
).pipe(Command.withDescription("Download an artifact version's file to a local path"))
