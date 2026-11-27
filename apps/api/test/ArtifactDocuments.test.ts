import { describe, expect, it } from "@effect/vitest"
import {
	MAX_ARTIFACT_COLLECTION_DOCUMENTS,
	MAX_ARTIFACT_DATABASE_BYTES,
	MAX_ARTIFACT_DOCUMENT_BYTES,
} from "@checkfu/sdk/Limits"
import { MAX_ARTIFACT_COLLECTIONS } from "@checkfu/sdk/Schemas"
import { makeDocumentsSqlite } from "../src/ArtifactData/ArtifactDatabaseMemory.ts"
import { makeArtifactDocuments } from "../src/ArtifactData/ArtifactDocuments.ts"

const database = () => {
	const sqlite = makeDocumentsSqlite()
	return { ...sqlite, documents: makeArtifactDocuments(sqlite.sql) }
}

const body = (value: unknown) => JSON.stringify(value)

const sized = (bytes: number) => `"${"x".repeat(bytes - 2)}"`

describe("An artifact's documents", () => {
	it("lists a collection oldest first, in pages, and keeps collections apart", () => {
		const { documents } = database()
		for (let index = 1; index <= 5; index += 1) {
			expect(
				documents.write("votes", `v${index}`, body({ index }), "create", index * 10),
			).toMatchObject({
				refused: null,
				created: true,
			})
		}
		documents.write("settings", "theme", body("dark"), "create", 60)

		const first = documents.list("votes", 0, 2)
		expect(first.documents.map((document) => document.id)).toEqual(["v1", "v2"])
		expect(first.next).not.toBeNull()
		const second = documents.list("votes", first.next ?? 0, 2)
		expect(second.documents.map((document) => document.id)).toEqual(["v3", "v4"])
		const last = documents.list("votes", second.next ?? 0, 2)
		expect(last.documents.map((document) => document.id)).toEqual(["v5"])
		expect(last.next).toBeNull()
		expect(documents.list("votes", 0, 5).next).toBeNull()

		expect(documents.get("votes", "v3")).toMatchObject({ body: body({ index: 3 }), created_at: 30 })
		expect(documents.get("settings", "v3")).toBeNull()
		expect(documents.get("votes", "theme")).toBeNull()
		expect(documents.usage()).toEqual({
			collections: [
				{ collection: "settings", documents: 1, bytes: 6 },
				{ collection: "votes", documents: 5, bytes: 5 * body({ index: 1 }).length },
			],
			bytes: 6 + 5 * body({ index: 1 }).length,
		})
	})

	it("replaces a document in place, keeping when it was made and where it sorts", () => {
		const { documents } = database()
		documents.write("notes", "a", body("first"), "create", 1)
		documents.write("notes", "b", body("second"), "create", 2)
		expect(documents.write("notes", "a", body("first, edited"), "replace", 3)).toMatchObject({
			refused: null,
			created: false,
			document: { id: "a", created_at: 1, updated_at: 3, body: body("first, edited") },
		})
		expect(documents.list("notes", 0, 10).documents.map((document) => document.id)).toEqual([
			"a",
			"b",
		])
		expect(documents.usage().bytes).toBe(body("first, edited").length + body("second").length)
		expect(documents.write("notes", "c", body("third"), "replace", 4)).toMatchObject({
			created: true,
		})
	})

	it("refuses to add a document under an id that is taken, and changes nothing", () => {
		const { documents } = database()
		documents.write("notes", "a", body("kept"), "create", 1)
		expect(documents.write("notes", "a", body("other"), "create", 2)).toEqual({ refused: "exists" })
		expect(documents.get("notes", "a")).toMatchObject({ body: body("kept"), updated_at: 1 })
	})

	it("counts multi-byte text by its encoded size", () => {
		const { documents } = database()
		const text = body("é".repeat(10))
		expect(documents.write("notes", "a", text, "create", 1)).toMatchObject({
			document: { size: 22 },
		})
		expect(documents.usage().bytes).toBe(22)
		const wide = `"${"é".repeat(MAX_ARTIFACT_DOCUMENT_BYTES / 2)}"`
		expect(wide.length).toBeLessThan(MAX_ARTIFACT_DOCUMENT_BYTES)
		expect(documents.write("notes", "b", wide, "create", 2)).toEqual({ refused: "too_large" })
	})

	it("holds each document, collection and database to its limit", () => {
		const { documents } = database()
		expect(
			documents.write("a", "fits", sized(MAX_ARTIFACT_DOCUMENT_BYTES), "create", 1),
		).toMatchObject({ refused: null })
		expect(
			documents.write("a", "over", sized(MAX_ARTIFACT_DOCUMENT_BYTES + 1), "create", 1),
		).toEqual({ refused: "too_large" })
		documents.remove("a", "fits")

		for (let index = 0; index < MAX_ARTIFACT_COLLECTIONS; index += 1) {
			expect(documents.write(`c${index}`, "only", "1", "create", 1)).toMatchObject({
				refused: null,
			})
		}
		expect(documents.write("one-more", "only", "1", "create", 1)).toEqual({
			refused: "collections",
		})
		expect(documents.write("c0", "second", "1", "create", 1)).toMatchObject({ refused: null })
		expect(documents.remove("c1", "only")).toBe(true)
		expect(documents.write("one-more", "only", "1", "create", 1)).toMatchObject({ refused: null })

		for (let index = 2; index < MAX_ARTIFACT_COLLECTION_DOCUMENTS; index += 1) {
			documents.write("c0", `d${index}`, "1", "create", 1)
		}
		expect(documents.usage().collections[0]).toMatchObject({
			collection: "c0",
			documents: MAX_ARTIFACT_COLLECTION_DOCUMENTS,
		})
		expect(documents.write("c0", "over", "1", "create", 1)).toEqual({ refused: "documents" })
		expect(documents.write("c0", "only", "2", "replace", 2)).toMatchObject({ created: false })
	})

	it("refuses a write that would take the database past its size, and allows it once room is made", () => {
		const { documents } = database()
		const full = MAX_ARTIFACT_DATABASE_BYTES / MAX_ARTIFACT_DOCUMENT_BYTES
		const large = sized(MAX_ARTIFACT_DOCUMENT_BYTES)
		for (let index = 0; index < full; index += 1) {
			documents.write("blobs", `b${index}`, large, "create", 1)
		}
		expect(documents.usage().bytes).toBe(MAX_ARTIFACT_DATABASE_BYTES)
		expect(documents.write("blobs", "over", "1", "create", 2)).toEqual({ refused: "bytes" })
		expect(documents.write("blobs", "b0", large, "replace", 2)).toMatchObject({ refused: null })
		expect(documents.write("blobs", "b0", "1", "replace", 3)).toMatchObject({ refused: null })
		expect(documents.write("blobs", "over", "1", "create", 4)).toMatchObject({ refused: null })
		expect(documents.usage().bytes).toBe(MAX_ARTIFACT_DATABASE_BYTES - large.length + 2)
	})

	it("keeps its byte count equal to what it holds through any mix of writes and removals", () => {
		const { documents } = database()
		let seed = 7
		const next = (below: number) => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
			return seed % below
		}
		for (let step = 0; step < 2000; step += 1) {
			const collection = `c${next(4)}`
			const id = `d${next(12)}`
			const action = next(4)
			if (action === 0) {
				documents.remove(collection, id)
			} else {
				documents.write(
					collection,
					id,
					sized(2 + next(300)),
					action === 1 ? "create" : "replace",
					step,
				)
			}
		}
		const usage = documents.usage()
		expect(usage.bytes).toBe(usage.collections.reduce((sum, entry) => sum + entry.bytes, 0))
		const held = usage.collections.flatMap(({ collection }) =>
			documents.list(collection, 0, 100).documents.map((document) => document.size),
		)
		expect(usage.bytes).toBe(held.reduce((sum, size) => sum + size, 0))
	})

	it("stopped partway through a write or a removal, changes nothing", () => {
		const { documents, failAt } = database()
		documents.write("notes", "a", body("kept"), "create", 1)
		const before = documents.usage()

		failAt("UPDATE totals")
		expect(() => documents.write("notes", "b", body("lost"), "create", 2)).toThrow("stopped at")
		expect(documents.get("notes", "b")).toBeNull()
		expect(documents.usage()).toEqual(before)

		failAt("UPDATE totals")
		expect(() => documents.remove("notes", "a")).toThrow("stopped at")
		expect(documents.get("notes", "a")).toMatchObject({ body: body("kept") })
		expect(documents.usage()).toEqual(before)

		expect(documents.write("notes", "b", body("second"), "create", 3)).toMatchObject({
			document: { seq: 2 },
		})
	})

	it("once erased, holds nothing and refuses every later write", () => {
		const { documents, failAt } = database()
		documents.write("votes", "a", "1", "create", 1)
		documents.write("notes", "b", "2", "create", 1)

		failAt("UPDATE totals")
		expect(() => documents.erase()).toThrow("stopped at")
		expect(documents.get("votes", "a")).not.toBeNull()

		documents.erase()
		documents.erase()
		expect(documents.get("votes", "a")).toBeNull()
		expect(documents.list("votes", 0, 10)).toEqual({ documents: [], next: null })
		expect(documents.usage()).toEqual({ collections: [], bytes: 0 })
		expect(documents.remove("votes", "a")).toBe(false)
		expect(documents.write("votes", "a", "1", "create", 2)).toEqual({ refused: "erased" })
		expect(documents.write("votes", "a", "1", "replace", 2)).toEqual({ refused: "erased" })
	})

	it("opened again over the same storage, finds what it held", () => {
		const sqlite = makeDocumentsSqlite()
		makeArtifactDocuments(sqlite.sql).write("notes", "a", body("kept"), "create", 1)
		const reopened = makeArtifactDocuments(sqlite.sql)
		expect(reopened.get("notes", "a")).toMatchObject({ body: body("kept") })
		expect(reopened.write("notes", "b", body("next"), "create", 2)).toMatchObject({
			document: { seq: 2 },
		})
		reopened.erase()
		expect(makeArtifactDocuments(sqlite.sql).write("notes", "c", "1", "create", 3)).toEqual({
			refused: "erased",
		})
	})
})
