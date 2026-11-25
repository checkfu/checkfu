import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ArtifactLedger } from "./ArtifactOwnership.ts"

export interface ArtifactSqlStorage {
	readonly sql: {
		readonly exec: (query: string, ...bindings: Array<string | number>) => Iterable<unknown>
	}
	readonly transactionSync: <A>(run: () => A) => A
	readonly deleteAll: () => Promise<void>
}

const CANDIDATES = "artifact_orphan_candidates"
const TABLES = ["artifact_writes", "artifact_keys", "artifact_refs", CANDIDATES]

export const ARTIFACT_LEDGER_SCHEMA = {
	artifact_writes:
		"CREATE TABLE IF NOT EXISTS artifact_writes (write_id TEXT PRIMARY KEY, staged_at INTEGER NOT NULL, status TEXT NOT NULL)",
	artifact_writes_by_status:
		"CREATE INDEX IF NOT EXISTS artifact_writes_by_status ON artifact_writes (status)",
	artifact_keys:
		"CREATE TABLE IF NOT EXISTS artifact_keys (key TEXT PRIMARY KEY, stored INTEGER NOT NULL, retained INTEGER NOT NULL DEFAULT 0)",
	artifact_refs:
		"CREATE TABLE IF NOT EXISTS artifact_refs (key TEXT NOT NULL, write_id TEXT NOT NULL, committed INTEGER NOT NULL, PRIMARY KEY (key, write_id))",
	artifact_refs_by_write:
		"CREATE INDEX IF NOT EXISTS artifact_refs_by_write ON artifact_refs (write_id)",
	[CANDIDATES]: `CREATE TABLE IF NOT EXISTS ${CANDIDATES} (key TEXT PRIMARY KEY)`,
} as const
const SCHEMA = Object.values(ARTIFACT_LEDGER_SCHEMA)
const BACKFILL_CANDIDATES = `INSERT INTO ${CANDIDATES} (key) SELECT key FROM artifact_keys WHERE retained = 0 AND NOT EXISTS (SELECT 1 FROM artifact_refs WHERE artifact_refs.key = artifact_keys.key)`

const WriteRow = Schema.Struct({
	write_id: Schema.String,
	staged_at: Schema.Finite,
	status: Schema.Literals(["staged", "committed", "abandoned"]),
})
const decodeWrites = Schema.decodeUnknownSync(Schema.Array(WriteRow))
const decodeKeys = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ key: Schema.String })))
const decodeOldest = Schema.decodeUnknownSync(
	Schema.Array(Schema.Struct({ at: Schema.NullOr(Schema.Finite) })),
)

export const makeSqlLedger = (storage: ArtifactSqlStorage): ArtifactLedger => {
	const rows = (query: string, ...bindings: ReadonlyArray<string | number>) => [
		...storage.sql.exec(query, ...bindings),
	]
	const hasTable = (name: string) =>
		rows("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0
	let ready = false
	const ensure = () => {
		if (!ready) {
			const untracked = hasTable("artifact_keys") && !hasTable(CANDIDATES)
			for (const statement of untracked ? [...SCHEMA, BACKFILL_CANDIDATES] : SCHEMA) {
				rows(statement)
			}
			ready = true
		}
	}
	const live = <A>(run: () => A, otherwise: A) => (ready ? run() : otherwise)
	if (hasTable("artifact_keys")) {
		storage.transactionSync(ensure)
	}
	return {
		transaction: (run) => {
			const was = ready
			try {
				return storage.transactionSync(run)
			} catch (error) {
				ready = was
				throw error
			}
		},
		findWrite: (writeId) =>
			live(
				() =>
					decodeWrites(
						rows(
							"SELECT write_id, staged_at, status FROM artifact_writes WHERE write_id = ?",
							writeId,
						),
					)[0],
				undefined,
			),
		saveWrite: (write) => {
			ensure()
			rows(
				"INSERT INTO artifact_writes (write_id, staged_at, status) VALUES (?, ?, ?) ON CONFLICT (write_id) DO UPDATE SET staged_at = excluded.staged_at, status = excluded.status",
				write.write_id,
				write.staged_at,
				write.status,
			)
		},
		stagedWrites: () =>
			live(
				() =>
					decodeWrites(
						rows("SELECT write_id, staged_at, status FROM artifact_writes WHERE status = 'staged'"),
					),
				[],
			),
		oldestAbandoned: () =>
			live(
				() =>
					decodeOldest(
						rows("SELECT min(staged_at) AS at FROM artifact_writes WHERE status = 'abandoned'"),
					)[0]?.at ?? undefined,
				undefined,
			),
		dropAbandoned: (stagedBefore) =>
			live(() => {
				rows(
					"DELETE FROM artifact_writes WHERE status = 'abandoned' AND staged_at <= ?",
					stagedBefore,
				)
			}, undefined),
		isStored: (key) =>
			live(
				() => rows("SELECT 1 FROM artifact_keys WHERE key = ? AND stored = 1", key).length > 0,
				false,
			),
		saveKey: (key, stored) => {
			ensure()
			rows(
				"INSERT INTO artifact_keys (key, stored) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET stored = excluded.stored",
				key,
				stored ? 1 : 0,
			)
		},
		hold: (key, writeId) => {
			ensure()
			rows(
				"INSERT OR IGNORE INTO artifact_refs (key, write_id, committed) VALUES (?, ?, 0)",
				key,
				writeId,
			)
			rows(`DELETE FROM ${CANDIDATES} WHERE key = ?`, key)
		},
		commit: (writeId) =>
			live(() => {
				rows("UPDATE artifact_refs SET committed = 1 WHERE write_id = ?", writeId)
			}, undefined),
		retain: (writeId) =>
			live(() => {
				rows(
					"UPDATE artifact_keys SET retained = 1 WHERE key IN (SELECT key FROM artifact_refs WHERE write_id = ?)",
					writeId,
				)
				rows("DELETE FROM artifact_refs WHERE write_id = ?", writeId)
				rows("DELETE FROM artifact_writes WHERE write_id = ?", writeId)
			}, undefined),
		release: (writeId) =>
			live(() => {
				rows(
					`INSERT OR IGNORE INTO ${CANDIDATES} (key) SELECT key FROM artifact_refs AS held WHERE write_id = ? AND NOT EXISTS (SELECT 1 FROM artifact_refs AS other WHERE other.key = held.key AND other.write_id <> held.write_id) AND NOT EXISTS (SELECT 1 FROM artifact_keys WHERE artifact_keys.key = held.key AND artifact_keys.retained = 1)`,
					writeId,
				)
				rows("DELETE FROM artifact_refs WHERE write_id = ?", writeId)
			}, undefined),
		hasUnreferenced: () =>
			live(() => rows(`SELECT 1 FROM ${CANDIDATES} LIMIT 1`).length > 0, false),
		unreferenced: () =>
			live(() => decodeKeys(rows(`SELECT key FROM ${CANDIDATES}`)).map((row) => row.key), []),
		dropKeys: (keys) =>
			live(() => {
				for (const key of keys) {
					rows(
						"DELETE FROM artifact_keys WHERE key = ? AND NOT EXISTS (SELECT 1 FROM artifact_refs WHERE artifact_refs.key = ?)",
						key,
						key,
					)
					rows(`DELETE FROM ${CANDIDATES} WHERE key = ?`, key)
				}
			}, undefined),
		isEmpty: () =>
			live(
				() => TABLES.every((table) => rows(`SELECT 1 FROM ${table} LIMIT 1`).length === 0),
				true,
			),
		clear: Effect.suspend(() => {
			ready = false
			return Effect.promise(() => storage.deleteAll())
		}),
	}
}
