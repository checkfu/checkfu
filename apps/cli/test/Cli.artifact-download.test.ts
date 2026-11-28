import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { makeTestServer } from "./helpers/CliHarness.ts"

it.live(
	"streams verified artifact files past the JSON limit, including from an older version",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const cli = yield* makeTestServer()
				const root = yield* fs.makeTempDirectoryScoped()
				const run = (...args: ReadonlyArray<string>) =>
					cli.run(args, { fileSystem: NodeFileSystem.layer })
				const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251)
				const source = path.join(root, "source.bin")
				const older = path.join(root, "older.bin")
				const latest = path.join(root, "latest.bin")
				const file = "data/large #1.bin"
				yield* fs.writeFile(source, bytes)
				const upload = yield* run("files", "upload", source)
				expect(upload.exitCode, upload.stderr).toBe(0)
				const { id: file_id } = JSON.parse(upload.stdout) as { id: string }
				const created = yield* run(
					"artifacts",
					"create",
					"--name",
					"Large download",
					"--file",
					JSON.stringify({ path: file, file_id }),
				)
				expect(created.exitCode, created.stderr).toBe(0)
				const { id: artifact_id } = JSON.parse(created.stdout) as { id: string }
				const updated = yield* run(
					"artifacts:versions",
					"create",
					"--artifact-id",
					artifact_id,
					"--current-version",
					"1",
					"--file",
					JSON.stringify({ path: file, content: "replacement" }),
				)
				expect(updated.exitCode, updated.stderr).toBe(0)

				const download = (target: string, name = file, ...version: ReadonlyArray<string>) =>
					run(
						"artifacts",
						"download",
						"--artifact-id",
						artifact_id,
						"--file",
						name,
						"-o",
						target,
						...version,
					)
				const old = yield* download(older, file, "--at-version", "1")
				expect(old.exitCode, old.stderr).toBe(0)
				expect(JSON.parse(old.stdout)).toEqual({
					artifact_id,
					version: 1,
					file,
					path: older,
					size: bytes.length,
				})
				expect(Buffer.compare(yield* fs.readFile(older), bytes)).toBe(0)

				const current = yield* download(latest)
				expect(current.exitCode, current.stderr).toBe(0)
				expect(JSON.parse(current.stdout)).toEqual({
					artifact_id,
					version: 2,
					file,
					path: latest,
					size: 11,
				})
				expect(yield* fs.readFileString(latest)).toBe("replacement")

				const exists = yield* download(older)
				expect(exists.errorMessage).toContain("already exists")
				expect(Buffer.compare(yield* fs.readFile(older), bytes)).toBe(0)
				const absent = yield* download(path.join(root, "absent"), "missing.bin")
				expect(absent.errorMessage).toContain("API error (404 not_found_error)")
				expect(absent.errorMessage).toContain('version 2 has no file "missing.bin"')
				expect((yield* fs.readDirectory(root)).toSorted()).toEqual([
					"latest.bin",
					"older.bin",
					"source.bin",
				])
			}),
		).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
)
