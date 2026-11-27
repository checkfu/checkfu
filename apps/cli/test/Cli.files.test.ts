import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schedule from "effect/Schedule"
import { makeTestServer } from "./helpers/CliHarness.ts"
import type { CliRunResult } from "./helpers/CliHarness.ts"

interface Uploaded {
	readonly id: string
	readonly filename: string
	readonly content_type: string
	readonly size: number
}

describe("CLI files", () => {
	it.live(
		"uploads a local file, lists it, downloads the same bytes, and refuses to overwrite",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const root = yield* fs.makeTempDirectoryScoped()
					const cli = yield* makeTestServer()
					const run = (...args: Array<string>) =>
						cli.run(args, { fileSystem: NodeFileSystem.layer })
					const source = path.join(root, "report.csv")
					const data = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 31) % 251)
					yield* fs.writeFile(source, data)

					const uploaded = yield* run("files", "upload", source)
					expect(uploaded.stderr).toBe("")
					expect(uploaded.exitCode).toBe(0)
					const file = JSON.parse(uploaded.stdout) as Uploaded
					expect(file).toMatchObject({
						filename: "report.csv",
						content_type: "text/csv",
						size: 300_000,
					})

					const renamed = yield* run(
						"files",
						"upload",
						source,
						"--filename",
						"data.bin",
						"--content-type",
						"application/octet-stream",
					)
					expect(JSON.parse(renamed.stdout)).toMatchObject({
						filename: "data.bin",
						content_type: "application/octet-stream",
					})

					const second = (JSON.parse(renamed.stdout) as Uploaded).id
					const names = (result: CliRunResult) =>
						(JSON.parse(result.stdout) as { data: ReadonlyArray<Uploaded> }).data.map(
							(entry) => entry.filename,
						)
					const listed = yield* run("files", "list").pipe(
						Effect.repeat({
							schedule: Schedule.spaced("5 millis"),
							times: 200,
							until: (result) => result.stdout.includes(second),
						}),
					)
					expect(names(listed)).toEqual(["report.csv", "data.bin"])

					const target = path.join(root, "copy.csv")
					const downloaded = yield* run(
						"files",
						"download",
						"--file-id",
						file.id,
						"--output",
						target,
					)
					expect(downloaded.stderr).toBe("")
					expect(JSON.parse(downloaded.stdout)).toEqual({
						id: file.id,
						path: target,
						size: 300_000,
					})
					expect(new Uint8Array(yield* fs.readFile(target))).toEqual(data)

					const again = yield* run("files", "download", "--file-id", file.id, "--output", target)
					expect(again.exitCode).toBe(1)
					expect(again.errorMessage).toContain("already exists")

					const missing = yield* run("files", "upload", path.join(root, "absent.txt"))
					expect(missing.exitCode).toBe(1)
					expect(missing.errorMessage).toContain("no such file")

					expect((yield* run("files", "delete", "--file-id", file.id)).exitCode).toBe(0)
					expect(
						(yield* run("files", "download", "--file-id", file.id, "--output", target)).exitCode,
					).not.toBe(0)
				}),
			).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
		30_000,
	)
})
