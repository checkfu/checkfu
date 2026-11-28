import { USAGE_EXIT_CODE } from "../src/Errors.ts"
import { writeFile } from "node:fs/promises"
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
	it.live("publishes only downloads that match the stored size and SHA-256", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const root = yield* fs.makeTempDirectoryScoped()
				const cli = yield* makeTestServer()
				const source = path.join(root, "source.bin")
				const target = path.join(root, "copy.bin")
				const original = Uint8Array.of(0, 30, 180, 255)
				yield* fs.writeFile(source, original)
				const options = { fileSystem: NodeFileSystem.layer }
				const upload = yield* cli.run(["files", "upload", source], options)
				expect(upload.exitCode).toBe(0)
				const { id } = JSON.parse(upload.stdout) as Uploaded
				const download = (fileId: string) => [
					"files",
					"download",
					"--file-id",
					fileId,
					"--output",
					target,
				]

				for (const [chunks, diagnostic] of [
					[[original.subarray(0, 3)], "Expected 4 bytes and received 3"],
					[[original, Uint8Array.of(1), Uint8Array.of(2)], "exceeds the expected 4 bytes"],
					[[Uint8Array.of(1, 30, 180, 255)], "SHA-256 digest differs"],
				] as const) {
					let pulls = 0
					let cancelled = false
					const corrupt = yield* cli.run(download(id), {
						...options,
						interceptFetch: (next, request) =>
							request.url.endsWith("/content")
								? Promise.resolve(
										new Response(
											new ReadableStream<Uint8Array>(
												{
													pull(controller) {
														const chunk = chunks[pulls]
														pulls += 1
														if (chunk === undefined) {
															controller.close()
														} else {
															controller.enqueue(chunk)
														}
													},
													cancel() {
														cancelled = true
													},
												},
												{ highWaterMark: 0 },
											),
											{ headers: { "content-type": "application/octet-stream" } },
										),
									)
								: next(request),
					})
					expect(corrupt.exitCode).toBe(USAGE_EXIT_CODE)
					expect(corrupt.errorMessage).toContain("failed integrity verification")
					expect(corrupt.errorMessage).toContain(diagnostic)
					expect(yield* fs.readDirectory(root)).toEqual(["source.bin"])
					if (chunks.length > 1) {
						expect(pulls).toBe(2)
						expect(cancelled).toBe(true)
					}
				}

				yield* fs.writeFile(source, new Uint8Array())
				const empty = yield* cli.run(["files", "upload", source], options)
				expect(empty.exitCode).toBe(0)
				const { id: emptyId } = JSON.parse(empty.stdout) as Uploaded
				const result = yield* cli.run(download(emptyId), options)
				expect(result.exitCode).toBe(0)
				expect(JSON.parse(result.stdout)).toEqual({ id: emptyId, path: target, size: 0 })
				expect(yield* fs.readFile(target)).toHaveLength(0)
				expect((yield* fs.readDirectory(root)).sort()).toEqual(["copy.bin", "source.bin"])
			}),
		).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
	)

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
					expect(again.exitCode).toBe(USAGE_EXIT_CODE)
					expect(again.errorMessage).toContain("already exists")

					const raced = path.join(root, "raced.csv")
					const racedDownload = yield* cli.run(
						["files", "download", "--file-id", file.id, "--output", raced],
						{
							fileSystem: NodeFileSystem.layer,
							interceptFetch: async (next, request) => {
								if (request.url.endsWith("/content")) {
									await writeFile(raced, "another writer")
								}
								return next(request)
							},
						},
					)
					expect(racedDownload.exitCode).toBe(USAGE_EXIT_CODE)
					expect(racedDownload.errorMessage).toContain("already exists")
					expect(yield* fs.readFileString(raced)).toBe("another writer")
					yield* fs.remove(raced)

					const cut = yield* cli.run(
						["files", "download", "--file-id", file.id, "--output", path.join(root, "cut.csv")],
						{
							fileSystem: NodeFileSystem.layer,
							interceptFetch: async (next, request) => {
								const response = await next(request)
								if (!request.url.endsWith("/content")) {
									return response
								}
								const reader = response.body?.getReader()
								let sent = false
								return new Response(
									new ReadableStream<Uint8Array>({
										pull: async (controller) => {
											if (sent) {
												controller.error(new Error("connection lost"))
												return
											}
											sent = true
											const chunk = await reader?.read()
											controller.enqueue(chunk?.value?.slice(0, 10) ?? new Uint8Array(1))
										},
									}),
									{ status: response.status, headers: response.headers },
								)
							},
						},
					)
					expect(cut.exitCode).not.toBe(0)
					expect(yield* fs.readDirectory(root)).toEqual(["copy.csv", "report.csv"])

					const physical = path.join(root, "physical")
					const child = path.join(physical, "child")
					const alias = path.join(root, "alias")
					yield* fs.makeDirectory(child, { recursive: true })
					yield* fs.symlink(child, alias)
					const throughAlias = `${alias}${path.sep}..${path.sep}copy.csv`
					const sameParent = Layer.succeed(FileSystem.FileSystem, {
						...fs,
						link: (partial, target) => {
							const directory = path.basename(path.dirname(partial))
							const adjacent = path.join(physical, directory, path.basename(partial))
							return fs.stat(adjacent).pipe(Effect.andThen(fs.link(partial, target)))
						},
					})
					const aliased = yield* cli.run(
						["files", "download", "--file-id", file.id, "--output", throughAlias],
						{ fileSystem: sameParent },
					)
					expect(aliased.stderr).toBe("")
					expect(new Uint8Array(yield* fs.readFile(path.join(physical, "copy.csv")))).toEqual(data)
					expect((yield* fs.readDirectory(physical)).sort()).toEqual(["child", "copy.csv"])

					const missing = yield* run("files", "upload", path.join(root, "absent.txt"))
					expect(missing.exitCode).toBe(USAGE_EXIT_CODE)
					expect(missing.errorMessage).toContain("no such file")

					for (const [length, change] of [
						[data.byteLength + 1, "grew"],
						[data.byteLength - 1, "shrank"],
						[0, "shrank"],
					] as const) {
						yield* fs.writeFile(source, data)
						const changing = Layer.succeed(FileSystem.FileSystem, {
							...fs,
							stat: (filePath) =>
								fs
									.stat(filePath)
									.pipe(
										Effect.tap(() =>
											filePath === source
												? fs.writeFile(source, new Uint8Array(length))
												: Effect.void,
										),
									),
						})
						const result = yield* cli.run(["files", "upload", source], {
							fileSystem: changing,
							interceptFetch: (next, request) => {
								expect(request.method).not.toBe("POST")
								return next(request)
							},
						})
						expect(result.exitCode).toBe(USAGE_EXIT_CODE)
						expect(result.errorMessage).toContain(`${change} while it was being read`)
					}
					expect((yield* run("files", "upload", source)).exitCode).toBe(0)

					expect((yield* run("files", "delete", "--file-id", file.id)).exitCode).toBe(0)
					expect(
						(yield* run("files", "download", "--file-id", file.id, "--output", target)).exitCode,
					).not.toBe(0)
				}),
			).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
		30_000,
	)
})
