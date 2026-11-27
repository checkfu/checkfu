import {
	MAX_ARTIFACT_COLLECTION_DOCUMENTS,
	MAX_ARTIFACT_DATABASE_BYTES,
	MAX_ARTIFACT_DOCUMENT_BYTES,
} from "@checkfu/sdk/Limits"
import { MAX_ARTIFACT_COLLECTIONS } from "@checkfu/sdk/Schemas"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const DOCUMENT_TABLES = {
	documents:
		"CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (collection, id))",
	order: "CREATE INDEX IF NOT EXISTS documents_in_order ON documents (collection, seq)",
	totals:
		"CREATE TABLE IF NOT EXISTS totals (id INTEGER PRIMARY KEY CHECK (id = 1), next_seq INTEGER NOT NULL, bytes INTEGER NOT NULL, erased INTEGER NOT NULL)",
} as const

export interface DocumentsSql {
	readonly exec: (
		query: string,
		...bindings: ReadonlyArray<string | number | null>
	) => Iterable<object>
	readonly transaction: <A>(run: () => A) => A
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const StoredDocument = Schema.Struct({
	id: Schema.String,
	seq: Count,
	body: Schema.String,
	size: Count,
	created_at: Count,
	updated_at: Count,
})
export type StoredDocument = typeof StoredDocument.Type

export const WriteMode = Schema.Literals(["create", "replace"])
export type WriteMode = typeof WriteMode.Type

export const WriteRefusal = Schema.Literals([
	"erased",
	"exists",
	"too_large",
	"collections",
	"documents",
	"bytes",
])
export type WriteRefusal = typeof WriteRefusal.Type

export const WriteOutcome = Schema.Union([
	Schema.Struct({
		refused: Schema.Null,
		document: StoredDocument,
		created: Schema.Boolean,
	}),
	Schema.Struct({ refused: WriteRefusal }),
])
export type WriteOutcome = typeof WriteOutcome.Type

export const DocumentPage = Schema.Struct({
	documents: Schema.Array(StoredDocument),
	next: Schema.NullOr(Count),
})
export type DocumentPage = typeof DocumentPage.Type

export const CollectionUsage = Schema.Struct({
	collection: Schema.String,
	documents: Count,
	bytes: Count,
})

export const DatabaseUsage = Schema.Struct({
	collections: Schema.Array(CollectionUsage),
	bytes: Count,
})
export type DatabaseUsage = typeof DatabaseUsage.Type

const Totals = Schema.Struct({ next_seq: Count, bytes: Count, erased: Count })
const Counted = Schema.Struct({ n: Count })

const decodeDocument = Schema.decodeUnknownOption(StoredDocument)
const decodeTotals = Schema.decodeUnknownOption(Totals)
const decodeCounted = Schema.decodeUnknownOption(Counted)
const decodeUsage = Schema.decodeUnknownOption(CollectionUsage)

const utf8Encoder = new TextEncoder()

const COLUMNS = "id, seq, body, size, created_at, updated_at"

export const makeArtifactDocuments = (sql: DocumentsSql) => {
	for (const table of Object.values(DOCUMENT_TABLES)) {
		sql.exec(table)
	}
	sql.exec("INSERT OR IGNORE INTO totals (id, next_seq, bytes, erased) VALUES (1, 1, 0, 0)")

	const first = (query: string, ...bindings: ReadonlyArray<string | number>) => {
		for (const row of sql.exec(query, ...bindings)) {
			return row
		}
		return undefined
	}
	const count = (query: string, ...bindings: ReadonlyArray<string | number>): number =>
		Option.getOrThrow(decodeCounted(first(query, ...bindings))).n
	const totals = () =>
		Option.getOrThrow(decodeTotals(first("SELECT next_seq, bytes, erased FROM totals")))
	const held = (collection: string, id: string) =>
		Option.getOrNull(
			decodeDocument(
				first(`SELECT ${COLUMNS} FROM documents WHERE collection = ? AND id = ?`, collection, id),
			),
		)

	return {
		get: (collection: string, id: string): StoredDocument | null =>
			totals().erased === 1 ? null : held(collection, id),

		list: (collection: string, after: number, limit: number): DocumentPage => {
			if (totals().erased === 1) {
				return { documents: [], next: null }
			}
			const rows = Array.from(
				sql.exec(
					`SELECT ${COLUMNS} FROM documents WHERE collection = ? AND seq > ? ORDER BY seq LIMIT ?`,
					collection,
					after,
					limit + 1,
				),
				(row) => Option.getOrThrow(decodeDocument(row)),
			)
			const documents = rows.slice(0, limit)
			return {
				documents,
				next: rows.length > limit ? (documents.at(-1)?.seq ?? null) : null,
			}
		},

		write: (
			collection: string,
			id: string,
			body: string,
			mode: WriteMode,
			now: number,
		): WriteOutcome =>
			sql.transaction((): WriteOutcome => {
				const size = utf8Encoder.encode(body).byteLength
				if (size > MAX_ARTIFACT_DOCUMENT_BYTES) {
					return { refused: "too_large" }
				}
				const current = totals()
				if (current.erased === 1) {
					return { refused: "erased" }
				}
				const existing = held(collection, id)
				if (existing !== null && mode === "create") {
					return { refused: "exists" }
				}
				if (existing === null) {
					const inCollection = count(
						"SELECT COUNT(*) AS n FROM documents WHERE collection = ?",
						collection,
					)
					if (
						inCollection === 0 &&
						count("SELECT COUNT(DISTINCT collection) AS n FROM documents") >=
							MAX_ARTIFACT_COLLECTIONS
					) {
						return { refused: "collections" }
					}
					if (inCollection >= MAX_ARTIFACT_COLLECTION_DOCUMENTS) {
						return { refused: "documents" }
					}
				}
				const bytes = current.bytes - (existing?.size ?? 0) + size
				if (bytes > MAX_ARTIFACT_DATABASE_BYTES) {
					return { refused: "bytes" }
				}
				const document: StoredDocument = {
					id,
					seq: existing?.seq ?? current.next_seq,
					body,
					size,
					created_at: existing?.created_at ?? now,
					updated_at: now,
				}
				sql.exec(
					"INSERT INTO documents (collection, id, seq, body, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body, size = excluded.size, updated_at = excluded.updated_at",
					collection,
					id,
					document.seq,
					body,
					size,
					document.created_at,
					now,
				)
				sql.exec(
					"UPDATE totals SET bytes = ?, next_seq = ? WHERE id = 1",
					bytes,
					existing === null ? current.next_seq + 1 : current.next_seq,
				)
				return { refused: null, document, created: existing === null }
			}),

		remove: (collection: string, id: string): boolean =>
			sql.transaction(() => {
				const current = totals()
				const existing = current.erased === 1 ? null : held(collection, id)
				if (existing === null) {
					return false
				}
				sql.exec("DELETE FROM documents WHERE collection = ? AND id = ?", collection, id)
				sql.exec("UPDATE totals SET bytes = ? WHERE id = 1", current.bytes - existing.size)
				return true
			}),

		erase: (): void => {
			sql.transaction(() => {
				sql.exec("DELETE FROM documents")
				sql.exec("UPDATE totals SET bytes = 0, erased = 1 WHERE id = 1")
			})
		},

		usage: (): DatabaseUsage => {
			const collections = Array.from(
				sql.exec(
					"SELECT collection, COUNT(*) AS documents, SUM(size) AS bytes FROM documents GROUP BY collection ORDER BY collection",
				),
				(row) => Option.getOrThrow(decodeUsage(row)),
			)
			return { collections, bytes: totals().bytes }
		},
	}
}

export type ArtifactDocuments = ReturnType<typeof makeArtifactDocuments>
