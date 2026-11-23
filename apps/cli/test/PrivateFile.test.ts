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
import { join } from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
	readIfPresent,
	removeIfPresent,
	restrictToOwner,
	writePrivate,
} from "../src/PrivateFile.ts"

const RealFiles = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, SecureRandom.layerWebCrypto)

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
