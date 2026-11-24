import { describe, expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { MemoryIndexEntry } from "../src/Memory/MemoryIndex.view.ts"
import {
	MAX_MEMORIES_PER_STORE,
	MAX_MEMORY_PATH_LENGTH,
	MemoryPath,
} from "../src/Memory/MemoryTypes.ts"

// A view's state is stored as one row of a SQLite-backed Durable Object, which holds 2 MiB.
const ROW_LIMIT_BYTES = 2 * 1024 * 1024

const utf8Bytes = (value: string): number => {
	let bytes = 0
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code < 0x80) {
			bytes += 1
		} else if (code < 0x8_00) {
			bytes += 2
		} else if (code >= 0xd8_00 && code <= 0xdb_ff) {
			bytes += 4
			i++
		} else {
			bytes += 3
		}
	}
	return bytes
}

describe("memory index size", () => {
	it("keeps a full index of the widest paths a store admits well inside one stored row", () => {
		// Three UTF-8 bytes per UTF-16 unit is the most a path can take: control characters, the
		// only ones JSON writes longer, are not admitted.
		const path = `/${"€".repeat(MAX_MEMORY_PATH_LENGTH - 1)}`
		expect(Schema.is(MemoryPath)(path)).toBe(true)
		const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 24, 12, 0, 0, 123))
		const entry = {
			id: `mem_${"a".repeat(64)}`,
			path,
			content_sha256: "a".repeat(64),
			content_size_bytes: 100_000,
			created_at: at,
			updated_at: at,
		}
		const state = Schema.encodeSync(
			Schema.toCodecJson(Schema.Struct({ entries: Schema.Array(MemoryIndexEntry) })),
		)({ entries: Array.from({ length: MAX_MEMORIES_PER_STORE }, () => entry) } as never)
		const bytes = utf8Bytes(JSON.stringify(state))
		expect(bytes).toBeLessThan(ROW_LIMIT_BYTES * 0.6)
	})
})
