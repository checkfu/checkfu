import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Option from "effect/Option"
import {
	readIfPresent,
	removeIfPresent,
	restrictToOwner,
	writePrivate,
} from "../src/PrivateFile.ts"

const RealFiles = Layer.merge(NodeFileSystem.layer, NodePath.layer)

describe("private files", () => {
	it.live("replaces a world-readable file with an owner-only one and leaves nothing behind", () =>
		Effect.gen(function* () {
			const directory = mkdtempSync(join(tmpdir(), "checkfu-private-"))
			const file = join(directory, ".env")
			try {
				writeFileSync(file, "OLD=1\n")
				chmodSync(file, 0o644)

				yield* writePrivate(file, "SECRET=2\n")

				expect(readFileSync(file, "utf8")).toBe("SECRET=2\n")
				expect(readdirSync(directory)).toEqual([".env"])
				if (process.platform !== "win32") {
					expect(statSync(file).mode & 0o777).toBe(0o600)
				}

				chmodSync(file, 0o644)
				yield* restrictToOwner(file)
				if (process.platform !== "win32") {
					expect(statSync(file).mode & 0o777).toBe(0o600)
				}

				expect(yield* readIfPresent(file)).toEqual(Option.some("SECRET=2\n"))
				expect(yield* removeIfPresent(file)).toBe(true)
				expect(yield* removeIfPresent(file)).toBe(false)
				expect(yield* readIfPresent(file)).toEqual(Option.none())
			} finally {
				rmSync(directory, { recursive: true, force: true })
			}
		}).pipe(Effect.provide(RealFiles)),
	)

	it.live("replaces long destinations atomically and preserves unrelated staging directories", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const foreign = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".checkfu-write-" })
				const sentinel = join(foreign, "value")
				yield* fs.writeFileString(sentinel, "another writer")
				const destinations = ["x".repeat(240), "x".repeat(230) + "é".repeat(10)]
				yield* Effect.forEach(
					destinations,
					(name) => {
						const file = join(directory, name)
						return fs.writeFileString(file, "old").pipe(Effect.andThen(writePrivate(file, name)))
					},
					{ concurrency: "unbounded" },
				)
				for (const name of destinations) {
					const file = join(directory, name)
					expect(yield* fs.readFileString(file)).toBe(name)
					if (process.platform !== "win32") {
						expect(statSync(file).mode & 0o777).toBe(0o600)
					}
				}
				expect(yield* fs.readFileString(sentinel)).toBe("another writer")
				expect((yield* fs.readDirectory(directory)).toSorted((a, b) => a.localeCompare(b))).toEqual(
					[...destinations, basename(foreign)].toSorted((a, b) => a.localeCompare(b)),
				)
			}),
		).pipe(Effect.provide(RealFiles)),
	)

	it.live.each(["reserve", "write", "rename"] as const)(
		"preserves the destination and other reservations when %s fails",
		(phase) =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const parent = yield* fs.makeTempDirectoryScoped()
					const own = join(parent, "private")
					const other = join(parent, ".checkfu-write-foreign")
					const sentinel = join(other, "value")
					yield* fs.makeDirectory(other)
					yield* fs.writeFileString(sentinel, "foreign")
					yield* fs.writeFileString(own, "unchanged")
					const failure = Effect.fail(
						PlatformError.systemError({
							_tag: "AlreadyExists",
							module: "FileSystem",
							method: phase,
							description: "injected staging fault",
						}),
					)
					const faulty = {
						...fs,
						makeTempDirectoryScoped:
							phase === "reserve" ? () => failure : fs.makeTempDirectoryScoped,
						writeFileString:
							phase === "write"
								? (path: string) =>
										fs.writeFileString(path, "partial").pipe(Effect.andThen(failure))
								: fs.writeFileString,
						rename: phase === "rename" ? () => failure : fs.rename,
					}
					const error = yield* Effect.flip(
						writePrivate(own, "new").pipe(Effect.provideService(FileSystem.FileSystem, faulty)),
					)
					expect(error.message).toContain("injected staging fault")
					expect(yield* fs.readFileString(own)).toBe("unchanged")
					expect(yield* fs.readFileString(sentinel)).toBe("foreign")
					expect((yield* fs.readDirectory(parent)).toSorted((a, b) => a.localeCompare(b))).toEqual([
						".checkfu-write-foreign",
						"private",
					])
				}),
			).pipe(Effect.provide(RealFiles)),
	)

	it.live.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"reports a file it cannot read instead of treating it as absent",
		() =>
			Effect.gen(function* () {
				const directory = mkdtempSync(join(tmpdir(), "checkfu-private-"))
				const file = join(directory, "config.json")
				try {
					writeFileSync(file, "{}")
					chmodSync(file, 0o000)
					const failure = yield* Effect.flip(readIfPresent(file))
					expect(failure.message).toContain(`Could not read ${file}`)
				} finally {
					rmSync(directory, { recursive: true, force: true })
				}
			}).pipe(Effect.provide(RealFiles)),
	)
})
