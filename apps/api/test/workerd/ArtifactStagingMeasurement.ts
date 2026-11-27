import type { ReadWriteBucketClient } from "@alchemy.run/cloudflare/R2"
import * as Effect from "effect/Effect"

const encoder = new TextEncoder()
const onlyIf = { etagDoesNotMatch: "*" }
const freshKey = () => `fixture-stage/${crypto.randomUUID()}`

export const qualifyConditionalPut = (bucket: ReadWriteBucketClient) =>
	Effect.gen(function* () {
		const key = freshKey()
		const invalid = freshKey()
		const sha256 = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new Uint8Array()))
		const options = { onlyIf, sha256, httpMetadata: { contentType: "application/octet-stream" } }
		const attempts = yield* Effect.all(
			[bucket.put<never>(key, "", options), bucket.put<never>(key, "", options)],
			{ concurrency: 2 },
		)
		const refused = yield* bucket.put(key, "replacement", {
			onlyIf,
			httpMetadata: { contentType: "text/plain" },
		})
		const stored = yield* bucket.get(key)
		const checksum = stored?.checksums.sha256
		const invalidChecksumFailed = yield* bucket
			.put(invalid, "different bytes", options)
			.pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "accepted" }))
		const invalidChecksumStored = (yield* bucket.head(invalid)) !== null
		const result = {
			created: attempts.filter((result) => result !== null).length,
			refused: attempts.filter((result) => result === null).length,
			duplicateRefused: refused === null,
			originalContent: stored === null ? null : yield* stored.text(),
			contentType: stored?.httpMetadata?.contentType,
			originalChecksum:
				checksum?.byteLength === sha256.byteLength &&
				new Uint8Array(checksum).every((byte, index) => byte === new Uint8Array(sha256)[index]),
			invalidChecksumFailed,
			invalidChecksumStored,
		}
		yield* bucket.delete([key, invalid])
		return result
	})

export const measureStaging = (
	bucket: ReadWriteBucketClient,
	files: number,
	distribution: "cold" | "mixed" | "warm",
	strategy: "head" | "conditional",
) =>
	Effect.gen(function* () {
		const prefix = freshKey()
		const entries = Array.from({ length: files }, (_, index) => ({
			path: `file-${index}.txt`,
			body: encoder.encode(String(index).padEnd(1024, "x")),
		}))
		const manifest = encoder.encode(JSON.stringify(entries.map(({ path }) => ({ path }))))
		const keys = [...entries, { path: "_manifest", body: manifest }].map(({ path, body }) => ({
			key: `${prefix}/${path}`,
			body,
		}))
		for (const [index, { key, body }] of keys.entries()) {
			if (
				distribution === "warm" ||
				(distribution === "mixed" && index % 2 === 0 && index < files)
			) {
				yield* bucket.put(key, body)
			}
		}
		let heads = 0
		let puts = 0
		let submitted = 0
		let created = 0
		const start = performance.now()
		for (const { key, body } of keys) {
			if (strategy === "head") {
				heads++
				if ((yield* bucket.head(key)) !== null) {
					continue
				}
			}
			puts++
			submitted += body.byteLength
			const result =
				strategy === "head"
					? yield* bucket.put(key, body)
					: yield* bucket.put(key, body, { onlyIf })
			if (result !== null) {
				created++
			}
		}
		const elapsedMs = performance.now() - start
		yield* bucket.delete(keys.map(({ key }) => key))
		return { files, distribution, strategy, heads, puts, submitted, created, elapsedMs }
	})
